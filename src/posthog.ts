import { randomUUID } from "node:crypto";
import type { PosthogSettings, Project } from "./settings.ts";

// Questions go to PostHog AI, which answers from the project's own PostHog data. It's read-only.
// Answers take tens of seconds, since PostHog AI runs queries before it replies.

const TIMEOUT_MS = 3 * 60 * 1000;

// One PostHog AI conversation per Slack thread and project, so follow-ups keep their context.
const conversations = new Map<string, string>();

type StreamMessage = { type?: string; content?: unknown; tool_calls?: unknown[] };

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
    if (message.type === "ai" && typeof message.content === "string" && message.content.trim() && !message.tool_calls?.length) {
      answer = message.content;
    }
  }
  return answer;
}

// PostHog AI writes Markdown; Slack uses its own mrkdwn.
export function markdownToSlack(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");
}

export async function askPosthogAI(posthog: PosthogSettings, question: string, conversationId: string): Promise<string> {
  const host = posthog.host.replace(/\/+$/, "");
  const response = await fetch(`${host}/api/projects/${posthog.projectId}/conversations/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${posthog.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: question, conversation: conversationId, trace_id: randomUUID() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 403) throw new Error(`PostHog refused the request. Check the API key's scopes (it needs "conversation" write): ${body.slice(0, 200)}`);
    throw new Error(`PostHog AI failed (${response.status}): ${body.slice(0, 200)}`);
  }
  const answer = finalAnswer(body);
  if (!answer) throw new Error("PostHog AI finished without an answer");
  return markdownToSlack(answer);
}

// Asks within the thread's ongoing PostHog AI conversation for this project, starting one if needed.
export async function askInThread(p: Project & { posthog: PosthogSettings }, threadKey: string, question: string): Promise<string> {
  const key = `${threadKey}:${p.id}`;
  const conversationId = conversations.get(key) ?? randomUUID();
  conversations.set(key, conversationId);
  return askPosthogAI(p.posthog, question, conversationId);
}
