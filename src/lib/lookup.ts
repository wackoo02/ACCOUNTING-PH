// Option builders for the master-data pickers (MasterLookup / MasterPicker).
// Safe to import from server and client components.
import { DIMENSIONS } from "@/lib/ledger/dimensions";
import type { AddTarget, LookupOption, SavedRecord } from "@/components/MasterLookup";
import type { MasterKind } from "@/lib/masters/config";

type Coded = { id: string; code: string; name: string };

/** Records keyed by id, shown as "code · name". */
export const idOpts = <T extends Coded>(rows: T[], hint?: (r: T) => string | undefined): LookupOption[] =>
  rows.map((r) => ({ value: r.id, code: r.code, label: r.name, hint: hint?.(r) }));

/** Records keyed by code (forms that store the code, like master references). */
export const codeOpts = (rows: { code: string; name: string }[]): LookupOption[] =>
  rows.map((r) => ({ value: r.code, code: r.code, label: r.name }));

type Emp = { id: string; code: string; firstName: string; lastName: string };
export const empName = (e: Emp) => `${e.firstName} ${e.lastName}`.trim();
export const empOpts = (rows: Emp[]): LookupOption[] => rows.map((e) => ({ value: e.id, code: e.code, label: empName(e) }));

/** Plain strings (e.g. item categories, asset locations). */
export const textOpts = (rows: string[]): LookupOption[] => rows.map((s) => ({ value: s, label: s }));

/** "Add new" target for a dimension value of the column key (departmentId, projectId, ...). */
export const dimAdd = (key: string): AddTarget | undefined => {
  const type = DIMENSIONS.find((d) => d.key === key)?.type;
  return type ? { kind: "dimensions", type, prefill: { type } } : undefined;
};
export const dimTypeAdd = (type: string): AddTarget => ({ kind: "dimensions", type, prefill: { type } });

// Parties stored as "VENDOR:V-0001", "CUSTOMER:C-0001", "EMPLOYEE:E-001", "PARTNER:E-002".
const PARTY_KIND: Record<string, MasterKind> = { CUSTOMER: "customers", VENDOR: "vendors", EMPLOYEE: "employees", PARTNER: "employees" };
export const partyOpt = (value: string, name: string): LookupOption => {
  const [prefix, code] = value.split(":");
  return { value, code, label: name.replace(/^(Vendor|Customer|Employee|Partner) · /, ""), hint: prefix.charAt(0) + prefix.slice(1).toLowerCase(), kind: PARTY_KIND[prefix] };
};
/** "Add new" targets for a party field, in the order given. */
export const partyAdd = (kinds: ("vendors" | "customers" | "employees")[]): AddTarget[] => kinds.map((k) => ({
  kind: k, toValue: (r: SavedRecord) => `${k === "employees" ? (r.isPartner ? "PARTNER" : "EMPLOYEE") : k === "vendors" ? "VENDOR" : "CUSTOMER"}:${r.code}`,
}));
