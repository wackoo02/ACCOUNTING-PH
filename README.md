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

## What's in Phase 5: Purchasing and Payables
**Purchasing**: purchase requests (draft → for approval → approved) → RFQ / canvass sheet (quotes from several suppliers side by side; awarding a quote that is not the lowest needs a reason) → purchase order with approval → receiving reports (partial deliveries; each posts Dr expense/inventory/asset, Cr Goods Received Not Yet Invoiced).

**Supplier bills (APV-)**: lines classified as expense, prepayment (with service period), fixed asset or inventory; VAT (inclusive or exclusive, zero-rated/exempt, non-VAT suppliers) and expanded withholding tax per line by tax code. Bills linked to a PO are 3-way matched: you cannot bill more than was received, the GRNI is cleared at PO cost and any price difference goes to the line's account. Fixed asset lines must come from an approved PO. The same supplier invoice number cannot be entered twice. Approval posts the bill to the GL.

**Approval matrix** (Settings → Approval Matrix, admins): levels per document (PR, PO, bill, payment) by amount, approved by a role or a named person. The preparer cannot approve and one person approves one level only. With no rules, one approval by an accountant/admin/owner within their approval limit.

**Payments (PV-)**: pay one or more bills of a supplier, by check, transfer or cash; the final approval releases the payment as a posted cash disbursement (next check number from the checkbook), printable check, voucher and **BIR Form 2307** per payment (and per quarter). Payment schedule with hold/release and a payment run that drafts one voucher per supplier. **AP aging** summary and detail by days past due or invoice date, tied to the AP control account in the GL.

**AP invoice inbox**: suppliers email PDF/JPG/PNG invoices to the company's inbox address (or staff upload them). AI reads the supplier, TIN, invoice number, dates, VAT, withholding and each line, classifies the lines, matches the supplier and an approved PO, and flags duplicates. Accounting staff review the document side by side with the proposed bill; nothing reaches the AP ledger until they save it and it passes the approval matrix.

Inbox email, per company: each company gets its own address, e.g. `demo-holdings-ap-7k2q@inbox.veritus.ph`. The company's own admin manages it in Settings → AP Invoice Email: change the inbox name, register their own AP mailbox (e.g. ap@client.ph, which they forward to the Veritus address), limit which senders are accepted, or turn email off. No developer steps are needed per company. A company with its own inbound-email service can use a private webhook instead (Advanced on the same page).

One-time setup for the whole Veritus service (platform operator only):
1. Pick a mail domain, e.g. `inbox.veritus.ph`, and point its MX record to Postmark (Postmark → Inbound → domain forwarding). Every address on it then reaches one Postmark inbound stream.
2. Set the stream's webhook URL to `https://veritus:<secret>@<your-app>/api/inbound/ap-email`. Emails are routed to the company by recipient address.
3. In Vercel set `AP_INBOX_DOMAIN` (e.g. inbox.veritus.ph), `INBOUND_WEBHOOK_SECRET` (the same random secret, 16+ characters) and `ANTHROPIC_API_KEY` (optional `AP_INVOICE_MODEL`). Without a key, documents still arrive and are keyed in by hand.

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

## What's in Phase 4: Receivables and billing
**Sales invoices and credit memos** (draft → for approval → issued; same approval limits and segregation of duties): VATable / zero-rated / VAT-exempt lines, prices with or without VAT, line discounts, products, revenue account and dimensions per line, foreign-currency customers, expected withholding by the customer (BIR 2307). Issuing posts Dr Accounts Receivable / Cr Sales + Output VAT (source SALES). A credit memo posts the reverse (Sales Returns) and is applied to the invoice it corrects. Non-VAT companies print NON-VAT and "not valid for claim of input tax".

**BIR invoice series** (Receivables → BIR Invoice Series): register each ATP / CAS / CRM-POS / EIS serial range with permit and printer details. Serials are assigned only when a document is approved, cancelled invoices keep their number, and posting stops when a range is used up.

**Collections**: cash or check received plus tax withheld (2307), applied to one or more open invoices (pay in full, oldest first, or by hand). Any excess becomes an advance (Advances from Customers) that can be applied later. Foreign-currency collections post the realized FX gain/loss. Voiding (e.g. bounced check) reopens the invoices and keeps the bank reconciliation clean.

**Reports**: customer aging summary and detail (by days past due or invoice date; not yet due, 1-30, 31-60, 61-90, 91-120, over 120), with a tie-out to the AR control and customer advances GL balances; statement of account per customer with aging.

**PDF and email**: BIR-format sales invoice, credit memo, collection receipt and statement PDFs (`/api/receivables/pdf`). Email to the customer's Invoice Emails with the PDF attached needs `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` on the server; every send is logged.

**Contract billing**: subscriptions and retainer contracts invoice every month/quarter/half/year (catching up missed periods, never billing a period twice); project contracts bill milestones by % or amount of the contract value. Hooks for POS (series type POS_INVOICE, invoice source POS) and scanned invoices (source SCAN) are in place.

## Design notes for later modules
- **One entry point:** `src/lib/ledger/service.ts` → `recordJournal({ source, sourceId, lines, action })`. Sub-ledgers pass their own `source` (SALES, PURCHASES, BANK, PAYROLL, EXPENSE_CLAIM, FIXED_ASSETS, …) and skip the manual approval controls.
- Find control accounts with `accountByRole(org, "AR_CONTROL")` etc., never hard-coded codes.
- Lines carry `partyType`/`partyId` (customer, vendor, employee, partner) for aging and expense-per-person reports, and `clearedAt`/`clearingRef` for bank reconciliation and transaction clearing.
- All money math is in integer centavos (`src/lib/money.ts`).
- Cash and bank: `src/lib/bank/cash.ts` (vouchers), `src/lib/bank/recon.ts` (statements, matching, reconciliation), `src/lib/bank/match.ts` (pure matching rules). AR collections and AP payments can create cash vouchers or post BANK entries; anything posted to a bank's GL account shows up for matching automatically.
- Purchasing and payables: `src/lib/purchasing/service.ts`, `src/lib/ap/` (bills, payments, aging, inbox, pure math in `compute.ts`) and `src/lib/approvals.ts` (approval matrix, reusable by other documents). AP payments post through `postSubledgerDisbursementTx` in cash.ts, so they show in check monitoring and bank reconciliation.
