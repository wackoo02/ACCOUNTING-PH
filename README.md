# Veritus ERP

_Intelligent. Integrated. Compliant._

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
**Petty cash (mobile app API)**: funds, vouchers from receipt photos (AI reads supplier, TIN, items, VAT, tips and proposes the account), VAT/EWT computation, fixed asset threshold with approved PO, approvals, and replenishment batches that post a Petty Cash journal. See [docs/MOBILE_API.md](docs/MOBILE_API.md).

## Veritus Mobility app and Expense & Mobility (Phase 7, part)
**Mobile app** at `/m`: an installable web app (PWA). On iPhone open it in Safari → Share → Add to Home Screen; on Android Chrome offers "Install app". Same login as the web ERP. Tiles: Petty Cash, Travel (local and international, foreign receipts translated to English and converted at the day's rate), Transport (Grab, inDrive, JoyRide, Angkas, taxi), Sent Package (Lalamove, Transportify, couriers), Sales Invoice (scan an issued invoice and post the sale) and Asset Audit (scan QR stickers).

**One record per receipt**: every module and payer uses the same voucher table, so petty cash is never recorded twice. Receipts are read by AI or entered by hand when there is none; no VAT TIN on the receipt (or no receipt, or a foreign receipt) means non-VAT automatically.

**Workflow**: Draft → Submitted → Manager (business purpose, budget, cost center; the employee's supervisor or an approver) → Approved / Returned / Rejected → Finance (receipt, tax compliance, duplicates) → Cleared / Hold. Clearing posts the journal (source EXPENSE_CLAIM):
- Paid with corporate GCash / Maya / card: Dr expense / Cr the wallet or card account
- Paid by the employee: Dr expense / Cr Employee Reimbursements Payable; Reimbursements creates one disbursement voucher per employee to pay them back
- Petty cash fund: replenished in a batch as before

**GL mapping** (Mobility Settings, editable): business ride 6050 Transportation, client visit 6051 (selling), staff shuttle 6053 (admin), delivery 6052, inventory delivery 1205 Inventory in Transit, local / international travel 6050 / 6056.

**Reconciliation**: import the GCash, Maya or card statement in Bank Statements; Wallet and Card Recon auto-matches posted claims by amount and booking number; a charge with no claim is an exception that finance sends to the employee as a claim to complete.

**Reports**: Mobility Dashboard (transport, delivery, by department / employee / project / provider / payment, top travelers and delivery users, unapproved, unreconciled, travel budget vs actual) and the Employee Expense Report.

**Fixed assets (start)**: Fixed Asset Register master list, printable QR stickers, and asset counts scanned from the app (found / wrong location / unknown / missing, by location and category; closing marks unscanned assets missing). Depreciation and disposals come with the fixed asset module.

**What needs provider partnerships**: see Mobility Settings → Provider connections. Today Veritus works with statement / report imports and receipt capture. Pulling trips and orders automatically, booking from Veritus, or auto-paying needs a business account and API agreement with Grab for Business, Lalamove Business, Transportify, GCash for Business (Mynt) and Maya Business; direct card feeds need an agreement with the bank.

## Leases (PFRS 16 / IFRS 16, lessee)
**Lease register** (Leases → New Lease): lease number, lessor (vendor list or free text), lease type, asset, start and end dates, payment per period with frequency (monthly / quarterly / semi-annual / annual), in advance or in arrears, rent escalation (e.g. +5% every 12 months), incremental borrowing rate and the discount rate used, currency and rate, 12% VAT and EWT on payments, initial direct costs, advance rent, incentives, restoration cost, and the GL accounts (ROU asset, accumulated depreciation, current and non-current lease liability, interest, depreciation, payable, gain/loss). Saving calculates the liability, ROU asset and full monthly schedule before anything posts.

**Transactions** (all post to the GL as source LEASE; the preparer cannot approve their own lease):
- Commencement: Dr ROU asset, Cr lease liability (split current / non-current), Cr advance rent / payable for direct costs, Cr restoration provision
- Monthly (Leases → Post Lease Entries, at each month-end): interest on the liability, ROU depreciation, payment due to Accounts Payable tagged to the lessor (with input VAT and EWT for BIR 2307), current / non-current reclass; the fully depreciated ROU asset comes off at the end
- Modification (PFRS 16.44-46): renewal or shortening, new rent, revised rate, decrease in scope (with gain/loss); the liability is remeasured and the ROU asset adjusted, schedule recalculated from the effective date
- Early termination: interest and depreciation to the day, derecognition, termination penalty, gain or loss
- Undo last posting (reverses its GL entry); the journal screen cannot reverse lease entries on its own
- Short-term and low-value exemptions: straight-line rent with accrued/prepaid rent
- Existing leases at go-live: balances taken up at the go-live date against an offset account

**Reports**: ROU asset rollforward, lease liability schedule (rollforward with current / non-current, plus each lease's amortization table), interest expense schedule by month (posted and still to come), maturity analysis of undiscounted payments reconciled to the liability (PFRS 16.58 / PFRS 7.39).

**Method**: discount rate ÷ 12 compounded monthly (equals Excel `=PV(rate/12, n, -payment, 0, 1)` for an advance lease starting on the 1st), interest summarised per calendar month with part months by days, straight-line depreciation over the term (or useful life when ownership transfers). Code: `src/lib/leases/` (`engine.ts` is the pure calculation, `service.ts` the postings, `reports.ts` the reports). Not yet: Excel upload of leases, unwinding of the restoration provision (PAS 37). For a foreign-currency lease, give the liability account that currency so FX revaluation picks it up.

## Design notes for later modules
- **One entry point:** `src/lib/ledger/service.ts` → `recordJournal({ source, sourceId, lines, action })`. Sub-ledgers pass their own `source` (SALES, PURCHASES, BANK, PAYROLL, EXPENSE_CLAIM, FIXED_ASSETS, …) and skip the manual approval controls.
- Find control accounts with `accountByRole(org, "AR_CONTROL")` etc., never hard-coded codes.
- Lines carry `partyType`/`partyId` (customer, vendor, employee, partner) for aging and expense-per-person reports, and `clearedAt`/`clearingRef` for bank reconciliation and transaction clearing.
- All money math is in integer centavos (`src/lib/money.ts`).
- Cash and bank: `src/lib/bank/cash.ts` (vouchers), `src/lib/bank/recon.ts` (statements, matching, reconciliation), `src/lib/bank/match.ts` (pure matching rules). AR collections and AP payments can create cash vouchers or post BANK entries; anything posted to a bank's GL account shows up for matching automatically.
