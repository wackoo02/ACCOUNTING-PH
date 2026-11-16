import type { IconName } from "@/lib/icons";
import type { Role } from "@prisma/client";
import { can, type Permission } from "@/lib/permissions";
import { MASTERS, MASTER_KINDS } from "@/lib/masters/config";

import type { NavItem, NavSection } from "@/lib/nav-match";
export type { NavItem, NavSection };

const MASTER_ICON: Record<string, IconName> = {
  accounts: "accounts", dimensions: "dimensions", taxes: "taxes", banks: "banks", products: "products",
  employees: "employees", vendors: "vendors", customers: "customers", currencies: "currencies",
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
    items: MASTER_KINDS.map((k) => ({ href: `/masters/${k}`, label: MASTERS[k].title, icon: MASTER_ICON[k] ?? "dimensions" })),
  },
  {
    title: "Settings",
    items: [
      { href: "/entities", label: "Entities and Intercompany", icon: "entities" },
      { href: "/settings", label: "Company Settings", icon: "settings", perm: "org.manage" },
      { href: "/settings/approvals", label: "Approval Matrix", icon: "approvals", perm: "org.manage" },
      { href: "/users", label: "Users and Roles", icon: "users", perm: "users.manage" },
      { href: "/audit", label: "Audit Trail", icon: "audit", perm: "org.manage" },
    ],
  },
];

export const COMING_NEXT: { label: string; icon: IconName }[] = [
  { label: "Receivables and aging", icon: "receivables" },
  { label: "Expense claims and mobility", icon: "mobility" },
  { label: "Payroll", icon: "payroll" },
  { label: "Fixed assets", icon: "fixed-assets" },
  { label: "Prepaid expenses", icon: "prepaid" },
  { label: "Leases (PFRS 16)", icon: "leases" },
  { label: "Debt", icon: "debt" },
  { label: "Inventory", icon: "inventory" },
  { label: "BIR reports", icon: "bir" },
];

export function navFor(role: Role): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(role, i.perm as Permission)) }));
}
