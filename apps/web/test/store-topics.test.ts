import { describe, expect, test } from "bun:test";
import { createStreamsStore, liveTopics } from "@/realtime/context";

const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
type Ev = Parameters<ReturnType<typeof createStreamsStore>["apply"]>[0];

/** A running run with a guessed receipt, ready to stream: the channel's busy hour in miniature. */
function busyStore() {
  const store = createStreamsStore();
  store.expect("c1", "m1", ["ada"]);
  store.apply({ type: "agent.run", ...base, status: "running" } as Ev);
  return store;
}

function counters(store: ReturnType<typeof createStreamsStore>) {
  const calls: Record<string, number> = {};
  const count = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const offs = [
    store.subscribe(count("general")),
    store.subscribe(count("run"), [liveTopics.run("r1")]),
    store.subscribe(count("channel"), [liveTopics.channelRuns("c1")]),
    store.subscribe(count("agent"), [liveTopics.agentRuns("ada")]),
    store.subscribe(count("runs"), [liveTopics.runs]),
    store.subscribe(count("receipt"), [liveTopics.receipt("m1")]),
    store.subscribe(count("receipts"), [liveTopics.receipts]),
    store.subscribe(count("typing"), [liveTopics.typingIn("c1")]),
  ];
  return {
    calls,
    stop: () => {
      for (const off of offs) off();
    },
  };
}

describe("topic-keyed subscriptions", () => {
  test("an agent.tool.output chunk wakes only its run and channel, never receipts or typing", () => {
    const store = busyStore();
    const { calls, stop } = counters(store);
    store.apply({
      type: "agent.tool.output",
      ...base,
      toolUseId: "t1",
      stream: "stdout",
      text: "hello",
    } as unknown as Ev);
    stop();
    // The row shows the chunk; the channel's lists re-check (same keys, no re-render).
    expect(calls.run).toBe(1);
    expect(calls.channel).toBe(1);
    // The fan-out win: ~300 receipts rows and the typing line sleep through the streaming firehose.
    expect(calls.receipt ?? 0).toBe(0);
    expect(calls.receipts ?? 0).toBe(0);
    expect(calls.typing ?? 0).toBe(0);
    // A content-only append is not a status change: aggregates don't wake.
    expect(calls.agent ?? 0).toBe(0);
    expect(calls.runs ?? 0).toBe(0);
    // The fallback is identical to before: a general subscriber still hears everything.
    expect(calls.general).toBe(1);
  });

  test("a receipts event wakes only receipts subscribers, never the run's row", () => {
    const store = busyStore();
    const { calls, stop } = counters(store);
    store.apply({
      type: "message.claimed",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      runId: "r1",
    } as unknown as Ev);
    stop();
    expect(calls.receipt).toBe(1);
    expect(calls.receipts).toBe(1);
    expect(calls.general).toBe(1);
    expect(calls.run ?? 0).toBe(0);
    expect(calls.channel ?? 0).toBe(0);
    expect(calls.typing ?? 0).toBe(0);
  });

  test("a typing frame wakes only typing subscribers", () => {
    const store = busyStore();
    const { calls, stop } = counters(store);
    store.apply({ type: "user.typing", channelId: "c1", userId: "u1", threadId: null } as Ev);
    stop();
    expect(calls.typing).toBe(1);
    expect(calls.general).toBe(1);
    expect(calls.run ?? 0).toBe(0);
    expect(calls.receipt ?? 0).toBe(0);
  });

  test("a status change still wakes the run, its channel, its agent and the aggregates", () => {
    const store = busyStore();
    const { calls, stop } = counters(store);
    store.apply({ type: "agent.typing", ...base } as unknown as Ev);
    stop();
    expect(calls.run).toBe(1);
    expect(calls.channel).toBe(1);
    expect(calls.agent).toBe(1);
    expect(calls.runs).toBe(1);
    expect(calls.general).toBe(1);
    // Its receipt moves to "answering" too: the row's own subscriber hears it, nobody else's does.
    expect(calls.receipt).toBe(1);
    expect(calls.receipts).toBe(1);
    expect(calls.typing ?? 0).toBe(0);
  });

  test("a notice wakes only its channel's subscribers", () => {
    const store = busyStore();
    const seen: string[] = [];
    const offOther = store.subscribe(() => seen.push("other"), [liveTopics.noticesIn("c2")]);
    const offChannel = store.subscribe(() => seen.push("channel"), [liveTopics.noticesIn("c1")]);
    store.apply({
      type: "channel.permissions",
      channelId: "c1",
      permissions: {},
    } as unknown as Ev);
    // channel.permissions doesn't touch the live store: nothing fires, and the state is unchanged.
    expect(seen).toEqual([]);
    store.unavailable({
      type: "agent.unavailable",
      channelId: "c1",
      threadId: "m1",
      messageId: "m1",
      agentId: "ada",
    } as never);
    offOther();
    offChannel();
    expect(seen).toEqual(["channel"]);
  });
});
