import type { IconName } from "@/lib/icons";
import type { Role } from "@prisma/client";
import { can, type Permission } from "@/lib/permissions";
import { MASTERS, MASTER_KINDS } from "@/lib/masters/config";

import type { NavItem, NavSection } from "@/lib/nav-match";
export type { NavItem, NavSection };

const MASTER_ICON: Record<string, IconName> = {
  accounts: "accounts", dimensions: "dimensions", taxes: "taxes", banks: "banks", products: "products",
  employees: "employees", vendors: "vendors", customers: "customers", currencies: "currencies", assets: "fixed-assets", warehouses: "inventory", locations: "inventory",
};

export const NAV: NavSection[] = [
  { title: null, items: [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }] },
  {
    title: "General Ledger",
    items: [
      { href: "/journals", label: "Journal Entries", icon: "journal" },
      { href: "/journals/new", label: "New Journal Entry", icon: "journal-new", perm: "journal.create" },
      { href: "/journals?status=PENDING_APPROVAL", label: "Approvals", icon: "approvals", perm: "journal.post" },
      { href: "/recurring", label: "Recurring Entries", icon: "recurring" },
      { href: "/allocations", label: "Allocations", icon: "allocations" },
      { href: "/intercompany", label: "Intercompany", icon: "intercompany" },
      { href: "/fx", label: "FX Revaluation", icon: "fx" },
      { href: "/periods", label: "Fiscal Periods", icon: "periods" },
    ],
  },
  {
    title: "Cash and Bank",
    items: [
      { href: "/bank", label: "Bank and Cash Accounts", icon: "bank" },
      { href: "/cash", label: "Receipts and Disbursements", icon: "cash" },
      { href: "/cash?status=PENDING_APPROVAL", label: "Voucher Approvals", icon: "voucher-approvals", perm: "journal.post" },
      { href: "/cash/petty", label: "Petty Cash", icon: "petty-cash" },
      { href: "/cash/checks", label: "Check Monitoring", icon: "checks" },
      { href: "/bank/statements", label: "Bank Statements", icon: "statements" },
      { href: "/bank/reconcile", label: "Bank Reconciliation", icon: "reconcile" },
    ],
  },
  {
    title: "Receivables and Billing",
    items: [
      { href: "/receivables", label: "Sales Invoices", icon: "receivables" },
      { href: "/receivables?status=PENDING_APPROVAL", label: "Invoice Approvals", icon: "approvals", perm: "journal.post" },
      { href: "/receivables?kind=CREDIT_MEMO", label: "Credit Memos", icon: "journal" },
      { href: "/receivables/collections", label: "Collections", icon: "cash" },
      { href: "/receivables/aging", label: "Customer Aging", icon: "activity" },
      { href: "/receivables/statement", label: "Statements of Account", icon: "statements" },
      { href: "/receivables/billing", label: "Contract Billing", icon: "recurring" },
      { href: "/receivables/series", label: "BIR Invoice Series", icon: "bir" },
    ],
  },
  {
    title: "Purchasing",
    items: [
      { href: "/purchasing/requests", label: "Purchase Requests", icon: "journal-new" },
      { href: "/purchasing/rfq", label: "RFQ / Canvass", icon: "activity" },
      { href: "/purchasing/orders", label: "Purchase Orders", icon: "cart" },
      { href: "/purchasing/receipts", label: "Receiving Reports", icon: "receive" },
    ],
  },
  {
    title: "Payables",
    items: [
      { href: "/ap/inbox", label: "AP Invoice Inbox", icon: "inbox" },
      { href: "/ap/bills", label: "Supplier Bills", icon: "payables" },
      { href: "/ap/approvals", label: "Purchasing and AP Approvals", icon: "approvals" },
      { href: "/ap/schedule", label: "Payment Schedule", icon: "periods" },
      { href: "/ap/payments", label: "Payment Vouchers", icon: "cash-out" },
      { href: "/ap/aging", label: "AP Aging", icon: "aging" },
      { href: "/ap/2307", label: "BIR 2307 Certificates", icon: "bir" },
    ],
  },
  {
    title: "Debt",
    items: [
      { href: "/debt", label: "Loans and Borrowings", icon: "debt" },
      { href: "/debt/period-end", label: "Debt Period-end Run", icon: "periods", perm: "journal.post" },
      { href: "/debt/reports/schedule", label: "Debt Schedule", icon: "gl-listing" },
      { href: "/debt/reports/aging", label: "Debt Aging and Maturity", icon: "activity" },
      { href: "/debt/reports/covenants", label: "Covenant Monitoring", icon: "ratio" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { href: "/inventory", label: "Stock Status", icon: "inventory" },
      { href: "/inventory/transactions", label: "Inventory Transactions", icon: "journal" },
      { href: "/inventory/transactions/new?type=RECEIPT", label: "Receive Stock", icon: "journal-new", perm: "inventory.transact" },
      { href: "/inventory/transactions?status=PENDING_APPROVAL", label: "Adjustment Approvals", icon: "approvals", perm: "inventory.approve" },
      { href: "/inventory/counts", label: "Cycle and Physical Counts", icon: "checks" },
      { href: "/inventory/reports/valuation", label: "Inventory Valuation", icon: "balance-sheet" },
      { href: "/inventory/reports/aging", label: "Inventory Aging", icon: "periods" },
      { href: "/inventory/reports/slow-moving", label: "Slow Moving Inventory", icon: "activity" },
      { href: "/inventory/reports/turnover", label: "Inventory Turnover", icon: "ratio" },
      { href: "/inventory/labels", label: "Barcode Labels", icon: "products" },
    ],
  },
  {
    title: "Expense and Mobility",
    items: [
      { href: "/expenses", label: "Mobility Dashboard", icon: "mobility" },
      { href: "/expenses/claims", label: "Expense Claims", icon: "claims" },
      { href: "/expenses/claims?q=manager", label: "Manager Approvals", icon: "approvals" },
      { href: "/expenses/claims?q=finance", label: "Finance Review", icon: "audit", perm: "expense.finance" },
      { href: "/expenses/reimbursements", label: "Reimbursements", icon: "wallet" },
      { href: "/expenses/reconcile", label: "Wallet and Card Recon", icon: "reconcile" },
      { href: "/expenses/report", label: "Employee Expense Report", icon: "employees" },
      { href: "/expenses/settings", label: "Mobility Settings", icon: "settings" },
    ],
  },
  {
    title: "Payroll and HR",
    items: [
      { href: "/payroll", label: "Payroll Runs", icon: "payroll", perm: "payroll.process" },
      { href: "/payroll/employees", label: "Employees and Pay", icon: "employees", perm: "payroll.process" },
      { href: "/payroll/2316", label: "BIR 2316", icon: "bir", perm: "payroll.approve" },
      { href: "/payroll/reports", label: "Payroll Reports", icon: "budget", perm: "payroll.process" },
      { href: "/hr/requests", label: "Leave, OT and Time Requests", icon: "approvals", perm: "hr.manage" },
      { href: "/hr/time", label: "Time Records", icon: "periods", perm: "hr.manage" },
      { href: "/hr", label: "Schedules, Holidays, Leave", icon: "settings", perm: "hr.manage" },
      { href: "/portal", label: "My Employee Portal", icon: "users" },
    ],
  },
  {
    title: "Fixed Assets",
    items: [
      { href: "/assets", label: "Asset Register", icon: "fixed-assets" },
      { href: "/assets/new", label: "New Asset", icon: "journal-new", perm: "journal.post" },
      { href: "/assets/depreciation", label: "Monthly Depreciation", icon: "recurring" },
      { href: "/assets/stickers", label: "QR Stickers", icon: "asset-audit" },
      { href: "/assets/audits", label: "Asset Counts", icon: "audit" },
      { href: "/assets/reports/schedule", label: "Depreciation Schedule", icon: "activity" },
      { href: "/assets/reports/rollforward", label: "Asset Rollforward", icon: "balance-sheet" },
      { href: "/assets/reports/disposals", label: "Disposal Report", icon: "cash-out" },
      { href: "/masters/asset-categories", label: "Asset Categories", icon: "dimensions" },
    ],
  },
  {
    title: "Leases (PFRS 16)",
    items: [
      { href: "/leases", label: "Lease Register", icon: "leases" },
      { href: "/leases/new", label: "New Lease", icon: "journal-new", perm: "journal.create" },
      { href: "/leases/post", label: "Post Lease Entries", icon: "recurring", perm: "journal.post" },
      { href: "/leases/reports/rou-rollforward", label: "ROU Asset Rollforward", icon: "activity" },
      { href: "/leases/reports/liability-schedule", label: "Lease Liability Schedule", icon: "ledger" },
      { href: "/leases/reports/interest", label: "Interest Expense Schedule", icon: "ratio" },
      { href: "/leases/reports/maturity", label: "Maturity Analysis", icon: "periods" },
    ],
  },
  {
    title: "Reports",
    items: [
      { href: "/reports/custom", label: "Custom Reports", icon: "report-builder" },
      { href: "/trial-balance", label: "Trial Balance", icon: "trial-balance" },
      { href: "/reports/balance-sheet", label: "Balance Sheet", icon: "balance-sheet" },
      { href: "/reports/income-statement", label: "Income Statement", icon: "income-statement" },
      { href: "/reports/cash-flow", label: "Cash Flow", icon: "cash-flow" },
      { href: "/reports/gl-listing", label: "General Ledger Listing", icon: "gl-listing" },
      { href: "/ledger", label: "Account Ledger", icon: "ledger" },
      { href: "/reports/account-activity", label: "Account Activity", icon: "activity" },
      { href: "/reports/budget-vs-actual", label: "Budget vs Actual", icon: "budget" },
      { href: "/reports/consolidated", label: "Consolidated TB", icon: "consolidated" },
    ],
  },
  {
    title: "Master Lists",
    items: MASTER_KINDS.filter((k) => k !== "assets" && k !== "asset-categories").map((k) => ({ href: `/masters/${k}`, label: MASTERS[k].title, icon: MASTER_ICON[k] ?? "dimensions" })),
  },
  {
    title: "Settings",
    items: [
      { href: "/entities", label: "Entities and Intercompany", icon: "entities" },
      { href: "/settings", label: "Company Settings", icon: "settings", perm: "org.manage" },
      { href: "/settings/approvals", label: "Approval Matrix", icon: "approvals", perm: "org.manage" },
      { href: "/ap/inbox/setup", label: "AP Invoice Email", icon: "inbox", perm: "org.manage" },
      { href: "/users", label: "Users and Roles", icon: "users", perm: "users.manage" },
      { href: "/audit", label: "Audit Trail", icon: "audit", perm: "org.manage" },
    ],
  },
];

export const COMING_NEXT: { label: string; icon: IconName }[] = [
  { label: "Prepaid expenses", icon: "prepaid" },
  { label: "BIR reports", icon: "bir" },
];

export function navFor(role: Role): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(role, i.perm as Permission)) }));
}
