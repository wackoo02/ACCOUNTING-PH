import { Logo } from "@/components/Logo";
import Link from "next/link";
import type { ReactNode } from "react";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ROLE_LABELS } from "@/lib/permissions";
import { MASTERS, MASTER_KINDS } from "@/lib/masters/config";
import { logout } from "../(auth)/actions";
import { changeCompany } from "./actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx();
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Logo dark /></div>
        {ctx.memberships.length > 1 ? (
          <form action={changeCompany} style={{ margin: "0 8px 8px" }}>
            <select name="organizationId" defaultValue={ctx.org.id}>
              {ctx.memberships.map((m) => <option key={m.organizationId} value={m.organizationId}>{m.name}</option>)}
            </select>
            <button className="secondary" style={{ marginTop: 6, width: "100%" }}>Switch company</button>
          </form>
        ) : (
          <div style={{ margin: "0 10px 8px", color: "#fff" }}>{ctx.org.name}</div>
        )}
        <div style={{ margin: "0 10px", fontSize: 12 }}>{ctx.user.name} · {ROLE_LABELS[ctx.role]}</div>
        <nav>
          <Link href="/dashboard">Dashboard</Link>
          <div className="sect">General Ledger</div>
          <Link href="/journals">Journal Entries</Link>
          {can(ctx.role, "journal.create") && <Link href="/journals/new">New Journal Entry</Link>}
          {can(ctx.role, "journal.post") && <Link href="/journals?status=PENDING_APPROVAL">Approvals</Link>}
          <Link href="/recurring">Recurring Entries</Link>
          <Link href="/allocations">Allocations</Link>
          <Link href="/intercompany">Intercompany</Link>
          <Link href="/fx">FX Revaluation</Link>
          <Link href="/periods">Fiscal Periods</Link>
          <div className="sect">Cash and Bank</div>
          <Link href="/bank">Bank and Cash Accounts</Link>
          <Link href="/cash">Receipts and Disbursements</Link>
          {can(ctx.role, "journal.post") && <Link href="/cash?status=PENDING_APPROVAL">Voucher Approvals</Link>}
          <Link href="/cash/petty">Petty Cash</Link>
          <Link href="/cash/checks">Check Monitoring</Link>
          <Link href="/bank/statements">Bank Statements</Link>
          <Link href="/bank/reconcile">Bank Reconciliation</Link>
          <div className="sect">Reports</div>
          <Link href="/trial-balance">Trial Balance</Link>
          <Link href="/reports/balance-sheet">Balance Sheet</Link>
          <Link href="/reports/income-statement">Income Statement</Link>
          <Link href="/reports/cash-flow">Cash Flow</Link>
          <Link href="/reports/gl-listing">General Ledger Listing</Link>
          <Link href="/ledger">Account Ledger</Link>
          <Link href="/reports/account-activity">Account Activity</Link>
          <Link href="/reports/budget-vs-actual">Budget vs Actual</Link>
          <Link href="/reports/consolidated">Consolidated TB</Link>
          <div className="sect">Master Lists</div>
          {MASTER_KINDS.map((k) => <Link key={k} href={`/masters/${k}`}>{MASTERS[k].title}</Link>)}
          <div className="sect">Settings</div>
          <Link href="/entities">Entities and Intercompany</Link>
          {can(ctx.role, "org.manage") && <Link href="/settings">Company Settings</Link>}
          {can(ctx.role, "users.manage") && <Link href="/users">Users and Roles</Link>}
          {can(ctx.role, "org.manage") && <Link href="/audit">Audit Trail</Link>}
          <form action={logout}><button className="link" style={{ color: "#cfd8e3", padding: "7px 10px" }}>Sign out</button></form>
          <div className="sect">Coming next</div>
          {["Receivables and aging", "Payables and aging", "Expense claims and mobility", "Payroll", "Fixed assets", "Prepaid expenses", "Leases (PFRS 16)", "Debt", "Inventory", "BIR reports"].map((m) => <div key={m} className="soon">{m}</div>)}
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
