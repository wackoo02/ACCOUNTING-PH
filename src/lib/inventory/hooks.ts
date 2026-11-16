// Entry points for other modules. Call these inside your own prisma.$transaction so the stock
// movement, its GL entry and your document commit (or fail) together.
//
// Purchasing / AP (goods receipt against a PO):
//   const rr = await receiveGoodsTx(tx, { organizationId, userId, date, warehouseId, reference: po.number,
//     partyType: "VENDOR", partyId: vendor.code, sourceModule: "PURCHASES", sourceId: goodsReceipt.id,
//     lines: [{ itemId, qty: "10", unitCost: "125.50" }] });
//   -> posts Dr Inventory / Cr Goods Received Not Invoiced (role GRNI). The supplier invoice later
//      posts Dr GRNI (+ Input VAT) / Cr AP. Pass offsetAccountId to credit another account instead.
//      Any price difference between the receipt and the invoice is the AP module's to book
//      (to inventory while the stock is still on hand, otherwise to COGS).
//
// Sales / AR (delivery or invoice of stocked items):
//   const is = await issueGoodsTx(tx, { organizationId, userId, date, warehouseId, reference: invoice.number,
//     partyType: "CUSTOMER", partyId: customer.code, sourceModule: "SALES", sourceId: invoice.id,
//     lines: [{ itemId, qty: "2" }] });          // add lotNo for specific-identification items
//   -> posts Dr COGS (item's COGS account) / Cr Inventory, and returns the cost of each line in centavos.
//
// Returns: returnFromCustomerTx (credit memo) and returnToVendorTx (debit memo) work the same way.
// Undo: voidBySourceTx(tx, organizationId, userId, "SALES", invoice.id, "Invoice cancelled").
// Stock lookups for availability checks: onHand(organizationId, itemId, warehouseId?).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError } from "../ledger/service";
import { createAndPostTx, voidInventoryTx, type InvInput, type InvLineInput } from "./service";
import { cents, toQty } from "./qty";

type Tx = Prisma.TransactionClient;
type HookInput = Omit<InvInput, "type" | "action" | "toWarehouseId" | "countId" | "lines"> & { sourceModule: string; sourceId: string; lines: InvLineInput[] };

export const receiveGoodsTx = (tx: Tx, input: HookInput) => createAndPostTx(tx, { ...input, type: "RECEIPT" });
export const issueGoodsTx = (tx: Tx, input: HookInput) => createAndPostTx(tx, { ...input, type: "ISSUE" });
export const returnFromCustomerTx = (tx: Tx, input: HookInput) => createAndPostTx(tx, { ...input, type: "RETURN_IN" });
export const returnToVendorTx = (tx: Tx, input: HookInput) => createAndPostTx(tx, { ...input, type: "RETURN_OUT" });

/** Void every inventory document a source document created (e.g. a cancelled invoice). */
export async function voidBySourceTx(tx: Tx, organizationId: string, userId: string, sourceModule: string, sourceId: string, reason: string, date?: Date) {
  const docs = await tx.inventoryTransaction.findMany({ where: { organizationId, sourceModule, sourceId, status: { not: "VOID" } }, orderBy: { createdAt: "desc" } });
  for (const d of docs) await voidInventoryTx(tx, organizationId, userId, d.id, reason, date, true);
  return docs.length;
}

/** Quantity and value on hand now, per warehouse. */
export async function onHand(organizationId: string, itemId: string, warehouseId?: string) {
  const rows = await prisma.inventoryBalance.findMany({ where: { organizationId, itemId, ...(warehouseId ? { warehouseId } : {}) } });
  return rows.map((r) => ({ warehouseId: r.warehouseId, qty: toQty(r.qty), value: cents(r.value) }));
}

/** Throws unless the item is a stocked inventory item of this company. */
export async function assertStockItem(organizationId: string, itemId: string) {
  const i = await prisma.product.findFirst({ where: { id: itemId, organizationId } });
  if (!i?.isStocked) throw new LedgerError(["Not an inventory item"]);
  return i;
}
