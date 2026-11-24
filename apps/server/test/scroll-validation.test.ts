/**
 * Focused scrollback validation against the real server harness.
 *
 * Seeds a 600-message mixed conversation through the harness's PGlite database and
 * the real schema, then validates the exact paging the chat uses for older pages:
 * the first 100 messages, then 50 at a time backwards. It also checks that every
 * required card kind survives the real `listMessages` projection.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, listen, type TestServer } from "./harness";
import { MESSAGES, type Seeded, seedHistory } from "./scroll-validation-seed";

const INITIAL_PAGE = 100;
const OLDER_PAGE = 50;

let t: TestServer;
let server: ReturnType<typeof listen>;
let owner: Browser;
let orgId: string;
let channelId: string;
let userId: string;
let adaId: string;
let atlasId: string;
let seeded: Seeded[];
let approvalIds: string[];

beforeAll(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  owner = browser(t);
  const signedUp = await owner("/api/auth/sign-up/email", {
    json: { email: "scroll@example.com", password: "correct horse battery", name: "Marina" },
  });
  expect(signedUp.status).toBeLessThan(300);

  const made = (await (await owner("/api/app/organizations", { json: { name: "Scroll Lab" } })).json()) as {
    organization: { id: string };
  };
  orgId = made.organization.id;

  const [user] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "scroll@example.com"));
  if (!user) throw new Error("the owner was not written");
  userId = user.id;

  const [channel] = await t.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.name, "general")));
  if (!channel) throw new Error("the workspace has no #general");
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
  adaId = agents.find((a) => a.handle === "ada")?.id ?? "";
  atlasId = agents.find((a) => a.handle === "atlas")?.id ?? "";
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
  approvalIds = result.approvalIds;
  server = listen(t);
});

afterAll(async () => {
  server?.stop(true);
  await t?.close();
});

describe("real-server mixed scrollback", () => {
  test("600 seeded messages page back without duplicates or holes, and every card kind survives", async () => {
    const initialRes = await owner(
      `/api/app/organizations/${orgId}/channels/${channelId}/messages?limit=${INITIAL_PAGE}`,
    );
    expect(initialRes.status).toBe(200);
    const initial = ((await initialRes.json()) as { messages: { id: string; createdAt: string }[] }).messages;
    expect(initial.length).toBe(INITIAL_PAGE);
    expect(initial.map((m) => m.id)).toEqual(seeded.slice(-INITIAL_PAGE).map((m) => m.id));

    const pages: { id: string; createdAt: string }[][] = [];
    let cursor = initial[0]?.createdAt;
    for (let page = 0; page < 20 && cursor; page++) {
      const res = await owner(
        `/api/app/organizations/${orgId}/channels/${channelId}/messages?before=${encodeURIComponent(
          cursor,
        )}&limit=${OLDER_PAGE}`,
      );
      expect(res.status).toBe(200);
      const messages = ((await res.json()) as { messages: { id: string; createdAt: string }[] }).messages;
      pages.push(messages);
      if (messages.length === 0) break;
      cursor = messages[0]?.createdAt;
    }

    expect(pages.slice(0, 10).map((p) => p.length)).toEqual(Array(10).fill(OLDER_PAGE));
    expect(pages[10]?.length).toBe(0);

    const olderChronological = pages
      .filter((p) => p.length > 0)
      .reverse()
      .flat();
    const all = [...olderChronological, ...initial];
    const ids = all.map((m) => m.id);
    expect(ids).toHaveLength(MESSAGES);
    expect(new Set(ids).size).toBe(MESSAGES);
    expect(ids).toEqual(seeded.map((m) => m.id));

    const byId = new Map(all.map((m) => [m.id, m]));
    const card = (kind: Seeded["kind"]) => {
      const entry = seeded.find((s) => s.kind === kind);
      if (!entry) throw new Error(`no seeded ${kind}`);
      const message = byId.get(entry.id) as Record<string, unknown> | undefined;
      if (!message) throw new Error(`the ${kind} message is missing from the pager`);
      return message;
    };

    const question = card("question").meta as { question: { choices?: string[] } };
    expect(question.question.choices?.length).toBe(3);
    expect((card("approval").meta as { approvalId?: string }).approvalId).toBeString();
    expect((card("team").meta as { actionCard?: { kind?: string } }).actionCard?.kind).toBe("team_proposal");
    expect((card("artifact").meta as { artifacts?: unknown[] }).artifacts).toHaveLength(1);
    expect((card("voice").meta as { voice?: { durationMs?: number } }).voice?.durationMs).toBeGreaterThan(0);
    expect((card("mission").meta as { missionStart?: unknown }).missionStart).toBeDefined();
    expect((card("consult").meta as { consulted?: unknown[] }).consulted).toHaveLength(1);
    expect((card("work") as { longWork?: { id?: string } }).longWork?.id).toBeString();
    expect((card("live") as { liveRef?: { artifactId?: string } }).liveRef?.artifactId).toBeString();

    const approvalsRes = await owner(`/api/app/organizations/${orgId}/approvals?status=pending`);
    expect(approvalsRes.status).toBe(200);
    const { approvals } = (await approvalsRes.json()) as { approvals: { id: string }[] };
    expect(new Set(approvals.map((a) => a.id))).toEqual(new Set(approvalIds));

    const origin = server.url.origin.replace("127.0.0.1", "localhost");
    console.log(`SCROLL_VALIDATION_URL=${origin}/org/${orgId}/c/${channelId}`);
    console.log(`SCROLL_VALIDATION_COOKIE=${owner.cookie()}`);
  }, 180_000);
});
