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

## What's in Phase 6: Inventory and warehouse (PAS 2)
**Master data** (Master Lists, Excel upload): Products and Prices gains Track Inventory, category, barcode, costing method, standard cost, reorder point and quantity, default warehouse / bin / vendor, inventory GL account and COGS account. New lists: Warehouses (optionally tagged to a branch) and Warehouse Locations (bins).

**Costing** (`src/lib/inventory/engine.ts`): FIFO, moving weighted average per warehouse, and specific identification by lot / serial no. (no LIFO). Every inbound quantity is a cost layer keeping its receipt date through transfers; taking the last unit always takes the exact remaining value; stock can never go negative.

**Documents** (draft → post; adjustments need approval with segregation of duties), each posting to the GL as source INVENTORY:
- Receipt RR: Dr Inventory / Cr Goods Received Not Yet Invoiced (or a chosen account)
- Issue IS: Dr COGS (item's account, or a chosen expense account with dimensions) / Cr Inventory
- Transfer ST between warehouses or bins: no GL, cost and age move with the stock
- Adjustment IA (+/−): against 5030 Inventory Losses and Count Adjustments
- Customer return CRT (Dr Inventory / Cr COGS) and return to vendor VRT (Dr GRNI or AP / Cr Inventory)
- Void restores the stock and reverses the GL entry (a receipt only while its stock is unused); inventory GL entries cannot be reversed from the journal screen.

**Counts**: cycle counts (by category, bin or items) and full physical counts with a printable, optionally blind count sheet; items found can be added; variances post as one approved adjustment.

**Reports**: stock status with bins/lots and reorder flags, inventory valuation as of any date reconciled to the inventory GL accounts, aging by receipt date, slow-moving / non-moving, turnover and days on hand, and a stock card per item. **Barcodes**: scan box on every document (USB/Bluetooth scanners), printable Code 128 labels.

**Hooks for Purchasing and Sales** (`src/lib/inventory/hooks.ts`): `receiveGoodsTx`, `issueGoodsTx`, `returnFromCustomerTx`, `returnToVendorTx`, `voidBySourceTx`, `onHand`. Call them inside your own transaction; documents they create can only be voided from the source document.

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

## Debt: loans and borrowings
**Loan master** (Debt → Loans and Borrowings): loan number, lender (optionally linked to a vendor), loan type (term loan, revolving line, notes payable, related party), original principal or credit limit, rate (fixed or floating) and day count (Actual/365, Actual/360, 30/360), start, first payment and maturity dates, payment terms (monthly to annual or single payment; equal installments, equal principal, or bullet; principal grace months), and the current portion, non-current portion, interest expense, accrued interest and (optional) unamortized transaction cost accounts.

**Transactions** (all post to the GL as source DEBT; undo is only from the loan page):
- Drawdown: bank receives the proceeds net of transaction costs; the loan is credited and split into current / non-current; the repayment schedule and effective interest rate are computed from the drawdown date. Revolving lines can be drawn again up to the limit.
- Interest accrual by the effective interest method (PFRS 9): expense at the EIR on the carrying amount, payable at the contract rate, the difference amortizes the transaction costs.
- Principal and interest payments create a **cash disbursement voucher** (approval workflow, checks, bank reconciliation). Interest is accrued to the payment date first; principal settles the current portion first; the loan updates when the voucher is posted or voided. Fully repaid loans are settled and leftover costs written off.
- Period-end run: accrues every loan to the date, then moves principal due within 12 months from non-current to current (PAS 1). An unwaived covenant breach at the date makes the whole loan current.
- Modification: PFRS 9 10% test. Non-substantial: carrying amount adjusted to the new cash flows at the original EIR, gain or loss recognized, fees amortized. Substantial: old loan derecognized, unamortized costs and fees expensed. Floating-rate resets and re-amortization after a prepayment change the EIR going forward with no gain or loss.

**Reports**: debt schedule with GL agreement per account, debt aging (contractual maturity buckets with undiscounted interest per PFRS 7, and past-due installments by days), amortization table per loan (contract and EIR columns, paid / overdue status), covenant monitoring (current ratio, debt to equity, liabilities to equity, interest coverage, DSCR, net debt to EBITDA, minimum net worth, or a manual value; pass / watch / breach / waived).

Loans are in the company's base currency for now. Code: `src/lib/debt/schedule.ts` (pure schedule and EIR math), `src/lib/debt/service.ts`.

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
- Purchasing and payables: `src/lib/purchasing/service.ts`, `src/lib/ap/` (bills, payments, aging, inbox, pure math in `compute.ts`) and `src/lib/approvals.ts` (approval matrix, reusable by other documents). AP payments post through `postSubledgerDisbursementTx` in cash.ts, so they show in check monitoring and bank reconciliation.

## Payroll and HR
**Payroll** (Payroll and HR → Payroll Runs). Computed per the Labor Code, BIR and statutory agencies (tables in `src/lib/payroll/rates.ts`; review them before each year's first payroll):
- Monthly or daily paid; daily rate = monthly x 12 / work days per year (261, 313, 365)
- Overtime 125%, rest day and special day 130% (OT 169%), special day on rest day 150%, regular holiday 200% (OT 260%), regular holiday on rest day 260%, double holiday 300%/390%; unworked regular holiday paid for daily-paid; night differential 10% for 10 PM to 6 AM; absences, unpaid leave, tardiness and undertime
- SSS (15%: 5% employee, 10% employer, MSC P5,000-35,000, MPF above P20,000, EC), PhilHealth 5% (floor P10,000, ceiling P100,000), Pag-IBIG (fund salary up to P10,000), deducted on the whole month in the run that ends the month
- BIR withholding tax on compensation (TRAIN tables, semi-monthly or monthly), minimum wage earner exemption, de minimis ceilings (RR 29-2025), 13th month and other benefits exempt up to P90,000, year-end annualization with refund of over-withholding
- 13th month pay runs (1/12 of basic salary earned in the year) and special bonus runs; recurring allowances, loans (stop at zero balance), garnishments and employer benefits (HMO, insurance, retirement); one-time adjustments per run
- Workflow: compute → submit for review → reviewer ticks each payslip → finalize (someone other than the preparer) posts the payroll accrual to the GL (source PAYROLL: salaries, overtime, bonuses, allowances, employer contributions by department and cost center; SSS/PhilHealth/Pag-IBIG/withholding tax/loan liabilities; net pay per employee to Salaries Payable) → release payslips to the employee portal → record the salary payment from a bank account (Dr Salaries Payable, Cr bank, ready for bank reconciliation). Void reverses the GL until payslips are released.
- BIR Form 2316 per employee per year from finalized payrolls: prepare drafts → review → finalize → release to the employee portal
- PDF only: payslips, payroll register, labor cost by department, withholding tax and contributions (1601-C and remittance basis), employee earnings summary, BIR 2316, attendance and leave reports

**HR and employee portal** (`/portal`; employees sign in with the normal login and land there):
- Time in / time out (night shifts that end the next day are handled), daily time record
- Requests routed to the reporting manager (or HR if none): leave (VL, SL, EL, SIL, maternity, paternity, solo parent, VAWC, special leave for women, bereavement, leave without pay; balances checked, half days), overtime, time amendment (corrects the time log on approval), change of shift or rest day
- Managers see "My team": pending approvals, team attendance, team attendance and leave PDFs
- HR setup: shifts with rest days and grace period, holidays (auto-load the national list: Proclamation 1006 for 2026, computed for later years; add Eid'l Fitr / Eid'l Adha and local holidays manually), leave types and yearly credits, manual time entries, portal logins
- Only approved time, overtime, leave and schedule changes feed payroll. Dates inside a finalized payroll can't be amended.

## Custom reports (report builder)
**Reports → Custom Reports.** Every report can be customized and saved: start from a template (or press **Customize** on any standard report) and change
- **Report type:** account balances (TB, account activity, budget vs actual, cost per department, expenses per employee/partner, your own statement layout), income statement, balance sheet, cash flow, GL lines, journal entries, aging (customers, vendors, employees).
- **Periods:** months, quarters, year to date, fiscal years, balances as of a date, or fixed dates. Periods are relative to the report date, so saved reports stay current. Add comparisons (change and %) between any two periods.
- **Columns:** side by side by entity/subsidiary or by any dimension (department, cost center, branch, project...), with a total. Amounts: opening, debit, credit, net movement, closing, budget, variance, variance %. Detail reports: pick, order, sort and subtotal columns.
- **Rows:** group by account, type, IFRS line, parent account, entity, party or any dimension (up to 4 levels with subtotals), or design your own rows from account ranges/lists/types and formulas (e.g. `REV - COS`).
- **Filters:** entities, specific accounts or code ranges, account types, IFRS lines, dimensions (by code, so they work across entities), source modules, customers/vendors/employees, entry status, text.
- **Save and share:** only me, whole company, by role, or specific people; optionally let them edit. Others can always run it and save their own copy. Export to Excel or print to PDF.

Access rules: a report is shared only inside its company, and each person only sees data for entities they are a member of.

For developers: definitions are JSON validated by `src/lib/reporting/definition.ts`. Each report type is a source in `src/lib/reporting/sources/`, listed in `catalog.ts` (what the builder shows) and `run.ts` (how it runs). Later modules (AR/AP invoices, payroll, fixed assets) add a source there and return the common `ReportResult` shape, and get columns, saving, sharing, Excel and printing for free.

## What's in Phase 9: BIR tax engine
VAT, expanded and final withholding, percentage tax, and taxes withheld by customers, kept in one tax ledger that AR, AP, payroll, cash vouchers and petty cash feed (see [docs/TAX_ENGINE.md](docs/TAX_ENGINE.md)).
- Returns: 2550Q, 2550M (optional), 2551Q, 0619-E / 1601-EQ, 0619-F / 1601-FQ, with manual items, record of filing (reference no., payment) and the 2550Q VAT closing entry
- Attachments: SLSP / RELIEF (sales and purchases DAT), QAP, SAWT, 1604-E and 1604-F alphalists (DAT and CSV), BIR 2307 certificates; 1604-C / 2316 hook for payroll
- Filing calendar with due dates, tax ledger vs GL tie-out, review screen for GL tax lines without details
- Books of accounts: General Journal, Cash Receipts, Cash Disbursements, Sales and Purchase journals (print / CSV)
