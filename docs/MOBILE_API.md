# Petty Cash Mobile API

JSON API used by the Veritus petty cash app for iPhone and Android. Base path: `/api/mobile`.

- **Auth:** `POST /auth/login` returns a `token`. Send it as `Authorization: Bearer <token>` on every other call. Tokens last 30 days and use the same sessions table as the web login.
- **Company:** send `X-Company-Id: <companyId>` to work in a company other than the one chosen at sign-in.
- **Money:** strings with 2 decimals, in PHP (`"1170.00"`). Quantities can have up to 4 decimals.
- **Errors:** `{ "errors": ["..."] }` with 400 (bad JSON), 401 (sign in), 403 (no permission), 404, 422 (business rule, e.g. "enter an approved PO number").

## Who can do what

| Action | Owner | Admin | Accountant | Bookkeeper | Viewer |
|---|---|---|---|---|---|
| Capture receipts, create vouchers and POs | ✓ | ✓ | ✓ | ✓ | |
| Approve vouchers and POs | ✓ | ✓ | | | |
| Create replenishment batches | ✓ | ✓ | ✓ | ✓ | |
| Post the batch journal to the GL | ✓ | ✓ | ✓ | | |
| Set up funds | ✓ | ✓ | | | |

Approvals also apply the company's **segregation of duties** (the preparer cannot approve their own voucher, PO or batch journal) and each person's **approval limit** from Users and Roles.

## Rules the server enforces

- **VAT:** prices on the receipt are VAT-inclusive. If VAT is not entered it is computed as 12/112 of the VATable amount; a non-VAT supplier cannot carry input VAT. A VAT figure more than PHP 1.00 off from 12/112 is accepted with a warning.
- **EWT:** chosen by tax code (e.g. WC158 1%, WC160 2%) and computed on the amount net of VAT. Cash paid = receipt total + tip − EWT.
- **Tips:** recorded separately (printed or handwritten) and charged to the receipt's main expense account.
- **Fixed assets:** an item whose unit cost is at or above the company's **fixed asset threshold** (Company Settings, default PHP 5,000) and is marked as a fixed asset must use a property and equipment account and needs an **approved PO** whose amount covers it. A property and equipment account below the threshold is refused.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `{ token, expiresAt, user, companies }` |
| POST | `/auth/logout` | Ends this token |
| GET | `/me` | User, company, role, approval limit, `can` flags |
| GET | `/setup` | Threshold, expense and fixed asset accounts, EWT/VAT codes, suppliers, funds, approved POs, departments / cost centers / branches / projects |
| POST | `/funds` | Admin: `{ code, name, imprestAmount, custodianUserId?, accountId?, replenishAccountId? }` |
| POST | `/receipts` | `{ imageBase64, mediaType, extract? }` → stores the photo and (unless `extract: false`) returns what the AI read: supplier, TIN, address, items with suggested accounts, VAT, tip, amount paid. On failure returns `{ imageId, extractionError }` so the user can type it in. |
| POST | `/receipts/:imageId/extract` | Read a stored photo again |
| GET | `/receipts/:imageId/image` | The photo |
| POST | `/suggest-account` | `{ description }` → keyword-based account suggestion for manual entry |
| POST | `/vouchers/preview` | Validate and compute a voucher without saving: totals, VAT per line, EWT, cash paid, errors and warnings |
| GET | `/vouchers?status=SUBMITTED,APPROVED&fundId=&mine=1` | List |
| POST | `/vouchers` (`?submit=1` to submit at once) | Create |
| GET / PUT | `/vouchers/:id` | Read / edit a draft or returned voucher |
| POST | `/vouchers/:id/submit` | Send for approval |
| POST | `/vouchers/:id/approve` | Approve |
| POST | `/vouchers/:id/reject` | `{ reason }` → returned to the preparer |
| GET / POST | `/purchase-orders` | List (`?status=APPROVED`) / create `{ number?, poDate?, vendorId?, vendorName?, description, amount }` |
| POST | `/purchase-orders/:id/approve` | Approve |
| GET / POST | `/batches` | List / create a replenishment batch `{ fundId, voucherIds?, date? }` from approved vouchers |
| GET | `/batches/:id` | Batch summary report: totals, amounts by account, vouchers, and the journal entry |
| POST | `/batches/:id/post` | Approve and post the batch journal to the general ledger |

### Voucher body

```json
{
  "fundId": "…", "receiptDate": "2026-11-10", "docType": "OR", "docNumber": "004512",
  "vendorId": null, "vendorName": "Kusina ni Juan Inc.", "vendorTin": "123-456-789-00000",
  "vendorAddress": "Makati City", "vendorVatRegistered": true,
  "vatAmount": null, "vatExemptAmount": "0", "zeroRatedAmount": "0",
  "ewtTaxCodeId": null, "tipAmount": "50", "tipHandwritten": true, "poNumber": null,
  "departmentId": null, "costCenterId": null, "imageId": "…", "extraction": { "…": "AI output kept for audit" },
  "lines": [{ "description": "Team lunch", "quantity": "4", "unitPrice": "280", "accountId": "…", "suggestedAccountId": "…", "isFixedAsset": false }]
}
```

## Replenishment journal

Creating a batch posts a journal with source **Petty Cash** (number `PC-YYYY-######`) to the GL as *pending approval*. It is approved either with `POST /batches/:id/post` or from Journal Entries on the web, with the usual controls. The entry is:

| | Account | Amount |
|---|---|---|
| Dr | Each item's expense or property and equipment account | Amount net of VAT (tips added to the main expense line) |
| Dr | Input VAT (system role `INPUT_VAT`) | VAT per receipt |
| Cr | EWT payable (the tax code's account, else role `EWT_PAYABLE`) | EWT per supplier |
| Cr | The fund's replenishment account (default: the fund's own account, 1015 Petty Cash Fund) | Total cash paid out |

Lines carry the supplier (for reports by party) and the voucher's department, cost center, branch and project. Receipt photos are attached as supporting documents. When the journal is posted, the batch's vouchers become **Replenished**. If the fund's replenishment account is left as the fund account, the cash disbursement that refills the fund debits the fund and credits the bank.

## Setup

1. Set `ANTHROPIC_API_KEY` in the server's environment (Vercel → Settings → Environment Variables) to turn on receipt reading. `RECEIPT_MODEL` overrides the model.
2. Check the fixed asset threshold in Company Settings.
3. Create a petty cash fund (`POST /funds`, admins) for each custodian.
