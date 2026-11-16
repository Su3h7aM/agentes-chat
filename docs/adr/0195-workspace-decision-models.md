# 0195. Workspace decision models on existing provider credentials

- Status: Accepted
- Date: 2026-11-16
- Code: schema `packages/db/src/schema/agents.ts` (`organization_settings.decisions`, migration
  0309), engine `packages/engine/src/decision-settings.ts`, `endpoints.ts`, `jev-key.ts`,
  `router-jev.ts`, `judge.ts`, `jobs.ts`, `gateway.ts`; shared derivation
  `packages/providers/src/decision-endpoint.ts`; route
  `apps/server/src/routes/app/decisions.ts`; client
  `packages/client/src/api/{types,client,http-client,keys,queries}.ts`,
  `packages/client/src/lib/decisions.ts`; tests `packages/providers/test/decision-endpoint.test.ts`,
  `packages/engine/test/decisions.test.ts`, `packages/engine/test/credentials.test.ts`,
  `apps/server/test/decisions.test.ts`

## Context

Jev (System One) is the installation's decision service: it picks who answers, makes calibrated
judgments, and looks for targets on images. By default it belongs to the server's one key. A
workspace may already have an OpenRouter key or its own OpenAI- or Anthropic-compatible chat
endpoint, and may want those to make its decisions instead.

The choice must stay optional: no setting keeps today's Jev setup, tariff and platform cap. An
explicit workspace choice must not silently fall back to the installation's Jev, whose secret and
billing belong to the server. A chat model is not automatically a decision model: Noul, Choice,
Score and, when enabled, Box are a different contract.

## Decision

1. **One nullable workspace setting.** `organization_settings.decisions` holds
   `{ credentialId, model, visionModel, endpoint? }`; null means the installation's Jev.
   `visionModel: null` disables image and Box judgments for that workspace. `endpoint` is only
   meaningful for a custom credential. There is no auto/model/Jev mode switch.

2. **Three choices, derived from existing credentials.**
   - **Jev/TypeSafe**: the setting is null; the installation's setup, tariff and platform cap apply.
   - **OpenRouter**: a live `openrouter` credential calls OpenRouter's
     `/api/alpha/decisions`. Model IDs are sent exactly as saved, including namespaced IDs.
   - **Custom**: a live `custom` chat credential is reused with its address, API style and key,
     never copied. The same credential keeps serving chat and may remain the workspace's chat
     default. Its decision URL derives from the saved endpoint base:
     trailing slashes are removed; a base ending in `/systemone` is unchanged; a base ending in
     `/v1` gets `/systemone`; any other base gets `/v1/systemone`. Path prefixes are preserved, so
     an Anthropic-normalized base such as `https://gateway.example/anthropic` becomes
     `https://gateway.example/anthropic/v1/systemone`.

3. **Optional full custom URL.** `decisions.endpoint` may name a complete decision URL. It is used
   exactly as saved, including its path and query, after the same outbound checks as any other
   workspace endpoint: https and a public address unless the server allows private endpoints, and
   no credentials in the URL. The guarded fetch checks the address again when it connects.
   OpenRouter refuses an override: its decision route is fixed. The override is never a way to
   reach a custom destination with an OpenRouter key.

4. **Credentials resolved per call.** Every call checks the workspace, provider, revocation and
   decryption again, so revoking a key or rotating its secret applies without a restart. The API
   returns metadata only, never the key.

5. **Probe before saving.** A candidate must answer Noul, Choice and Score, plus a Box question on
   a synthetic image when a vision model is chosen. Numbers must be finite and in range; token
   units may be fractional. Only the answer's shape is required: the decision format is what makes
   a model usable, while usage and cost are secondary, so a custom endpoint's cost is optional (§7).
   A failed probe writes nothing and keeps the previous setting, and says where it failed in words
   the workspace can act on: this server could not reach the address, the endpoint refused the key,
   had no credit, no decision route, was rate limiting or failed, refused the request (for example
   the model ID), did not answer in time, answered in another format, or gave no box for the image.
   The endpoint's own error text is never shown. A credential changed while the probe runs is not
   saved as if the new destination had been tested: the write re-reads it under the credential lock
   and refuses a changed stamp.

6. **Same choice for router and judge.** `createWorkspaceDecisions` resolves one target per
   organization for both. A broken override yields an unusable target, so the router continues
   with the workspace's small model, plan or rules, and the judge continues with its local LLM
   fallback (calibrated requests still fail). It never retries the installation's Jev.

7. **Usage and billing.** OpenRouter and custom decision calls record the credential id and
   `billed_to = org`. OpenRouter always reports its cost, which is kept exactly, including zero, and
   a missing one is refused. A custom endpoint's cost is optional: a reported one is kept, and when it
   reports none the call records zero, since its price is the endpoint's own and not ours to know.
   Its tokens are recorded either way. TypeSafe's Jev reports no cost at all; its cost is estimated
   from input tokens at its published tariff. The installation's Jev
   keeps its TypeSafe tariff and platform cap. The Jev month screen counts only platform-billed
   decision rows.

8. **Standing and credential safety.** A save makes no provider call while the workspace is on a
   billing hold or suspended, and a hold set during a probe keeps the setting from landing.
   Revoking or deleting a credential in use as a decision credential is refused. Consolidating
   copies remaps the setting to the kept credential. An explicit `purge=true&release=true` delete
   clears the setting. Decision saves, resaves, rotations, revocations, deletes, default changes
   and copy consolidation serialize on the same per-credential advisory lock.

9. **Permissions and audit.** `GET`, `PUT` and `DELETE /api/app/organizations/{orgId}/decisions`
   require `manage_credentials` in that organization. Changes are audited with the credential id,
   model ids and an explicit custom URL, never the key.

## Consequences

- Existing installations are unchanged until a workspace saves a choice.
- OpenRouter needs no new environment variable: the workspace's existing key is enough.
- A custom decision endpoint needs no new credential type or protocol marker. Any live custom chat
  endpoint can be chosen; the optional override exists for a service whose decision route is not
  `/systemone` below its chat base.
- The endpoint must actually speak System One. Passing the probe proves the protocol, not the
  quality of its probabilities; models still need task-specific calibration.
