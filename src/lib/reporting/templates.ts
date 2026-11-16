// Ready-made starting points. Each one opens in the builder, where the user can change anything
// and save it as their own report.
import type { ReportDefinitionInput } from "./definition";

export type Template = { id: string; name: string; description: string; def: ReportDefinitionInput };

const ytd = { id: "p1", kind: "ytd" as const, offset: 0 };
const fyPrior = { id: "p2", kind: "fy" as const, offset: -1 };

export const TEMPLATES: Template[] = [
  { id: "trial_balance", name: "Trial balance", description: "Debit and credit movement and ending balance per account.",
    def: { source: "balances", title: "Trial balance", periods: [ytd], measures: ["debit", "credit", "closing"], rows: { groupBy: ["account"] } } },
  { id: "account_activity", name: "Account activity", description: "Opening balance, movement and closing balance per account.",
    def: { source: "balances", title: "Account activity", periods: [{ id: "p1", kind: "month", offset: 0 }], measures: ["opening", "debit", "credit", "closing"], rows: { groupBy: ["type", "account"] } } },
  { id: "tb_by_entity", name: "Trial balance by entity", description: "Each entity side by side with a combined total.",
    def: { source: "balances", title: "Trial balance by entity", periods: [{ id: "p1", kind: "to_date", offset: 0 }], measures: ["closing"], split: { by: "entity", total: true } } },
  { id: "income_statement", name: "Income statement: this year vs last year", description: "Year to date against the same period last year, with change and %.",
    def: { source: "income_statement", periods: [ytd, { id: "p2", kind: "ytd", offset: -1, label: "Prior YTD" }], comparisons: [{ id: "c1", base: "p1", against: "p2", show: "both" }], rows: { detail: false } } },
  { id: "income_statement_monthly", name: "Income statement by month", description: "Last three months side by side.",
    def: { source: "income_statement", periods: [{ id: "m3", kind: "month", offset: -2 }, { id: "m2", kind: "month", offset: -1 }, { id: "m1", kind: "month", offset: 0 }], comparisons: [{ id: "c1", base: "m1", against: "m2", show: "both", label: "vs last month" }] } },
  { id: "income_statement_dept", name: "Income statement by department", description: "Year to date with one column per department.",
    def: { source: "income_statement", periods: [ytd], split: { by: "departmentId", total: true, untagged: true } } },
  { id: "balance_sheet", name: "Balance sheet: comparative", description: "Today against the end of last fiscal year.",
    def: { source: "balance_sheet", periods: [{ id: "p1", kind: "to_date", offset: 0, label: "Current" }, { ...fyPrior, label: "End of last year" }], comparisons: [{ id: "c1", base: "p1", against: "p2", show: "diff" }] } },
  { id: "balance_sheet_entity", name: "Balance sheet by entity", description: "One column per entity (no eliminations).",
    def: { source: "balance_sheet", periods: [{ id: "p1", kind: "to_date", offset: 0 }], split: { by: "entity", total: true } } },
  { id: "cash_flow", name: "Cash flow", description: "Year to date against last fiscal year.",
    def: { source: "cash_flow", periods: [ytd, fyPrior] } },
  { id: "budget_vs_actual", name: "Budget vs actual", description: "Year to date actual against budget with variance.",
    def: { source: "balances", title: "Budget vs actual", periods: [ytd], measures: ["budget", "net", "budgetVariance", "budgetVariancePct"], filters: { accountTypes: ["INCOME", "EXPENSE"], excludeClosing: true }, rows: { groupBy: ["type", "account"], sign: "natural" } } },
  { id: "budget_vs_actual_dept", name: "Budget vs actual by department", description: "Monthly actual against budget for each department.",
    def: { source: "balances", title: "Budget vs actual by department", periods: [{ id: "p1", kind: "month", offset: 0 }], measures: ["budget", "net", "budgetVariance"], filters: { accountTypes: ["EXPENSE"], excludeClosing: true }, rows: { groupBy: ["departmentId", "account"], sign: "natural" } } },
  { id: "cost_by_department", name: "Expenses by department by month", description: "Expense accounts down, one column per department, for the current month.",
    def: { source: "balances", title: "Expenses by department", periods: [{ id: "m1", kind: "month", offset: 0 }], measures: ["net"], split: { by: "departmentId", total: true, untagged: true }, filters: { accountTypes: ["EXPENSE"], excludeClosing: true }, rows: { groupBy: ["ifrsGroup", "account"], sign: "natural" } } },
  { id: "expense_per_employee", name: "Expense summary per employee / partner", description: "Expenses tagged to each employee or partner, by account.",
    def: { source: "balances", title: "Expense summary per employee / partner", periods: [ytd], measures: ["net"], filters: { accountTypes: ["EXPENSE"], partyTypes: ["EMPLOYEE", "PARTNER"], excludeClosing: true }, rows: { groupBy: ["party", "account"], sign: "natural" } } },
  { id: "management_pl", name: "Management P&L (custom rows)", description: "Your own row layout with account ranges and formulas. Edit the rows to match your chart.",
    def: { source: "balances", title: "Management P&L", periods: [ytd, { id: "p2", kind: "ytd", offset: -1, label: "Prior YTD" }], comparisons: [{ id: "c1", base: "p1", against: "p2", show: "both" }], measures: ["net"], filters: { excludeClosing: true },
      rows: { mode: "custom", sign: "natural", lines: [
        { id: "H1", label: "Revenue", kind: "header" },
        { id: "REV", label: "Revenue", kind: "accounts", ifrsGroups: ["Revenue"], showAccounts: true },
        { id: "COS", label: "Cost of sales", kind: "accounts", ifrsGroups: ["Cost of sales"], showAccounts: true },
        { id: "GP", label: "Gross profit", kind: "formula", formula: "REV - COS" },
        { id: "OPEX", label: "Operating expenses", kind: "accounts", types: ["EXPENSE"], codeFrom: "6000", codeTo: "6999", showAccounts: true },
        { id: "OI", label: "Other income", kind: "accounts", types: ["INCOME"], codeFrom: "7000", codeTo: "7999" },
        { id: "OE", label: "Other expenses and taxes", kind: "accounts", types: ["EXPENSE"], codeFrom: "7000", codeTo: "9999" },
        { id: "NP", label: "Net profit", kind: "formula", formula: "GP - OPEX + OI - OE", bold: true },
      ] } } },
  { id: "gl_listing", name: "General ledger listing", description: "Every posted line grouped by account with running balance.",
    def: { source: "gl_detail", title: "General ledger listing", periods: [{ id: "p1", kind: "month", offset: 0 }], columns: ["date", "number", "memo", "reference", "party", "debit", "credit", "balance"], groupDetailBy: "account", sort: "date" } },
  { id: "gl_by_department", name: "Department spend detail", description: "Expense lines grouped by department.",
    def: { source: "gl_detail", title: "Department spend detail", periods: [{ id: "p1", kind: "month", offset: 0 }], columns: ["date", "number", "accountCode", "accountName", "description", "party", "debit", "credit"], groupDetailBy: "departmentId", filters: { accountTypes: ["EXPENSE"] } } },
  { id: "journal_register", name: "Journal entry register", description: "All entries this month with status, preparer and approver.",
    def: { source: "journal_entries", title: "Journal entry register", periods: [{ id: "p1", kind: "month", offset: 0 }] } },
  { id: "pending_approval", name: "Entries awaiting approval", description: "Drafts and entries submitted for approval.",
    def: { source: "journal_entries", title: "Entries awaiting approval", periods: [{ id: "p1", kind: "fy", offset: 0 }], filters: { statuses: ["DRAFT", "PENDING_APPROVAL"] } } },
  { id: "ar_aging", name: "Customer aging (AR)", description: "Receivables per customer by days outstanding.",
    def: { source: "aging", title: "Accounts receivable aging", periods: [{ id: "p1", kind: "to_date", offset: 0 }], filters: { partyTypes: ["CUSTOMER"] }, aging: { buckets: [30, 60, 90, 120], basis: "transactionDate" } } },
  { id: "ap_aging", name: "Vendor aging (AP)", description: "Payables per vendor by days past due.",
    def: { source: "aging", title: "Accounts payable aging", periods: [{ id: "p1", kind: "to_date", offset: 0 }], filters: { partyTypes: ["VENDOR"] }, aging: { buckets: [30, 60, 90, 120], basis: "dueDate" } } },
  { id: "employee_aging", name: "Employee advances aging", description: "Open balances per employee or partner (cash advances, liquidations).",
    def: { source: "aging", title: "Employee and partner balances", periods: [{ id: "p1", kind: "to_date", offset: 0 }], filters: { partyTypes: ["EMPLOYEE", "PARTNER"] }, aging: { buckets: [15, 30, 60], basis: "transactionDate" } } },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
