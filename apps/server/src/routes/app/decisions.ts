import { DECISION_MODEL_ID, NotFoundError, requirePermission } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const Model = z.string().trim().min(1).max(200).regex(DECISION_MODEL_ID);
const Settings = z.object({
  credentialId: z.uuid(),
  model: Model,
  visionModel: Model.nullable().optional(),
  endpoint: z.string().trim().max(2000).optional().openapi({
    description:
      "A custom endpoint's complete decision URL, used exactly. Never set for OpenRouter, whose route is fixed.",
  }),
});
const View = z.object({ settings: Settings.nullable(), available: z.boolean() });
const path = "/organizations/{orgId}/decisions";

/** A workspace's own decision models, on an existing OpenRouter key or custom chat endpoint. */
export function decisionRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/:orgId/decisions", requireSession(deps.auth));

  const owner = async (orgId: string, userId: string) => {
    await requirePermission(deps.db, userId, orgId, "manage_credentials");
    const decisions = deps.extras?.decisions;
    if (!decisions) throw new NotFoundError();
    return decisions;
  };

  app.openapi(
    createRoute({
      method: "get",
      path,
      tags: ["Organization"],
      security,
      summary: "The workspace's decision models (credential managers)",
      request: { params: OrgParams },
      responses: { 200: json(View), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const decisions = await owner(orgId, c.get("user").id);
      return c.json(await decisions.view(orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path,
      tags: ["Organization"],
      security,
      summary: "Test and save decision models, or reset with `settings: null`",
      description:
        "The account key is never returned. An OpenRouter key uses its Decisions route; a custom endpoint derives `/systemone` from its base unless `endpoint` names the complete URL. A probe must answer Noul, Choice and Score, plus Box when a vision model is chosen; a failed probe keeps the previous setup.",
      request: { params: OrgParams, body: body(z.object({ settings: Settings.nullable() })) },
      responses: { 200: json(View), ...errors, 429: errorResponse("Too many tries") },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const decisions = await owner(orgId, actor);
      if (
        !(await deps.adapters.rateLimiter.consume(`decisions:${orgId}:${actor}`, { limit: 10, windowMs: 60_000 }))
          .allowed
      )
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      const input = c.req.valid("json").settings;
      return c.json(
        await decisions.save(orgId, actor, input && { ...input, visionModel: input.visionModel ?? null }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path,
      tags: ["Organization"],
      security,
      summary: "Go back to the installation's decision setup",
      request: { params: OrgParams },
      responses: { 200: json(View), ...errors, 429: errorResponse("Too many tries") },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const decisions = await owner(orgId, actor);
      if (
        !(await deps.adapters.rateLimiter.consume(`decisions:${orgId}:${actor}`, { limit: 10, windowMs: 60_000 }))
          .allowed
      )
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      return c.json(await decisions.save(orgId, actor, null), 200);
    },
  );

  return app;
}
