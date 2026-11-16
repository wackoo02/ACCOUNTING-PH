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
    title: "Fixed Assets",
    items: [
      { href: "/masters/assets", label: "Asset Register", icon: "fixed-assets" },
      { href: "/assets/stickers", label: "QR Stickers", icon: "asset-audit" },
      { href: "/assets/audits", label: "Asset Counts", icon: "audit" },
    ],
  },
  {
    title: "Reports",
    items: [
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
    items: MASTER_KINDS.filter((k) => k !== "assets").map((k) => ({ href: `/masters/${k}`, label: MASTERS[k].title, icon: MASTER_ICON[k] ?? "dimensions" })),
  },
  {
    title: "Settings",
    items: [
      { href: "/entities", label: "Entities and Intercompany", icon: "entities" },
      { href: "/settings", label: "Company Settings", icon: "settings", perm: "org.manage" },
      { href: "/users", label: "Users and Roles", icon: "users", perm: "users.manage" },
      { href: "/audit", label: "Audit Trail", icon: "audit", perm: "org.manage" },
    ],
  },
];

export const COMING_NEXT: { label: string; icon: IconName }[] = [
  { label: "Payables and aging", icon: "payables" },
  { label: "Payroll", icon: "payroll" },
  { label: "Depreciation and disposals", icon: "fixed-assets" },
  { label: "Prepaid expenses", icon: "prepaid" },
  { label: "Leases (PFRS 16)", icon: "leases" },
  { label: "Debt", icon: "debt" },
  { label: "BIR reports", icon: "bir" },
];

export function navFor(role: Role): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(role, i.perm as Permission)) }));
}
