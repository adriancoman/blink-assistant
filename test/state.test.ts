import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DAY_MS, type Data, empty, type Retention, Store, sweep } from "../src/state.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const retention: Retention = { threadMs: 7 * DAY_MS, confirmMs: 30 * MINUTE, watchMs: 4 * HOUR };

const tempFile = () => join(mkdtempSync(join(tmpdir(), "blink-state-")), "state.json");

const request = { channel: "C1", threadTs: "1.0", messageTs: "1.0", user: "U1", text: "hi" };
const run = { id: "r1", url: "https://expo.dev/run" };

// A full set of entries, each created at `at`.
function filled(at: number): Data {
  const data = empty();
  data.threads["C1:1.0"] = { projectId: "app", messages: ["hi"], lastSeenAt: at };
  data.conversations["C1:1.0:app"] = { id: "conv", lastSeenAt: at };
  data.pending["p1"] = { projectId: "app", action: { kind: "release_android" }, createdAt: at };
  data.unrouted["u1"] = { projectId: "app", messages: ["hi"], threadTs: "1.0", createdAt: at };
  data.unassigned["a1"] = { request, createdAt: at };
  data.watches["r1"] = { projectId: "app", run, channel: "C1", threadTs: "1.0", userId: "U1", startedAt: at };
  return data;
}

describe("sweep", () => {
  it("keeps everything that's within its retention", () => {
    const now = 100 * DAY_MS;
    const data = filled(now - 20 * MINUTE);
    const removed = sweep(data, retention, now);
    assert.deepEqual(Object.values(removed), [0, 0, 0, 0, 0, 0]);
    assert.equal(Object.keys(data.threads).length, 1);
    assert.equal(Object.keys(data.pending).length, 1);
  });

  it("drops confirmations and project picks after 30 minutes, keeps threads and watches", () => {
    const now = 100 * DAY_MS;
    const data = filled(now - HOUR);
    const removed = sweep(data, retention, now);
    assert.deepEqual(removed, { threads: 0, conversations: 0, pending: 1, unrouted: 1, unassigned: 1, watches: 0 });
    assert.deepEqual(data.pending, {});
    assert.ok(data.threads["C1:1.0"]);
    assert.ok(data.watches["r1"]);
  });

  it("drops watches after 4 hours and threads with their conversations after 7 days", () => {
    const now = 100 * DAY_MS;
    const data = filled(now - 5 * HOUR);
    assert.equal(sweep(data, retention, now).watches, 1);
    assert.ok(data.threads["C1:1.0"]);

    const old = filled(now - 8 * DAY_MS);
    const removed = sweep(old, retention, now);
    assert.equal(removed.threads, 1);
    assert.equal(removed.conversations, 1);
    assert.deepEqual(old.threads, {});
    assert.deepEqual(old.conversations, {});
  });

  it("measures threads by their last activity, not their start", () => {
    const now = 100 * DAY_MS;
    const data = filled(now - 8 * DAY_MS);
    data.threads["C1:1.0"].lastSeenAt = now - DAY_MS;
    assert.equal(sweep(data, retention, now).threads, 0);
  });
});

describe("Store", () => {
  it("starts empty without a file and writes one on the first change", () => {
    const path = tempFile();
    const store = new Store(path);
    assert.deepEqual(store.data, empty());
    assert.ok(!existsSync(path));

    store.update((d) => {
      d.pending["p1"] = { projectId: "app", action: { kind: "release_android" }, createdAt: 1 };
    });
    assert.ok(existsSync(path));
    assert.ok(!existsSync(`${path}.tmp`));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pending.p1.action, { kind: "release_android" });
  });

  it("reads back what another instance wrote", () => {
    const path = tempFile();
    new Store(path).update((d) => {
      d.threads["C1:1.0"] = { projectId: "app", messages: ["merge main into release"], lastSeenAt: 5 };
      d.watches["r1"] = { projectId: "app", run, channel: "C1", threadTs: "1.0", userId: "U1", startedAt: 5 };
    });
    const again = new Store(path);
    assert.deepEqual(again.data.threads["C1:1.0"].messages, ["merge main into release"]);
    assert.deepEqual(again.data.watches["r1"].run, run);
    assert.deepEqual(again.data.pending, {});
  });

  it("returns what the change returns", () => {
    const store = new Store(tempFile());
    const value = store.update((d) => (d.threads["k"] = { projectId: null, messages: [], lastSeenAt: 1 }));
    assert.equal(value.lastSeenAt, 1);
  });

  it("sweeps in place and saves", () => {
    const path = tempFile();
    const now = 100 * DAY_MS;
    writeFileSync(path, JSON.stringify(filled(now - HOUR)));
    const store = new Store(path);
    assert.equal(store.sweep(retention, now).pending, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pending, {});
  });

  it("moves an unreadable file aside and starts fresh", () => {
    const path = tempFile();
    writeFileSync(path, "{ not json");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const store = new Store(path);
      assert.deepEqual(store.data, empty());
    } finally {
      console.warn = warn;
    }
    assert.ok(!existsSync(path));
    assert.ok(readdirSync(join(path, "..")).some((name) => name.startsWith("state.json.corrupt-")));
  });

  it("ignores unexpected shapes in the file", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ threads: [1, 2], pending: "no", extra: true }));
    assert.deepEqual(new Store(path).data, empty());
  });
});
