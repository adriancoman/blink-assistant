import { randomUUID } from "node:crypto";
import type { PosthogSettings, Project } from "./settings.ts";

// Questions go to PostHog AI, which answers from the project's own PostHog data. It's read-only.
// Answers take tens of seconds, since PostHog AI runs queries before it replies.

const TIMEOUT_MS = 3 * 60 * 1000;
// After a dropped connection, how often to check whether PostHog AI has finished the answer anyway.
const POLL_MS = 5000;

// One PostHog AI conversation per Slack thread and project, so follow-ups keep their context.
const conversations = new Map<string, string>();

type StreamMessage = { type?: string; content?: unknown; tool_calls?: unknown[] };

const isAnswer = (m: StreamMessage) => m.type === "ai" && typeof m.content === "string" && m.content.trim() !== "" && !m.tool_calls?.length;

// The response is server-sent events. AI messages stream in as growing snapshots; the answer is the
// last one that isn't asking to run a tool.
export function finalAnswer(stream: string): string | null {
  let answer: string | null = null;
  for (const block of stream.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let message: StreamMessage;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (isAnswer(message)) answer = message.content as string;
  }
  return answer;
}

// From a saved conversation: whether the question reached PostHog AI (it's the latest human
// message), and the answer to it, if there is one yet.
export function answerInConversation(messages: StreamMessage[], question: string): { asked: boolean; answer: string | null } {
  const lastHuman = messages.findLastIndex((m) => m.type === "human");
  if (lastHuman === -1 || String(messages[lastHuman].content).trim() !== question.trim()) return { asked: false, answer: null };
  const answer = messages.slice(lastHuman + 1).findLast(isAnswer);
  return { asked: true, answer: answer ? (answer.content as string) : null };
}

// PostHog AI writes Markdown; Slack uses its own mrkdwn.
export function markdownToSlack(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isTimeout = (err: unknown) => err instanceof Error && err.name === "TimeoutError";

// PostHog answered with an error, as opposed to the connection dropping.
class HttpError extends Error {}

// Sends the question and reads the streamed answer. Throws on a dropped connection, so the caller can recover.
async function stream(posthog: PosthogSettings, question: string, conversationId: string, deadline: number): Promise<string | null> {
  const host = posthog.host.replace(/\/+$/, "");
  const response = await fetch(`${host}/api/projects/${posthog.projectId}/conversations/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${posthog.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: question, conversation: conversationId, trace_id: randomUUID() }),
    signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
  });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 403) throw new HttpError(`PostHog refused the request. Check the API key's scopes (it needs "conversation" write): ${body.slice(0, 200)}`);
    throw new HttpError(`PostHog AI failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return finalAnswer(body);
}

// PostHog AI keeps working when the stream drops (it can take a minute), so wait for the saved
// conversation to go idle and read the answer from it.
async function recover(posthog: PosthogSettings, question: string, conversationId: string, deadline: number) {
  const host = posthog.host.replace(/\/+$/, "");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${host}/api/projects/${posthog.projectId}/conversations/${conversationId}/`, {
        headers: { Authorization: `Bearer ${posthog.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      // 404: the question never reached PostHog, so there's no conversation yet.
      if (response.status === 404) return { asked: false, answer: null };
      if (response.ok) {
        const conversation = (await response.json()) as { status?: string; messages?: StreamMessage[] };
        const found = answerInConversation(conversation.messages ?? [], question);
        if (found.answer || conversation.status === "idle") return found;
      }
    } catch (err) {
      console.warn("Couldn't check the PostHog AI conversation:", err instanceof Error ? err.message : err);
    }
    await delay(POLL_MS);
  }
  return { asked: true, answer: null };
}

export async function askPosthogAI(posthog: PosthogSettings, question: string, conversationId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  // A dropped connection is recovered from the saved conversation; if PostHog never got the
  // question, it's asked once more.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let answer: string | null;
    try {
      answer = await stream(posthog, question, conversationId, deadline);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isTimeout(err)) break;
      console.warn("PostHog AI's connection dropped, checking the conversation:", err instanceof Error ? err.message : err);
      const found = await recover(posthog, question, conversationId, deadline);
      if (found.answer) return markdownToSlack(found.answer);
      if (found.asked) break;
      continue;
    }
    if (!answer) throw new Error("PostHog AI finished without an answer. Try asking again.");
    return markdownToSlack(answer);
  }
  throw new Error("PostHog AI didn't answer within 3 minutes (the connection dropped or it took too long). Try asking again.");
}

// Asks within the thread's ongoing PostHog AI conversation for this project, starting one if needed.
export async function askInThread(p: Project & { posthog: PosthogSettings }, threadKey: string, question: string): Promise<string> {
  const key = `${threadKey}:${p.id}`;
  const conversationId = conversations.get(key) ?? randomUUID();
  conversations.set(key, conversationId);
  return askPosthogAI(p.posthog, question, conversationId);
}
