/**
 * Opt-in database benchmarks for the chat scrollback path.
 *
 *   SCROLL_BENCH=1 bun test apps/server/test/scroll-benchmark.test.ts
 *   SCROLL_BENCH=1 SCROLL_BENCH_PROBES=thread,memory bun test apps/server/test/scroll-benchmark.test.ts
 *
 * The default run seeds the same mixed conversation as the scrollback validation and measures the first 100
 * top-level messages and the next 50 older ones. `thread-heavy` adds replies before measuring the first page again;
 * `memory-heavy` adds 30k context items before measuring `memoriesFor` for that first page.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { countQueries, eq, schema } from "@agenteschat/db";
import { memoriesFor } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, type TestServer } from "./harness";
import { type Seeded, seedHistory } from "./scroll-validation-seed";

const ENABLED = process.env.SCROLL_BENCH === "1";
const PROBES = new Set(
  (process.env.SCROLL_BENCH_PROBES ?? "")
    .split(",")
    .map((probe) => probe.trim())
    .filter(Boolean),
);
const THREAD_HEAVY = PROBES.has("all") || PROBES.has("thread") || PROBES.has("thread-heavy");
const MEMORY_HEAVY = PROBES.has("all") || PROBES.has("memory") || PROBES.has("memory-heavy");

const INITIAL_PAGE = 100;
const OLDER_PAGE = 50;
const SAMPLES = 15;
const THREAD_REPLIES = 5_000;
const CONTEXT_ITEMS = 30_000;

type PageMessage = {
  id: string;
  createdAt: string;
  channelId: string;
  author: { type: "person" | "agent"; id: string | null };
};

let t: TestServer;
let owner: Browser;
let orgId: string;
let channelId: string;
let userId: string;
let adaId: string;
let atlasId: string;
let seeded: Seeded[];

const median = (sorted: readonly number[]) => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const p95 = (sorted: readonly number[]) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number;

/** Runs a probe `SAMPLES` times after warm-ups, reporting median/p95 milliseconds and SQL statements. */
async function bench(label: string, read: () => Promise<number>): Promise<number> {
  for (let i = 0; i < 3; i++) await read();
  const times: number[] = [];
  const queries = new Set<number>();
  let rows = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    const measured = await countQueries(read);
    times.push(performance.now() - started);
    queries.add(measured.queries);
    rows = measured.result;
  }
  times.sort((a, b) => a - b);
  const statementCounts = [...queries].sort((a, b) => a - b);
  const sql =
    statementCounts.length === 1
      ? `${statementCounts[0]}`
      : `${statementCounts[0]}-${statementCounts[statementCounts.length - 1]}`;
  console.log(
    `SCROLL_BENCH ${label} median=${median(times).toFixed(2)}ms p95=${p95(times).toFixed(2)}ms sql=${sql} rows=${rows}`,
  );
  return rows;
}

async function page(path: string): Promise<PageMessage[]> {
  const response = await owner(path);
  if (response.status !== 200) throw new Error(`page failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { messages: PageMessage[] }).messages;
}

async function seedThreadReplies(root: Seeded) {
  const replies: (typeof schema.messages.$inferInsert)[] = [];
  for (let i = 0; i < THREAD_REPLIES; i++) {
    replies.push({
      id: crypto.randomUUID(),
      createdAt: new Date(root.createdAt.getTime() + 1_000 + i * 1_000),
      orgId,
      channelId,
      threadId: root.id,
      authorType: "agent",
      authorAgentId: atlasId,
      body: `Checklist item ${i} done.`,
      mentionedAgentIds: [],
      mentionedUserIds: [],
      hop: 1,
      meta: {},
    });
  }
  for (let i = 0; i < replies.length; i += 1_000) {
    await t.db.insert(schema.messages).values(replies.slice(i, i + 1_000));
  }
}

async function seedContextItems() {
  const kinds = ["fact", "preference", "decision", "note", "lesson"] as const;
  const items: (typeof schema.contextItems.$inferInsert)[] = [];
  for (let i = 0; i < CONTEXT_ITEMS; i++) {
    const source = seeded[i % seeded.length] as Seeded;
    items.push({
      orgId,
      kind: kinds[i % kinds.length] as (typeof kinds)[number],
      scopeType: "message",
      scopeId: source.id,
      agentId: adaId,
      subjectKey: `scroll-bench-${i}`,
      title: "Scroll benchmark memory",
      content: `Memory ${i} saved from a message.`,
      sourceIds: [source.id],
      channelIds: [channelId],
      createdByKind: "person",
    });
  }
  for (let i = 0; i < items.length; i += 1_000) {
    await t.db.insert(schema.contextItems).values(items.slice(i, i + 1_000));
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  owner = browser(t);
  const signedUp = await owner("/api/auth/sign-up/email", {
    json: { email: "scroll-bench@example.com", password: "correct horse battery", name: "Marina" },
  });
  expect(signedUp.status).toBeLessThan(300);

  const made = (await (await owner("/api/app/organizations", { json: { name: "Scroll Bench" } })).json()) as {
    organization: { id: string };
  };
  orgId = made.organization.id;

  const [user] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "scroll-bench@example.com"));
  if (!user) throw new Error("the owner was not written");
  userId = user.id;

  const [channel] = await t.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.orgId, orgId));
  if (!channel) throw new Error("the workspace has no channel");
  channelId = channel.id;

  const agents = await t.db
    .insert(schema.agents)
    .values([
      {
        orgId,
        name: "Ada",
        handle: "ada",
        role: "Engineer",
        instructions: "You keep the rollout stable.",
        model: "claude-sonnet-5-5",
        ownerUserId: userId,
      },
      {
        orgId,
        name: "Atlas",
        handle: "atlas",
        role: "Operations",
        instructions: "You watch the deployment queue.",
        model: "claude-sonnet-5-5",
        ownerUserId: userId,
      },
    ])
    .returning({ id: schema.agents.id, handle: schema.agents.handle });
  adaId = agents.find((agent) => agent.handle === "ada")?.id ?? "";
  atlasId = agents.find((agent) => agent.handle === "atlas")?.id ?? "";
  if (!adaId || !atlasId) throw new Error("seed agents were not written");

  await t.db
    .insert(schema.channelMembers)
    .values([
      { orgId, channelId, userId },
      { orgId, channelId, agentId: adaId },
      { orgId, channelId, agentId: atlasId },
    ])
    .onConflictDoNothing();

  const result = await seedHistory(t.db, { orgId, channelId, userId, adaId, atlasId }, t.platformBlobs);
  seeded = result.seeded;
});

afterAll(async () => {
  if (ENABLED) await t?.close();
});

test.skipIf(!ENABLED)(
  "scrollback page probes report median, p95 and SQL statements",
  async () => {
    const base = `/api/app/organizations/${orgId}/channels/${channelId}/messages`;
    let initial: PageMessage[] = [];
    expect(
      await bench("initial-100", async () => {
        initial = await page(`${base}?limit=${INITIAL_PAGE}`);
        return initial.length;
      }),
    ).toBe(INITIAL_PAGE);

    const before = encodeURIComponent(initial[0]?.createdAt ?? "");
    expect(
      await bench("older-50", async () => {
        const older = await page(`${base}?before=${before}&limit=${OLDER_PAGE}`);
        return older.length;
      }),
    ).toBe(OLDER_PAGE);

    if (THREAD_HEAVY) {
      const root = seeded.find((message) => message.kind === "thread");
      if (!root) throw new Error("the seed has no thread root");
      await seedThreadReplies(root);
      expect(
        await bench("thread-heavy-initial-100", async () => {
          const first = await page(`${base}?limit=${INITIAL_PAGE}`);
          return first.length;
        }),
      ).toBe(INITIAL_PAGE);
    }

    if (MEMORY_HEAVY) {
      await seedContextItems();
      const sources = initial.map((message) => ({
        id: message.id,
        channelId: message.channelId,
        authorType: message.author.type,
      }));
      const marked = await bench("memory-heavy", async () => {
        const memories = await memoriesFor(t.db, orgId, sources);
        return memories.size;
      });
      expect(marked).toBeGreaterThan(0);
    }
  },
  300_000,
);
