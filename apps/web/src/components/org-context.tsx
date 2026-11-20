import type { Me, OrgSummary } from "@agenteschat/client";
import { type AgentColor, workspaceSky } from "@agenteschat/ui";
import { createContext, type ReactNode, useContext, useMemo } from "react";

interface OrgContextValue {
  org: OrgSummary;
  me: Me;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ org, me, children }: OrgContextValue & { children: ReactNode }) {
  // Stable across the layout's re-renders (every navigation): every row and avatar reads it.
  const value = useMemo(() => ({ org, me }), [org, me]);
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

/** The current organization and the signed-in person, inside `/org/$orgId/*`. */
export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) throw new Error("useOrg must be used inside an organization route");
  return value;
}

/** The same, or null outside a workspace's context (the onboarding's first steps). */
export const useOrgIfAny = () => useContext(OrgContext);

export function useWorkspaceColor(color: AgentColor | undefined) {
  const accent = useOrgIfAny()?.org.accent;
  return useMemo(() => (!color || color === "sky" ? workspaceSky(accent) : color), [accent, color]);
}
