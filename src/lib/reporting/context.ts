import type { ReportDefinition } from "./definition";
import type { ResolvedPeriod } from "./periods";
import type { ReportResult } from "./result";
import type { ScopeOrg } from "./scope";

/** Everything a source needs to run: the entities the viewer may see, the resolved dates and the definition. */
export type RunContext = {
  def: ReportDefinition;
  orgs: ScopeOrg[]; // already checked: the viewer is a member of each
  currentOrgId: string; // company the viewer is signed in to (links open there)
  asOf: Date;
  periods: ResolvedPeriod[];
  notes: string[];
};

export type ReportSource = {
  id: string;
  run: (ctx: RunContext) => Promise<ReportResult>;
};
