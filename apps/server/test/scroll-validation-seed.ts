/** Shared history seed for the scrollback harness and the real AppImage GUI runner. */

import type { BlobStore } from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";

export const MESSAGES = 600;
const START = Date.UTC(2026, 10, 10, 9, 0, 0);

export type Kind =
  | "user"
  | "agent"
  | "question"
  | "approval"
  | "team"
  | "artifact"
  | "voice"
  | "mission"
  | "consult"
  | "work"
  | "live"
  | "thread";

/** A focused history profile for attributing frame cost to a family of rows. */
export type Family = "mixed" | "text" | "cards" | "media" | "refs";

export const FAMILY_KINDS: Record<Exclude<Family, "mixed">, readonly Kind[]> = {
  text: ["user", "agent"],
  cards: ["question", "approval", "team"],
  media: ["artifact", "voice"],
  refs: ["consult", "mission", "thread", "live", "work"],
};

export interface Seeded {
  id: string;
  createdAt: Date;
  kind: Kind;
}

export interface SeedIds {
  orgId: string;
  channelId: string;
  userId: string;
  adaId: string;
  atlasId: string;
}

export interface SeedResult {
  seeded: Seeded[];
  approvalIds: string[];
  artifactIds: string[];
}

function bodyFor(kind: Kind, i: number): string {
  if (kind === "question" || kind === "approval" || kind === "team") return "";
  if (kind === "agent" && i % 9 === 0) {
    return [
      `I checked the rollout at step ${i}. The short version: the queue drained, but the retry window is still too wide.`,
      "",
      "```ts",
      `if (attempt < ${i % 7}) {`,
      '  await backoff(attempt, { jitter: true });',
      "}",
      "```",
      "",
      "> The next run should keep the same jitter and halve the base delay.",
      "",
      "What I changed, in order:",
      "",
      "1. Pinned the fixture clock.",
      "2. Logged the admission gate's quiet window.",
      "3. Replayed three upward bursts against the recorded history.",
      "",
      "No user-visible change is needed until the replay proves a displacement.",
    ].join("\n");
  }
  if (kind === "agent") {
    return `Update ${i}: the deployment is stable. I replayed the channel history and found no missing page in this run.`;
  }
  if (kind === "artifact") return "I attached the screenshot from the failed deploy.";
  if (kind === "voice") return "Quick note from the on-call handoff.";
  if (kind === "mission") return "Mission created: make the desktop scrollback measurable.";
  if (kind === "work") return "I will work on this in the background and report back here.";
  if (kind === "live") return "This is about the rollout section of the plan.";
  if (kind === "consult") return "Atlas confirmed the diagnosis; here is the combined answer.";
  if (kind === "thread") return "Starting a separate thread for the migration checklist.";
  return `Message ${i}: can you check the rollout status before the next deploy?`;
}

function kindFor(i: number, family: Family = "mixed"): Kind {
  if (family !== "mixed") {
    const kinds = FAMILY_KINDS[family];
    return kinds[i % kinds.length] as Kind;
  }
  if (i % 53 === 0) return "thread";
  if (i % 43 === 0) return "live";
  if (i % 41 === 0) return "mission";
  if (i % 37 === 0) return "voice";
  if (i % 33 === 0) return "work";
  if (i % 31 === 0) return "team";
  if (i % 29 === 0) return "approval";
  if (i % 27 === 0) return "consult";
  if (i % 23 === 0) return "question";
  if (i % 19 === 0) return "artifact";
  if (i % 7 === 0) return "agent";
  return i % 2 === 0 ? "user" : "agent";
}

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

/** Seeds the mixed conversation. The caller owns the workspace, agents and channel. */
export async function seedHistory(
  db: Database,
  ids: SeedIds,
  blobs: Pick<BlobStore, "put">,
  count = MESSAGES,
  family: Family = "mixed",
): Promise<SeedResult> {
  const { orgId, channelId, userId, adaId, atlasId } = ids;
  const artifactIds: string[] = [];
  for (const [title, kind, contentType] of [
    ["deploy-error.png", "file", "image/png"],
    ["rollout-notes.md", "file", "text/markdown"],
    ["q3-plan", "document", "application/json"],
  ] as const) {
    const [artifact] = await db
      .insert(schema.artifacts)
      .values({
        orgId,
        kind,
        title,
        channelId,
        inDrive: true,
        share: "conversation",
        createdByType: "person",
        createdById: userId,
        updatedByType: "person",
        updatedById: userId,
      })
      .returning({ id: schema.artifacts.id });
    if (!artifact) throw new Error("artifact was not written");
    artifactIds.push(artifact.id);
    const blobKey = `scroll-validation/${artifact.id}/${title}`;
    const bytes = kind === "file" && contentType === "image/png" ? PNG : new TextEncoder().encode(`# ${title}\n`);
    await blobs.put(blobKey, bytes, { contentType });
    await db.insert(schema.artifactVersions).values({
      orgId,
      artifactId: artifact.id,
      version: 1,
      blobKey,
      contentType,
      size: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      fileName: title,
      authorType: "person",
      authorId: userId,
      ...(kind === "file" && contentType === "image/png" ? { width: 1, height: 1 } : {}),
    });
  }

  const seeded: Seeded[] = [];
  const approvalIds: string[] = [];
  const messages: (typeof schema.messages.$inferInsert)[] = [];

  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const createdAt = new Date(START + i * 5 * 60_000 + ((i * 7919) % 180) * 1000);
    const kind = kindFor(i, family);
    const body = bodyFor(kind, i);
    const byAgent = kind !== "user" && kind !== "thread" && kind !== "artifact" && kind !== "voice";
    const meta: Record<string, unknown> = {};

    if (kind === "question") {
      meta.question = {
        id: crypto.randomUUID(),
        agentId: adaId,
        channelId,
        threadId: null,
        messageId: id,
        text: `Should I deploy revision ${i} now or wait for the window?`,
        choices: ["Deploy now", "Wait for the window", "Ask Atlas"],
        status: i % 2 === 0 ? "open" : "answered",
        answer: i % 2 === 0 ? null : "Wait for the window",
        answeredByUserId: i % 2 === 0 ? null : userId,
      };
    } else if (kind === "approval") {
      const approvalId = crypto.randomUUID();
      approvalIds.push(approvalId);
      meta.approvalId = approvalId;
      await db.insert(schema.approvals).values({
        id: approvalId,
        orgId,
        agentId: adaId,
        channelId,
        threadRootId: id,
        messageId: id,
        toolUseId: `tool-${i}`,
        tool: "github.merge_pull_request",
        scope: "repo:write",
        params: { pullRequest: 40 + i },
        actionHash: `hash-${i}`,
        title: `Merge PR #${40 + i} into main`,
        detail: "The rollout fix and its regression test.",
        why: "The queue is drained and the canary is green.",
        expiresAt: new Date(START + 86_400_000),
      });
    } else if (kind === "team") {
      meta.actionCard = {
        kind: "team_proposal",
        forUserId: userId,
        params: {
          lead: "Ada",
          agents: [
            {
              name: "Ada",
              handle: "ada",
              role: "Engineer",
              line: "Keeps the rollout stable.",
              instructions: "You keep the rollout stable.",
              appearance: null,
              channel: "",
              routines: [],
              firstTask: "Audit the retry window.",
            },
            {
              name: "Atlas",
              handle: "atlas",
              role: "Operations",
              line: "Watches the queue.",
              instructions: "You watch the deployment queue.",
              appearance: null,
              channel: "",
              routines: [],
              firstTask: null,
            },
          ],
          newChannels: [],
          skills: [],
          weekly: null,
          approvals: "risky",
          invite: [],
        },
        state: "pending",
        decidedByUserId: null,
        decidedAt: null,
        expiresAt: new Date(START + 86_400_000).toISOString(),
      };
    } else if (kind === "artifact") {
      meta.artifacts = [{ id: artifactIds[i % artifactIds.length], version: 1 }];
    } else if (kind === "voice") {
      meta.voice = {
        clipId: crypto.randomUUID(),
        durationMs: 4_000 + (i % 9) * 500,
        peaks: [0.2, 0.6, 0.4, 0.8, 0.3],
        text: "Quick note from the on-call handoff.",
      };
    } else if (kind === "mission") {
      meta.missionStart = { missionId: crypto.randomUUID() };
    } else if (kind === "consult") {
      meta.consulted = [
        {
          agentId: atlasId,
          consultationId: crypto.randomUUID(),
          status: "answered",
          question: "Is the queue drained?",
          answer: "Yes, since the last retry.",
        },
      ];
    } else if (kind === "work") {
      const [work] = await db
        .insert(schema.agentWorks)
        .values({
          orgId,
          agentId: adaId,
          channelId,
          anchorMessageId: id,
          ownThread: true,
          title: "Watch the rollout queue",
          status: "live",
          how: "agent",
          requestedByUserId: userId,
          updateSeq: 1,
          lastUpdateAt: createdAt,
          lastUpdateText: "The queue is draining.",
          startedAt: createdAt,
        })
        .returning({ id: schema.agentWorks.id });
      if (!work) throw new Error("work was not written");
      meta.longWork = { id: work.id };
    } else if (kind === "live") {
      meta.liveRef = {
        artifactId: artifactIds[2],
        kind: "document",
        title: "Q3 rollout plan",
        selection: { label: "Rollout", start: 1, end: 40 },
      };
    }

    messages.push({
      id,
      createdAt,
      orgId,
      channelId,
      threadId: null,
      authorType: byAgent ? "agent" : "person",
      authorUserId: byAgent ? null : userId,
      authorAgentId: byAgent ? adaId : null,
      body,
      mentionedAgentIds: [],
      mentionedUserIds: [],
      hop: 0,
      stretchId: null,
      agentRunId: null,
      meta,
      editedAt: null,
      deletedAt: null,
    });
    seeded.push({ id, createdAt, kind });

    if (kind === "thread") {
      for (const offset of [30_000, 60_000]) {
        messages.push({
          id: crypto.randomUUID(),
          createdAt: new Date(createdAt.getTime() + offset),
          orgId,
          channelId,
          threadId: id,
          authorType: "agent",
          authorUserId: null,
          authorAgentId: atlasId,
          body: "Checklist item done.",
          mentionedAgentIds: [],
          mentionedUserIds: [],
          hop: 1,
          stretchId: null,
          agentRunId: null,
          meta: {},
          editedAt: null,
          deletedAt: null,
        });
      }
    }
  }

  for (let i = 0; i < messages.length; i += 100) {
    await db.insert(schema.messages).values(messages.slice(i, i + 100));
  }
  return { seeded, approvalIds, artifactIds };
}
