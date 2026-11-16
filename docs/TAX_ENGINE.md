# BIR tax engine

Code: `src/lib/tax/`. Pages: **BIR Tax** in the side menu (`/tax/*`). Downloads: `/api/tax/download`.

## How tax data gets in
Every taxable amount is a **tax line**: output VAT, input VAT, expanded or final tax we withheld (EWT/FWT),
income tax / VAT / percentage tax a customer withheld from us (2307 received), or percentage tax on sales.

1. **Sub-ledgers feed it.** In the same transaction that posts the GL entry, call

   ```ts
   import { recordTaxEntries } from "@/lib/tax/feed";
   await recordTaxEntries(tx, {
     organizationId, userId, journalEntryId: entry.id, source: "SALES", sourceId: invoice.id,
     entries: [{ kind: "OUTPUT_VAT", ref: "1", date: invoiceDate, taxBase: "100000.00", taxAmount: "12000.00", rate: 12,
                 vatClass: "VATABLE", docType: "SI", docNumber: "0001", party: { type: "CUSTOMER", id: customerId } }],
   });
   ```
   Re-calling it for the same `source` + `sourceId` replaces that document's rows. Rows count only while their journal
   entry is posted and not reversed, so voids and reversals drop out by themselves.
   - AR: `OUTPUT_VAT` per invoice line (VATABLE / GOVERNMENT / ZERO_RATED / EXEMPT), `CWT` / `VAT_WITHHELD` when the customer's 2307 is recorded, `PERCENTAGE` for non-VAT sellers.
   - AP: `INPUT_VAT` per bill line (CAPITAL_GOODS / GOODS / SERVICES / IMPORT_GOODS / SERVICES_NONRESIDENT / NOT_QUALIFIED / EXEMPT / ZERO_RATED), `EWT` or `FWT` with the ATC when withholding on payment or accrual.
   - Payroll: register a `CompensationFeed` (`src/lib/tax/types.ts`) for 1601-C, 1604-C and BIR 2316.
2. **Built-in adapters** read modules that already hold tax data: cash receipts/disbursements (EWT withheld, CWT received)
   and petty cash vouchers (input VAT, EWT). If a module feeds its own rows for a document, the adapter skips it.
3. **Tax review** lists every GL line on a tax account that nothing explained (manual journals, a cash voucher's
   Input VAT line) so a person classifies it, or marks it "not a tax transaction".

The overview compares the tax ledger with the GL tax accounts per quarter.

## Returns and lists
| Output | Built from | Notes |
|---|---|---|
| 2550Q, 2550M (optional since 2023, RMC 52-2023) | OUTPUT_VAT, INPUT_VAT, VAT_WITHHELD | carry-over from the last filed return; filing can post the VAT closing entry |
| 2551Q | PERCENTAGE, PT_WITHHELD | falls back to 3% of GL revenue (Sec. 116) when no sales feed exists |
| 0619-E / 1601-EQ, 0619-F / 1601-FQ | EWT / FWT by ATC | quarterly less the filed 0619 remittances |
| SLSP (RELIEF S and P DAT) | VAT lines by TIN | RR 1-2017, quarterly |
| QAP (1601-EQ / 1601-FQ DAT), SAWT (2550Q / 2551Q / 1702Q DAT) | withholding by payee/agent + ATC | |
| 1604-E / 1604-F DAT, 1604-C | yearly withholding; payroll feed | |
| BIR 2307 | EWT by payee, by month of quarter | printable + CSV |
| Books of accounts | posted journals | General Journal, Cash Receipts, Cash Disbursements, Sales, Purchase (RR 9-2009) |

Deadlines are in `src/lib/tax/periods.ts` with their legal basis.

## DAT file layouts
`src/lib/tax/dat.ts` writes the layouts of the BIR RELIEF and Alphalist Data Entry modules (comma-separated, quoted upper-case
text, 2-decimal amounts, header / detail / control records). BIR does not publish them as a stable spec, so **run each
file through the BIR validation module before the first real submission**; any layout change is made in that one file.
