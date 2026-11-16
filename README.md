# PH Accounting — General Ledger, Cash and Bank (Phase 1–3)

Multi-company, web-based accounting for Philippine businesses. PFRS/IFRS-aligned general ledger that every later module (AR, AP, bank reconciliation, payroll, expense claims, fixed assets, leases, inventory, BIR) posts into.

## Stack
Next.js 15 (App Router, server actions) · TypeScript · PostgreSQL · Prisma · ExcelJS · Vitest

## Run locally
```bash
cp .env.example .env          # set DATABASE_URL and DATABASE_URL_UNPOOLED to a PostgreSQL database
npm install
npx prisma migrate deploy
npm run db:seed               # optional demo: owner@demo.ph / accountant@demo.ph / bookkeeper@demo.ph, password demo12345
npm run dev                   # http://localhost:3000
npm test                      # unit + integration tests (needs the database)
```

## Deploy to Vercel (with Neon PostgreSQL)
1. On vercel.com, sign in with GitHub and **Add New → Project → import `accounting-ph`**. Don't deploy yet if it asks; open the project.
2. **Storage → Create Database → Neon (Postgres)**, choose the Singapore region, and connect it to the project. This adds `DATABASE_URL` and `DATABASE_URL_UNPOOLED` automatically.
3. Optional for a test site: **Settings → Environment Variables →** `SEED_DEMO` = `true` to load the demo companies.
4. **Deployments → Redeploy.** The build runs the database migrations, then starts the app.

Turn `SEED_DEMO` off and change or remove the demo users before real company data goes in.

## What's in Phase 1–2
**Foundation**
- Companies/entities with parent–subsidiary hierarchy, company code, TIN/RDO, fiscal year start month
- Users, roles (Owner, Admin, Accountant, Bookkeeper, Viewer), per-user approval limits
- Controls: approval workflow, segregation of duties, accounts restricted to sub-ledger posting
- Chart of accounts (PH template, ~110 accounts, IFRS line items, current/non-current, system roles for sub-ledgers)
- 9 dimensions on every line: department, branch, business unit, project, cost center, profit center, location, product line, division
- Tax codes: VAT, EWT (with BIR ATCs), FWT, percentage tax
- Currencies with rates
- Master lists (accounts, dimensions, tax codes, products/prices, employees, vendors, customers, currencies): Excel template download, export, bulk upload (all-or-nothing validation), manual add/edit — admins only
- Audit trail with before/after values on every change

**General ledger**
- Journal entries: number, posting date, transaction date, narration, reference, source module, currency + rate (forex and PHP amounts per line), dimensions, supporting-document links, prepared/approved by
- Draft → submitted → approved/posted; return to preparer with reason; posted entries corrected only by reversal
- Recurring entries, percentage allocations
- Intercompany: auto Due from/Due to setup, one transaction posts in both entities, reconciliation, eliminations
- Multi-currency: realized FX via settlement lines, unrealized FX revaluation with auto-reversal (PAS 21)
- Fiscal years and periods: open / closed / locked, year-end closing to retained earnings, owner-only reopen
- Budgets (Excel upload, monthly by account and optionally by dimension)

**Reports**: Trial balance, balance sheet, income statement, cash flow (indirect), GL listing, account ledger, account activity, budget vs actual, consolidated TB, KPI dashboard (revenue, gross margin, opex, net profit, current ratio, debt-to-equity, working capital, cash, budget variance, cost per department/project). All filterable by dimension; print to PDF from the browser.

## What's in Phase 3: Cash and treasury
**Bank and cash accounts** (Master Lists → Bank and Cash Accounts, admins only, Excel upload): bank current/savings, petty cash funds, cash on hand, e-wallets (GCash/Maya); each linked to its own GL cash account, with currency, bank details, next check number, petty cash custodian and fund amount.

**Cash vouchers** (all draft → for approval → posted, same segregation of duties and approval limits as journals; post to the GL as source BANK):
- Cash receipts (CR-), including tax withheld by the customer (BIR 2307 → Creditable Withholding Tax)
- Disbursements by cash, check, transfer or e-wallet (CD-), with expanded withholding tax by tax code (auto-computed, editable)
- Petty cash vouchers (PCV-): cannot exceed cash on hand; imprest replenishment (one transfer for all unreplenished vouchers)
- Fund transfers (FT-), including between currencies with realized FX gain/loss
- Party (customer/vendor/employee/partner) and dimensions on every line; void reverses the GL entry
- Printable voucher with prepared/approved/received signatures and audit trail

**Check monitoring**: every check by number with status unreleased / outstanding / stale (over 180 days) / cleared / void; mark released; check numbers are unique per bank account and auto-assigned from the checkbook.

**Bank reconciliation**
- Downloadable Excel statement template; upload checks beginning + lines = ending balance (and running balances), skips lines already uploaded
- Recommended matches against uncleared GL cash lines: check number, amount, reference, date proximity, and one deposit covering several receipts; high/medium matches pre-ticked
- Manual many-to-many matching with live totals; clear book lines without a statement line (opening balance, pre-go-live items) with a reason
- Record bank-initiated items (service charges, interest, final tax, returned checks) in the books with suggested accounts, cleared automatically
- Reconciliation report: balance per bank + deposits in transit − outstanding checks = balance per books ± bank items not yet booked; finalize when the difference is zero (locks its matches; owner/admin can reopen); nothing can be dated inside a finalized reconciliation

## Design notes for later modules
- **One entry point:** `src/lib/ledger/service.ts` → `recordJournal({ source, sourceId, lines, action })`. Sub-ledgers pass their own `source` (SALES, PURCHASES, BANK, PAYROLL, EXPENSE_CLAIM, FIXED_ASSETS, …) and skip the manual approval controls.
- Find control accounts with `accountByRole(org, "AR_CONTROL")` etc., never hard-coded codes.
- Lines carry `partyType`/`partyId` (customer, vendor, employee, partner) for aging and expense-per-person reports, and `clearedAt`/`clearingRef` for bank reconciliation and transaction clearing.
- All money math is in integer centavos (`src/lib/money.ts`).
- Cash and bank: `src/lib/bank/cash.ts` (vouchers), `src/lib/bank/recon.ts` (statements, matching, reconciliation), `src/lib/bank/match.ts` (pure matching rules). AR collections and AP payments can create cash vouchers or post BANK entries; anything posted to a bank's GL account shows up for matching automatically.
