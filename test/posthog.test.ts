import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { finalAnswer, markdownToSlack } from "../src/posthog.ts";

// A trimmed recording of a real PostHog AI response: the question, a tool call, the tool result,
// a partial snapshot of the answer, and the final answer.
const stream = readFileSync(new URL("./fixtures/posthog-ai-stream.txt", import.meta.url), "utf8");

describe("finalAnswer", () => {
  it("returns the last complete AI message from a real stream", () => {
    const answer = finalAnswer(stream);
    assert.ok(answer?.startsWith("**76 unique users**"), answer ?? "no answer");
  });

  it("ignores AI messages that are calling tools, and non-AI messages", () => {
    const events = [
      { type: "human", content: "How many users?" },
      { type: "ai", content: "Let me check.", tool_calls: [{ name: "query" }] },
      { type: "tool", content: "result" },
    ];
    const s = events.map((d) => `event: message\ndata: ${JSON.stringify(d)}`).join("\n\n");
    assert.equal(finalAnswer(s), null);
  });

  it("skips malformed events", () => {
    assert.equal(finalAnswer("event: message\ndata: {not json\n\nevent: message\ndata: " + JSON.stringify({ type: "ai", content: "ok" })), "ok");
  });
});

describe("markdownToSlack", () => {
  it("converts bold, headings and links", () => {
    assert.equal(markdownToSlack("**76 users** visited"), "*76 users* visited");
    assert.equal(markdownToSlack("## Summary"), "*Summary*");
    assert.equal(markdownToSlack("see [the insight](https://eu.posthog.com/x)"), "see <https://eu.posthog.com/x|the insight>");
  });

  it("leaves code and plain text alone", () => {
    assert.equal(markdownToSlack("the `$pageview` event"), "the `$pageview` event");
  });
});
