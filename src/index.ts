import { randomUUID } from "node:crypto";
import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { type Action, describe, execute } from "./actions.ts";
import { type AgentResult, classifyIntent, type Explain, respond } from "./agent.ts";
import { config } from "./config.ts";
import { askOpenAI, fallbackAvailable } from "./fallback.ts";
import { namedInThread, pickByCapability, resolveProject } from "./projects.ts";
import * as replies from "./replies.ts";
import { hasExpo, needsConfirm, type Project } from "./settings.ts";
import { watchRun } from "./watch.ts";

const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });

// In memory: a restart forgets conversations and unconfirmed actions, which is fine for one user.
// `run` is the workflow run last started from the thread, so "why did it fail?" explains that one.
type Thread = { projectId: string | null; messages: string[]; run?: { projectId: string; id: string } };
const threads = new Map<string, Thread>();
const pending = new Map<string, { projectId: string; action: Action; createdAt: number }>();
// Requests Jev couldn't route (or failures to explain), kept so the OpenAI button can hand them over.
const unrouted = new Map<string, { projectId: string; messages: string[]; explain?: Explain; threadTs: string; createdAt: number }>();
// Messages waiting for the user to pick a project.
const unassigned = new Map<string, { request: Request; createdAt: number }>();
const PENDING_TTL_MS = 30 * 60 * 1000;

const WORKING = "hourglass_flowing_sand";
const FAILED = "x";

const projectById = (id: string) => config.projects.find((p) => p.id === id);
// With several projects, every reply says which one it's about.
const label = (p: Project) => (config.projects.length > 1 ? `[${p.name}] ` : "");

// Reactions are only a progress signal, so failing to set one never stops the request.
async function react(op: "add" | "remove", channel: string, timestamp: string, name: string) {
  try {
    await app.client.reactions[op]({ channel, timestamp, name });
  } catch (err) {
    console.warn(`Couldn't ${op} :${name}: reaction:`, err instanceof Error ? err.message : err);
  }
}

// Channel names need the channels:read / groups:read scopes. Without them, channels can still be
// mapped by ID, and resolution falls through to the next step.
const channelNames = new Map<string, string | null>();
async function channelName(channel: string): Promise<string | null> {
  if (channelNames.has(channel)) return channelNames.get(channel)!;
  let name: string | null = null;
  try {
    name = (await app.client.conversations.info({ channel })).channel?.name ?? null;
  } catch (err) {
    console.warn(`Couldn't look up the name of channel ${channel}:`, err instanceof Error ? err.message : err);
  }
  channelNames.set(channel, name);
  return name;
}

// Earlier messages in a thread the bot hasn't seen yet: it was mentioned partway through, or restarted.
async function earlierInSlackThread(channel: string, threadTs: string, messageTs: string): Promise<string[]> {
  try {
    const { messages = [] } = await app.client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return messages.filter((m) => m.ts !== messageTs && m.text).map((m) => m.text!);
  } catch (err) {
    console.warn(`Couldn't read thread ${threadTs}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

type Reply = (message: string, blocks?: object[]) => Promise<unknown>;

// Links in replies (like Expo workflow runs) stay plain links, without Slack's preview cards.
const noPreviews = { unfurl_links: false, unfurl_media: false };

const buttons = (...elements: object[]) => ({ type: "actions", elements });
const button = (text: string, actionId: string, value: string, primary = false) => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: actionId,
  value,
  ...(primary ? { style: "primary" } : {}),
});

// Where an action runs from: its thread, and who asked (mentioned when a watched run finishes).
type Origin = { channel: string; threadTs: string; userId: string };

// Runs an action, showing progress in one message: ⏳, then ✅ or ❌. `show` replaces that message.
async function runAction(p: Project, action: Action, origin: Origin, show: (text: string) => Promise<unknown>) {
  const summary = `${label(p)}${describe(p, action)}`;
  await show(`⏳ ${summary}`);
  try {
    const result = await execute(p, action);
    await show(`✅ ${label(p)}${result.text}`);
    if (result.watch && hasExpo(p)) {
      const thread = threads.get(origin.threadTs) ?? { projectId: p.id, messages: [] };
      thread.run = { projectId: p.id, id: result.watch.id };
      threads.set(origin.threadTs, thread);
      // Reply in the same thread and mention the user, so the result shows up as a notification.
      watchRun(p, result.watch, (message) =>
        app.client.chat.postMessage({
          channel: origin.channel,
          thread_ts: origin.threadTs,
          text: `<@${origin.userId}> ${label(p)}${message}`,
          ...noPreviews,
        }),
      );
    }
  } catch (err) {
    console.error(err);
    await show(`❌ ${summary}\n\`${String(err)}\``);
  }
}

// Posts a ⏳ message and runs the action in it, for actions the autonomy setting lets run unconfirmed.
async function runNow(p: Project, action: Action, origin: Origin) {
  const { channel, threadTs } = origin;
  let ts: string | undefined;
  await runAction(p, action, origin, async (text) => {
    if (ts) return app.client.chat.update({ channel, ts, text });
    ts = (await app.client.chat.postMessage({ channel, thread_ts: threadTs, text, ...noPreviews })).ts;
  });
}

// Posts a result: the reply text (with an OpenAI button when Jev couldn't route the request, or to
// explain a failed run), then each proposed action: run right away if the autonomy setting allows,
// else a Confirm / Cancel card. `confirmAll` asks for every action regardless of the setting.
async function postResult(reply: Reply, p: Project, result: AgentResult, messages: string[], origin: Origin, confirmAll = false) {
  const text = result.text ? `${label(p)}${result.text}` : "";
  const offer = !fallbackAvailable
    ? null
    : result.notUnderstood
      ? { note: "\n\nOr I can ask OpenAI to figure it out.", button: "Ask OpenAI" }
      : result.explain
        ? { note: "", button: "Explain with OpenAI" }
        : null;
  if (offer) {
    const id = randomUUID();
    unrouted.set(id, { projectId: p.id, messages: [...messages], explain: result.explain, threadTs: origin.threadTs, createdAt: Date.now() });
    await reply(text, [
      { type: "section", text: { type: "mrkdwn", text: `${text}${offer.note}` } },
      buttons(button(offer.button, "ask_openai", id)),
    ]);
  } else if (text) {
    await reply(text);
  }
  for (const action of result.actions) {
    if (!confirmAll && !needsConfirm(config.autonomy, action.kind)) {
      await runNow(p, action, origin);
      continue;
    }
    const id = randomUUID();
    pending.set(id, { projectId: p.id, action, createdAt: Date.now() });
    const summary = `${label(p)}${describe(p, action)}`;
    await reply(`Confirm: ${summary}`, [
      { type: "section", text: { type: "mrkdwn", text: `*Confirm:* ${summary}` } },
      buttons(button("Confirm", "confirm", id, true), button("Cancel", "cancel", id)),
    ]);
  }
}

// The run started from the thread, if it was for this project.
const threadRun = (thread: Thread, p: Project) => (thread.run?.projectId === p.id ? thread.run.id : null);

type Request = { channel: string; threadTs: string; messageTs: string; user?: string; text: string };

const replyIn = (channel: string, threadTs: string): Reply => (message, blocks) =>
  app.client.chat.postMessage({ channel, thread_ts: threadTs, text: message, blocks: blocks as never, ...noPreviews });

// Runs a request once its project is known.
async function handleFor(p: Project, request: Request, thread: Thread) {
  const { channel, threadTs, messageTs, user, text } = request;
  const reply = replyIn(channel, threadTs);
  thread.projectId = p.id;
  try {
    const progress = (note: string) => reply(`${label(p)}${note}`);
    const threadRunId = threadRun(thread, p);
    const result = await respond(p, thread.messages, text, { threadKey: `${channel}:${threadTs}`, threadRunId, progress });
    await postResult(reply, p, result, thread.messages.slice(-5), { channel, threadTs, userId: user ?? "" });
    await react("remove", channel, messageTs, WORKING);
  } catch (err) {
    console.error(err);
    await react("remove", channel, messageTs, WORKING);
    await react("add", channel, messageTs, FAILED);
    await reply(`${label(p)}Something went wrong: \`${String(err)}\``).catch((replyErr) => console.error("Couldn't reply:", replyErr));
  }
}

async function handle(request: Request) {
  const { channel, threadTs, messageTs, user, text } = request;
  const reply = replyIn(channel, threadTs);

  if (!user || !config.allowedUserIds.includes(user)) {
    await reply("Sorry, I only take requests from my owner.");
    return;
  }

  const known = threads.get(threadTs);
  const thread = known ?? { projectId: null, messages: [] };
  threads.set(threadTs, thread);
  await react("add", channel, messageTs, WORKING);

  try {
    // A project named earlier in the thread counts as the thread's project.
    if (!thread.projectId) {
      const earlier = known ? thread.messages : threadTs !== messageTs ? await earlierInSlackThread(channel, threadTs, messageTs) : [];
      thread.projectId = namedInThread(config.projects, earlier)?.id ?? null;
    }
    thread.messages.push(text);
    const resolution = resolveProject({
      projects: config.projects,
      channelId: channel,
      channelName: await channelName(channel),
      text,
      threadProjectId: thread.projectId,
    });
    if ("project" in resolution) {
      await handleFor(resolution.project, request, thread);
      return;
    }

    // Nothing named the project: use the thread's project if it can do this, otherwise the only
    // project that can (e.g. TestFlight goes to the only project with Expo).
    const intent = await classifyIntent(thread.messages, text).catch((err) => {
      console.warn("Couldn't classify the request to pick a project:", err instanceof Error ? err.message : err);
      return null;
    });
    if (intent === "help") {
      await reply(replies.helpAll(resolution.ask));
      await react("remove", channel, messageTs, WORKING);
      return;
    }
    const picked = pickByCapability(resolution.ask, intent, thread.projectId);
    if (picked) {
      await handleFor(picked, request, thread);
      return;
    }

    const id = randomUUID();
    unassigned.set(id, { request, createdAt: Date.now() });
    await reply(replies.askProject(), [
      { type: "section", text: { type: "mrkdwn", text: replies.askProject() } },
      // Slack requires a unique action_id per button in a block.
      buttons(...resolution.ask.map((p) => button(p.name, `pick_project:${p.id}`, `${id}:${p.id}`))),
    ]);
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

// Shared checks for buttons: allowed users only, and the card's channel, ts and thread.
function buttonContext(body: BlockAction) {
  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts || !config.allowedUserIds.includes(body.user.id)) return null;
  const threadTs = (body.message as { thread_ts?: string } | undefined)?.thread_ts ?? ts;
  const update = (text: string) => app.client.chat.update({ channel, ts, text, blocks: [] });
  return { channel, ts, threadTs, update };
}

const expired = (createdAt: number) => Date.now() - createdAt > PENDING_TTL_MS;

app.action<BlockAction<ButtonAction>>(/^pick_project:/, async ({ ack, body, action }) => {
  await ack();
  const ctx = buttonContext(body);
  if (!ctx) return;
  const [id, projectId] = (action.value ?? "").split(":");
  const entry = unassigned.get(id);
  unassigned.delete(id);
  const p = projectById(projectId);
  if (!entry || expired(entry.createdAt) || !p) {
    await ctx.update("This expired. Ask me again.");
    return;
  }
  await ctx.update(`Project: *${p.name}*`);
  const thread = threads.get(entry.request.threadTs) ?? { projectId: null, messages: [entry.request.text] };
  threads.set(entry.request.threadTs, thread);
  await react("add", entry.request.channel, entry.request.messageTs, WORKING);
  await handleFor(p, entry.request, thread);
});

async function resolveButton(body: BlockAction, action: ButtonAction, run: boolean) {
  const ctx = buttonContext(body);
  if (!ctx) return;
  const entry = pending.get(action.value ?? "");
  pending.delete(action.value ?? "");
  const p = entry && projectById(entry.projectId);
  if (!entry || expired(entry.createdAt) || !p) {
    await ctx.update("This confirmation expired. Ask me again.");
    return;
  }

  const summary = `${label(p)}${describe(p, entry.action)}`;
  if (!run) {
    await ctx.update(`~${summary}~ Cancelled.`);
    return;
  }

  await runAction(p, entry.action, { channel: ctx.channel, threadTs: ctx.threadTs, userId: body.user.id }, ctx.update);
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
  const ctx = buttonContext(body);
  if (!ctx) return;
  const entry = unrouted.get(action.value ?? "");
  unrouted.delete(action.value ?? "");
  const p = entry && projectById(entry.projectId);
  if (!entry || expired(entry.createdAt) || !p) {
    await ctx.update("This expired. Ask me again.");
    return;
  }

  // An explanation keeps the logs it explains; a reply to an unrouted request is replaced.
  const kept = entry.explain ? `${body.message?.text ?? ""}\n\n` : "";
  await ctx.update(`${kept}⏳ Asking OpenAI…`);
  try {
    const thread = threads.get(entry.threadTs);
    const result = await askOpenAI(p, entry.messages, { explain: entry.explain, threadRunId: thread ? threadRun(thread, p) : null });
    await ctx.update(`${kept}🤖 Asked OpenAI:`);
    // OpenAI's reply is shown as-is; any action it proposes still needs Confirm.
    const origin = { channel: ctx.channel, threadTs: ctx.threadTs, userId: body.user.id };
    await postResult(replyIn(ctx.channel, ctx.threadTs), p, { text: result.text, actions: result.actions }, entry.messages, origin, true);
  } catch (err) {
    console.error(err);
    await ctx.update(`${kept}❌ OpenAI couldn't help: \`${String(err)}\``);
  }
});

await app.start();
console.log(`Blink running for ${config.projects.length} project(s): ${config.projects.map((p) => p.name).join(", ")}`);
