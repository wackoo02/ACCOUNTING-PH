import { MASTERS, type MasterKind } from "./config";
import { listMasters } from "./query";
import type { Candidate } from "./similar";

/** The name people see for a record in pickers. */
export function displayLabel(kind: MasterKind, r: Record<string, unknown>): string {
  if (kind === "employees") return [r.firstName, r.middleName ? String(r.middleName).charAt(0) + "." : "", r.lastName].filter(Boolean).join(" ");
  return String(r.name ?? r.code ?? "");
}

/** Every record of a list in the shape the duplicate check needs. */
export async function loadCandidates(kind: MasterKind, organizationId: string, type?: string): Promise<{ candidates: Candidate[]; codes: string[] }> {
  const rows = await listMasters(kind, organizationId, undefined, type);
  const candidates = rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    label: displayLabel(kind, r),
    tin: (r.tin as string | null | undefined) ?? null,
    email: (r.email as string | null | undefined) ?? null,
    accountNumber: (r.accountNumber as string | null | undefined) ?? null,
  }));
  return { candidates, codes: rows.map((r) => String(r.code)) };
}

export const singularOf = (kind: MasterKind) => MASTERS[kind].singular;
