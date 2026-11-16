/**
 * The address a decision call takes on a workspace's own endpoint (ADR 0195): the endpoint's
 * saved base with trailing slashes removed, then `/systemone`:
 *
 * - a base already ending in `/systemone` is used unchanged (idempotent);
 * - a base ending in `/v1` gets `/systemone` (never a second `/v1`);
 * - any other base gets `/v1/systemone`, keeping the rest of its path.
 *
 * A full URL the person typed is used exactly as given instead, after the server's endpoint
 * checks; this helper only derives the default.
 */
export function decisionEndpointFromBase(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (/\/systemone$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}
