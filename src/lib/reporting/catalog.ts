// What each report source supports. The builder screen reads this to show the right options.
// Shared by server and browser, so keep it free of database code.
// To add a report for a new module (e.g. AR invoice aging): add an entry here, write its run
// function under sources/, and register it in run.ts.
import { DIMENSIONS } from "../ledger/dimensions";
import type { SourceId } from "./definition";

export type SourceInfo = {
  id: SourceId;
  label: string;
  group: string;
  description: string;
  periods: "many" | "one" | "asOf"; // many = columns per period; one = a date range; asOf = a single date
  split: boolean; // columns by entity / dimension
  comparisons: boolean;
  measures: boolean;
  rowGroups: boolean;
  customRows: boolean;
  statementDetail: boolean;
  detailColumns?: { id: string; label: string }[];
  groupDetailBy?: { id: string; label: string }[];
  statuses: boolean;
  aging: boolean;
};

const DIM_OPTS = DIMENSIONS.map((d) => ({ id: d.key, label: d.label }));

export const GL_FIELD_OPTIONS = [
  { id: "date", label: "Posting date" }, { id: "transactionDate", label: "Transaction date" }, { id: "number", label: "JE no." },
  { id: "status", label: "Status" }, { id: "source", label: "Source" }, { id: "entity", label: "Entity" },
  { id: "accountCode", label: "Account code" }, { id: "accountName", label: "Account name" }, { id: "ifrsGroup", label: "IFRS line item" },
  { id: "memo", label: "Narration" }, { id: "description", label: "Line description" }, { id: "reference", label: "Reference" },
  { id: "party", label: "Customer / vendor / employee" }, ...DIM_OPTS,
  { id: "currency", label: "Currency" }, { id: "fxRate", label: "Rate" }, { id: "fxDebit", label: "Debit (currency)" }, { id: "fxCredit", label: "Credit (currency)" },
  { id: "debit", label: "Debit" }, { id: "credit", label: "Credit" }, { id: "net", label: "Net (Dr - Cr)" }, { id: "balance", label: "Running balance" },
  { id: "cleared", label: "Cleared on" }, { id: "preparedBy", label: "Prepared by" }, { id: "approvedBy", label: "Approved by" },
];
export const JE_FIELD_OPTIONS = [
  { id: "number", label: "JE no." }, { id: "date", label: "Posting date" }, { id: "transactionDate", label: "Transaction date" }, { id: "entity", label: "Entity" },
  { id: "memo", label: "Narration" }, { id: "reference", label: "Reference" }, { id: "source", label: "Source" }, { id: "status", label: "Status" },
  { id: "lines", label: "Lines" }, { id: "totalDebit", label: "Total debit" }, { id: "totalCredit", label: "Total credit" }, { id: "preparedBy", label: "Prepared by" },
  { id: "submittedAt", label: "Submitted" }, { id: "approvedBy", label: "Approved / posted by" }, { id: "postedAt", label: "Posted" }, { id: "reversal", label: "Reversal of" },
];

export const ROW_GROUP_OPTIONS = [
  { id: "account", label: "Account" }, { id: "type", label: "Account type" }, { id: "ifrsGroup", label: "IFRS line item" }, { id: "parentAccount", label: "Parent account" },
  { id: "entity", label: "Entity" }, { id: "party", label: "Customer / vendor / employee" }, { id: "partyType", label: "Party type" }, ...DIM_OPTS,
];

const base = { split: false, comparisons: false, measures: false, rowGroups: false, customRows: false, statementDetail: false, statuses: false, aging: false };

export const SOURCES: SourceInfo[] = [
  { ...base, id: "balances", label: "Account balances", group: "General ledger", periods: "many", split: true, comparisons: true, measures: true, rowGroups: true, customRows: true,
    description: "Trial balance, account activity, budget vs actual, cost per department or project, expenses per employee, or your own statement layout with formulas." },
  { ...base, id: "income_statement", label: "Income statement", group: "Financial statements", periods: "many", split: true, comparisons: true, statementDetail: true,
    description: "Statement of profit or loss in the PAS 1 layout, with any periods, comparisons, entities or departments as columns." },
  { ...base, id: "balance_sheet", label: "Balance sheet", group: "Financial statements", periods: "many", split: true, comparisons: true, statementDetail: true,
    description: "Statement of financial position as of the end of each period." },
  { ...base, id: "cash_flow", label: "Cash flow", group: "Financial statements", periods: "many", split: true, comparisons: true,
    description: "Statement of cash flows, indirect method (PAS 7)." },
  { ...base, id: "gl_detail", label: "General ledger lines", group: "General ledger", periods: "one", statuses: true, detailColumns: GL_FIELD_OPTIONS,
    groupDetailBy: [{ id: "none", label: "No grouping" }, { id: "account", label: "Account" }, { id: "entry", label: "Journal entry" }, { id: "entity", label: "Entity" }, { id: "party", label: "Customer / vendor / employee" }, ...DIM_OPTS],
    description: "Every journal line with the columns you pick: GL listing, account ledger, department spend detail, drafts awaiting approval." },
  { ...base, id: "journal_entries", label: "Journal entries", group: "General ledger", periods: "one", statuses: true, detailColumns: JE_FIELD_OPTIONS,
    groupDetailBy: [{ id: "none", label: "No grouping" }, { id: "entity", label: "Entity" }],
    description: "Journal entry register with status, preparer and approver." },
  { ...base, id: "aging", label: "Aging", group: "Receivables and payables", periods: "asOf", aging: true,
    description: "Customer, vendor or employee balances aged by days outstanding or days past due." },
];

export const sourceInfo = (id: string) => SOURCES.find((s) => s.id === id);
