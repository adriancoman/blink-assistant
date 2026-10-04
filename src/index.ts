import { randomUUID } from "node:crypto";
import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { type Action, describe, execute } from "./actions.ts";
import { type AgentResult, respond } from "./agent.ts";
import { config } from "./config.ts";
import { askOpenAI, fallbackAvailable } from "./fallback.ts";
import { watchRun } from "./watch.ts";

const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });

// In memory: a restart forgets conversations and unconfirmed actions, which is fine for one user.
const threads = new Map<string, string[]>();
const pending = new Map<string, { action: Action; createdAt: number }>();
// Requests Jev couldn't route, kept so the "Ask OpenAI" button can hand them over.
const unrouted = new Map<string, { messages: string[]; createdAt: number }>();
const PENDING_TTL_MS = 30 * 60 * 1000;

const WORKING = "hourglass_flowing_sand";
const FAILED = "x";

// Reactions are only a progress signal, so failing to set one never stops the request.
async function react(op: "add" | "remove", channel: string, timestamp: string, name: string) {
  try {
    await app.client.reactions[op]({ channel, timestamp, name });
  } catch (err) {
    console.warn(`Couldn't ${op} :${name}: reaction:`, err instanceof Error ? err.message : err);
  }
}

type Reply = (message: string, blocks?: object[]) => Promise<unknown>;

const buttons = (...elements: object[]) => ({ type: "actions", elements });
const button = (text: string, actionId: string, value: string, primary = false) => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: actionId,
  value,
  ...(primary ? { style: "primary" } : {}),
});

// Posts a result: the reply text (with an "Ask OpenAI" button when Jev couldn't route the request)
// and a Confirm / Cancel card per proposed action.
async function postResult(reply: Reply, result: AgentResult, messages: string[]) {
  if (result.notUnderstood && fallbackAvailable) {
    const id = randomUUID();
    unrouted.set(id, { messages: [...messages], createdAt: Date.now() });
    await reply(result.text, [
      { type: "section", text: { type: "mrkdwn", text: `${result.text}\n\nOr I can ask OpenAI to figure it out.` } },
      buttons(button("Ask OpenAI", "ask_openai", id)),
    ]);
  } else if (result.text) {
    await reply(result.text);
  }
  for (const action of result.actions) {
    const id = randomUUID();
    pending.set(id, { action, createdAt: Date.now() });
    await reply(`Confirm: ${describe(action)}`, [
      { type: "section", text: { type: "mrkdwn", text: `*Confirm:* ${describe(action)}` } },
      buttons(button("Confirm", "confirm", id, true), button("Cancel", "cancel", id)),
    ]);
  }
}

async function handle(args: { channel: string; threadTs: string; messageTs: string; user?: string; text: string }) {
  const { channel, threadTs, messageTs, user, text } = args;
  const reply: Reply = (message, blocks) =>
    app.client.chat.postMessage({ channel, thread_ts: threadTs, text: message, blocks: blocks as never });

  if (user !== config.allowedUserId) {
    await reply("Sorry, I only take requests from my owner.");
    return;
  }

  const history = threads.get(threadTs) ?? [];
  threads.set(threadTs, history);
  await react("add", channel, messageTs, WORKING);

  try {
    await postResult(reply, await respond(history, text), history.slice(-5));
    await react("remove", channel, messageTs, WORKING);
  } catch (err) {
    console.error(err);
    await react("remove", channel, messageTs, WORKING);
    await react("add", channel, messageTs, FAILED);
    await reply(`Something went wrong: \`${String(err)}\``).catch((replyErr) => console.error("Couldn't reply:", replyErr));
  }
}

const mentionPattern = /<@[A-Z0-9]+>/g;

app.event("app_mention", async ({ event }) => {
  await handle({
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    messageTs: event.ts,
    user: event.user,
    text: event.text.replace(mentionPattern, "").trim(),
  });
});

// Follow-ups in a thread the bot is already in don't need another @mention.
app.message(async ({ message, context }) => {
  if (message.subtype || !("thread_ts" in message) || !message.thread_ts || !message.text) return;
  if (!threads.has(message.thread_ts)) return;
  if (context.botUserId && message.text.includes(`<@${context.botUserId}>`)) return; // app_mention handles it
  await handle({ channel: message.channel, threadTs: message.thread_ts, messageTs: message.ts, user: message.user, text: message.text });
});

async function resolveButton(body: BlockAction, action: ButtonAction, run: boolean) {
  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts) return;
  const update = (text: string) => app.client.chat.update({ channel, ts, text, blocks: [] });

  if (body.user.id !== config.allowedUserId) return;

  const entry = pending.get(action.value ?? "");
  pending.delete(action.value ?? "");
  if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
    await update("This confirmation expired. Ask me again.");
    return;
  }

  const summary = describe(entry.action);
  if (!run) {
    await update(`~${summary}~ Cancelled.`);
    return;
  }

  await update(`⏳ ${summary}`);
  try {
    const result = await execute(entry.action);
    await update(`✅ ${result.text}`);
    if (result.watch) {
      // Reply in the same thread and mention the user, so the result shows up as a notification.
      const threadTs = (body.message as { thread_ts?: string } | undefined)?.thread_ts ?? ts;
      watchRun(result.watch, (message) =>
        app.client.chat.postMessage({ channel, thread_ts: threadTs, text: `<@${body.user.id}> ${message}` }),
      );
    }
  } catch (err) {
    console.error(err);
    await update(`❌ ${summary}\n\`${String(err)}\``);
  }
}

app.action<BlockAction<ButtonAction>>("confirm", async ({ ack, body, action }) => {
  await ack();
  await resolveButton(body, action, true);
});

app.action<BlockAction<ButtonAction>>("cancel", async ({ ack, body, action }) => {
  await ack();
  await resolveButton(body, action, false);
});

app.action<BlockAction<ButtonAction>>("ask_openai", async ({ ack, body, action }) => {
  await ack();
  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts || body.user.id !== config.allowedUserId) return;
  const threadTs = (body.message as { thread_ts?: string } | undefined)?.thread_ts ?? ts;
  const update = (text: string) => app.client.chat.update({ channel, ts, text, blocks: [] });
  const reply: Reply = (message, blocks) =>
    app.client.chat.postMessage({ channel, thread_ts: threadTs, text: message, blocks: blocks as never });

  const entry = unrouted.get(action.value ?? "");
  unrouted.delete(action.value ?? "");
  if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
    await update("This expired. Ask me again.");
    return;
  }

  await update("⏳ Asking OpenAI…");
  try {
    const result = await askOpenAI(entry.messages);
    await update("🤖 Asked OpenAI:");
    // OpenAI's reply is shown as-is; any action it proposes still needs Confirm.
    await postResult(reply, { text: result.text, actions: result.actions }, entry.messages);
  } catch (err) {
    console.error(err);
    await update(`❌ OpenAI couldn't help: \`${String(err)}\``);
  }
});

await app.start();
console.log(`Blink running for ${config.owner}/${config.repo}`);
