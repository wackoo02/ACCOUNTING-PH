// Inventory (PAS 2) against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { voidOrReverse } from "@/lib/ledger/service";
import { importMasters, saveMaster } from "@/lib/masters/store";
import { approveInventory, ensureRoleAccount, rejectInventory, saveInventoryTransaction, voidInventory, type InvInput } from "@/lib/inventory/service";
import { createCount, postCount, saveCountSheet, submitCount } from "@/lib/inventory/counts";
import { issueGoodsTx, receiveGoodsTx, voidBySourceTx } from "@/lib/inventory/hooks";
import { aging, slowMoving, stockCard, stockStatus, turnover, valuation } from "@/lib/inventory/reports";

let org = "", owner = "", clerk = "", accountant = "";
let wh1 = "", wh2 = "", binA = "", binB = "";
const items: Record<string, string> = {};
const Y = 2026;
const d = (s: string) => new Date(`${Y}-${s}`);
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;

async function glBalance(code: string) {
  const a = await prisma.journalLine.aggregate({ where: { organizationId: org, accountId: await acct(code), journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true } });
  return Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0);
}
async function bal(item: string, wh = wh1) {
  const b = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId: items[item], warehouseId: wh } } });
  return { qty: Number(b?.qty ?? 0), value: Number(b?.value ?? 0) };
}
const doc = (type: InvInput["type"], lines: InvInput["lines"], extra: Partial<InvInput> = {}): InvInput => ({
  organizationId: org, userId: clerk, type, date: d("10-05"), warehouseId: wh1, memo: `${type} test`, lines, action: "post", ...extra,
});
const post = (type: InvInput["type"], lines: InvInput["lines"], extra: Partial<InvInput> = {}) => saveInventoryTransaction(doc(type, lines, extra));

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "Inventory Test Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: org, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: org, role: "ACCOUNTANT", approvalLimit: "500000" },
  ] });
  await importMasters("warehouses", org, owner, [{ code: "WH1", name: "Main" }, { code: "WH2", name: "Cebu" }]);
  await importMasters("locations", org, owner, [{ warehouseCode: "wh1", code: "A-01", name: "Rack A" }, { warehouseCode: "WH1", code: "B-01", name: "Rack B" }, { warehouseCode: "WH2", code: "A-01", name: "Rack A" }]);
  wh1 = (await prisma.warehouse.findFirstOrThrow({ where: { organizationId: org, code: "WH1" } })).id;
  wh2 = (await prisma.warehouse.findFirstOrThrow({ where: { organizationId: org, code: "WH2" } })).id;
  binA = (await prisma.warehouseLocation.findFirstOrThrow({ where: { warehouseId: wh1, code: "A-01" } })).id;
  binB = (await prisma.warehouseLocation.findFirstOrThrow({ where: { warehouseId: wh1, code: "B-01" } })).id;
  await importMasters("products", org, owner, [
    { code: "AVG", name: "Bond paper", kind: "GOODS", isStocked: true, costingMethod: "WEIGHTED_AVERAGE", category: "Paper", reorderPoint: "5", defaultWarehouseCode: "WH1", defaultLocationCode: "A-01", standardCost: "100" },
    { code: "FIFO", name: "Toner", kind: "GOODS", isStocked: true, costingMethod: "FIFO", category: "Supplies", barcode: "4800000000017" },
    { code: "SPEC", name: "Laptop", kind: "GOODS", isStocked: true, costingMethod: "SPECIFIC", category: "IT" },
    { code: "SVC", name: "Installation", kind: "SERVICE" },
  ]);
  for (const c of ["AVG", "FIFO", "SPEC", "SVC"]) items[c] = (await prisma.product.findFirstOrThrow({ where: { organizationId: org, code: c } })).id;
});

afterAll(async () => {
  await prisma.inventoryMove.deleteMany({ where: { organizationId: org } });
  await prisma.inventoryLayer.deleteMany({ where: { organizationId: org } });
  await prisma.inventoryBalance.deleteMany({ where: { organizationId: org } });
  await prisma.inventoryCount.deleteMany({ where: { organizationId: org } });
  await prisma.inventoryTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.warehouse.deleteMany({ where: { organizationId: org } });
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
  await prisma.$disconnect();
});

describe("item master", () => {
  it("validates inventory settings", async () => {
    await expect(importMasters("products", org, owner, [{ code: "X", name: "X", isStocked: true, inventoryAccountCode: "6010" }])).rejects.toThrow(/must be a postable asset/);
    await expect(importMasters("products", org, owner, [{ code: "X", name: "X", isStocked: true, defaultWarehouseCode: "NOPE" }])).rejects.toThrow(/warehouse NOPE not found/);
    await expect(importMasters("locations", org, owner, [{ warehouseCode: "NOPE", code: "Z", name: "Z" }])).rejects.toThrow(/warehouse NOPE not found/);
  });
});

describe("weighted average", () => {
  it("costs issues at the running average and empties to the exact value", async () => {
    await post("RECEIPT", [{ itemId: items.AVG, qty: "10", unitCost: "100" }], { date: d("10-01") });
    await post("RECEIPT", [{ itemId: items.AVG, qty: "10", unitCost: "130" }], { date: d("10-02") });
    expect(await bal("AVG")).toEqual({ qty: 20, value: 2300 });
    const is = await post("ISSUE", [{ itemId: items.AVG, qty: "4" }], { date: d("10-03") });
    expect(Number(is.totalValue)).toBe(460); // 4 x 115
    // Default location from the item master.
    expect((await prisma.inventoryLayer.findMany({ where: { itemId: items.AVG } })).every((l) => l.locationId === binA)).toBe(true);
    await post("RECEIPT", [{ itemId: items.AVG, qty: "3", unitCost: "33.333333" }], { date: d("10-04") });
    const b = await bal("AVG");
    expect(b.qty).toBe(19);
    const all = await post("ISSUE", [{ itemId: items.AVG, qty: "19" }], { date: d("10-06") });
    expect(Number(all.totalValue)).toBe(b.value);
    expect(await bal("AVG")).toEqual({ qty: 0, value: 0 });
  });
});

describe("FIFO", () => {
  it("consumes the oldest layers first", async () => {
    await post("RECEIPT", [{ itemId: items.FIFO, qty: "10", unitCost: "100", locationId: binA }], { date: d("10-01") });
    await post("RECEIPT", [{ itemId: items.FIFO, qty: "10", unitCost: "120", locationId: binB }], { date: d("10-02") });
    const is = await post("ISSUE", [{ itemId: items.FIFO, qty: "15" }], { date: d("10-07") });
    expect(Number(is.totalValue)).toBe(1600);
    expect(await bal("FIFO")).toEqual({ qty: 5, value: 600 });
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: is.journalEntryId! }, include: { lines: true } });
    expect(je.source).toBe("INVENTORY");
    expect(Number(je.lines.find((l) => l.accountId === je.lines.find((x) => Number(x.debit) > 0)!.accountId)!.debit)).toBe(1600);
  });

  it("never lets stock go negative", async () => {
    await expect(post("ISSUE", [{ itemId: items.FIFO, qty: "6" }])).rejects.toThrow(/only 5 on hand/);
    await expect(post("ISSUE", [{ itemId: items.FIFO, qty: "1", locationId: binA }])).rejects.toThrow(/only 0 on hand/);
    await expect(post("ISSUE", [{ itemId: items.SVC, qty: "1" }])).rejects.toThrow(/not an inventory item/);
  });

  it("transfers keep cost and age, with no GL entry", async () => {
    const st = await post("TRANSFER", [{ itemId: items.FIFO, qty: "2" }], { toWarehouseId: wh2, date: d("10-08") });
    expect(st.journalEntryId).toBeNull();
    expect(await bal("FIFO", wh2)).toEqual({ qty: 2, value: 240 });
    const layer = await prisma.inventoryLayer.findFirstOrThrow({ where: { itemId: items.FIFO, warehouseId: wh2 } });
    expect(layer.receivedDate.toISOString().slice(0, 10)).toBe(`${Y}-10-02`);
    await expect(post("TRANSFER", [{ itemId: items.FIFO, qty: "1", locationId: binB, toLocationId: binB }], { toWarehouseId: wh1 })).rejects.toThrow(/different destination location/);
    await post("TRANSFER", [{ itemId: items.FIFO, qty: "1", locationId: binB, toLocationId: binA }], { toWarehouseId: wh1, date: d("10-08") });
    expect(await bal("FIFO")).toEqual({ qty: 3, value: 360 });
  });
});

describe("specific identification", () => {
  it("issues the named serial at its own cost", async () => {
    await expect(post("RECEIPT", [{ itemId: items.SPEC, qty: "1", unitCost: "50000" }])).rejects.toThrow(/lot \/ serial/);
    await post("RECEIPT", [{ itemId: items.SPEC, qty: "1", unitCost: "50000", lotNo: "SN-1" }, { itemId: items.SPEC, qty: "1", unitCost: "62000", lotNo: "SN-2" }], { date: d("10-01") });
    const is = await post("ISSUE", [{ itemId: items.SPEC, qty: "1", lotNo: "SN-2" }]);
    expect(Number(is.totalValue)).toBe(62000);
    await expect(post("ISSUE", [{ itemId: items.SPEC, qty: "1", lotNo: "SN-2" }])).rejects.toThrow(/only 0 on hand/);
  });
});

describe("adjustments and returns", () => {
  it("needs approval by someone other than the preparer", async () => {
    await expect(post("ADJUSTMENT", [{ itemId: items.FIFO, qty: "-1" }])).rejects.toThrow(/need approval/);
    const ia = await saveInventoryTransaction({ ...doc("ADJUSTMENT", [{ itemId: items.FIFO, qty: "-1", description: "Damaged" }]), action: "submit" });
    expect(ia.status).toBe("PENDING_APPROVAL");
    await expect(approveInventory(org, clerk, ia.id)).rejects.toThrow(/rights to approve/);
    await rejectInventory(org, accountant, ia.id, "Attach the damage report");
    await saveInventoryTransaction({ ...doc("ADJUSTMENT", [{ itemId: items.FIFO, qty: "-1", description: "Damaged" }]), action: "submit" }, ia.id);
    const r = await approveInventory(org, accountant, ia.id);
    expect(r.total).toBe(12000n); // oldest remaining FIFO layer @120
    expect(await glBalance("5030")).toBe(120);
  });

  it("customer returns come back at current cost and credit COGS", async () => {
    const before = await glBalance("5010");
    const r = await post("RETURN_IN", [{ itemId: items.FIFO, qty: "1" }], { partyType: "CUSTOMER", partyId: "C-1" });
    expect(Number(r.totalValue)).toBe(120);
    expect(await glBalance("5010")).toBe(before - 120);
  });
});

describe("void", () => {
  it("puts stock back and reverses the GL", async () => {
    const before = await bal("FIFO");
    const is = await post("ISSUE", [{ itemId: items.FIFO, qty: "2" }], { date: d("10-09") });
    await expect(voidOrReverse(org, owner, is.journalEntryId!)).rejects.toThrow(/came from Inventory/);
    await voidInventory(org, owner, is.id, "Wrong item");
    expect(await bal("FIFO")).toEqual(before);
  });

  it("will not void a receipt whose stock was already used", async () => {
    const rr = await post("RECEIPT", [{ itemId: items.AVG, qty: "5", unitCost: "200" }], { date: d("10-10") });
    await post("ISSUE", [{ itemId: items.AVG, qty: "1" }], { date: d("10-10") });
    await expect(voidInventory(org, owner, rr.id, "Oops")).rejects.toThrow(/already been issued/);
  });
});

describe("counts", () => {
  it("books count variances as an approved adjustment", async () => {
    const c = await createCount({ organizationId: org, userId: clerk, warehouseId: wh1, type: "PHYSICAL", date: d("10-31") });
    const lines = await prisma.inventoryCountLine.findMany({ where: { countId: c.id }, include: { item: true } });
    const avg = lines.find((l) => l.item.code === "AVG")!;
    expect(Number(avg.systemQty)).toBe(4);
    await expect(submitCount(org, clerk, c.id)).rejects.toThrow(/physical count must cover every line/);
    await saveCountSheet(org, clerk, c.id, lines.map((l) => ({ lineId: l.id, countedQty: l.id === avg.id ? "3" : l.systemQty.toString() })),
      [{ itemId: items.SPEC, lotNo: "SN-9", countedQty: "1" }]);
    await submitCount(org, clerk, c.id);
    await expect(postCount(org, clerk, c.id)).rejects.toThrow(/rights to approve/);
    const r = await postCount(org, accountant, c.id);
    expect(r.variances).toBe(2);
    expect((await bal("AVG")).qty).toBe(3);
    expect(await prisma.inventoryLayer.count({ where: { itemId: items.SPEC, lotNo: "SN-9", qtyRemaining: { gt: 0 } } })).toBe(1);
    const cyc = await createCount({ organizationId: org, userId: clerk, warehouseId: wh1, type: "CYCLE", date: d("10-31"), category: "Supplies" });
    expect(await prisma.inventoryCountLine.count({ where: { countId: cyc.id } })).toBeGreaterThan(0);
  });
});

describe("hooks for purchasing and sales", () => {
  it("receives against GRNI and issues to COGS, and voids by source", async () => {
    const grniCode = (await prisma.account.findUniqueOrThrow({ where: { organizationId_systemRole: { organizationId: org, systemRole: "GRNI" } } })).code;
    const grni = await glBalance(grniCode);
    const res = await prisma.$transaction((tx) => receiveGoodsTx(tx, {
      organizationId: org, userId: clerk, date: d("11-02"), warehouseId: wh2, memo: "PO-1 goods receipt", reference: "PO-1",
      partyType: "VENDOR", partyId: "V-1", sourceModule: "PURCHASES", sourceId: "gr-1", lines: [{ itemId: items.AVG, qty: "10", unitCost: "90" }],
    }));
    expect(res.total).toBe(90000n);
    expect(await glBalance(grniCode)).toBe(grni - 900);
    const sale = await prisma.$transaction((tx) => issueGoodsTx(tx, {
      organizationId: org, userId: clerk, date: d("11-03"), warehouseId: wh2, memo: "SI-1", sourceModule: "SALES", sourceId: "si-1", lines: [{ itemId: items.AVG, qty: "4" }],
    }));
    expect(sale.lines[0].value).toBe(36000n);
    await expect(voidInventory(org, owner, sale.id, "x")).rejects.toThrow(/Void the source document/);
    expect(await prisma.$transaction((tx) => voidBySourceTx(tx, org, owner, "SALES", "si-1", "Invoice cancelled"))).toBe(1);
    expect(await bal("AVG", wh2)).toEqual({ qty: 10, value: 900 });
  });

  it("creates missing inventory accounts for older companies", async () => {
    await prisma.account.update({ where: { organizationId_code: { organizationId: org, code: "5030" } }, data: { systemRole: null } });
    const a = await prisma.$transaction((tx) => ensureRoleAccount(tx, org, "INVENTORY_ADJUSTMENT"));
    expect(a.code).toBe("5030");
  });
});

describe("reports", () => {
  it("valuation agrees with the GL", async () => {
    const v = await valuation(org, { asOf: d("12-31") });
    expect(v.total).toBe(BigInt(Math.round((await glBalance("1200")) * 100)));
    expect(v.glDifference).toBe(0n);
    const early = await valuation(org, { asOf: d("10-01") });
    expect(early.total).toBe(100000n + 1000n * 100n + 5000000n + 6200000n);
  });

  it("stock status, aging, slow moving, turnover and stock card", async () => {
    const ss = await stockStatus(org, {});
    const avg = ss.rows.find((r) => r.code === "AVG" && r.warehouseCode === "WH1")!;
    expect(avg.qty).toBe(30000n);
    expect(avg.belowReorder).toBe(true);
    const ag = await aging(org, { asOf: d("12-31") });
    expect(ag.total).toBe((await valuation(org, { asOf: d("12-31") })).total);
    const sm = await slowMoving(org, { asOf: d("12-31"), days: 30 });
    expect(sm.rows.some((r) => r.code === "SPEC")).toBe(true);
    const t = await turnover(org, { from: d("10-01"), to: d("12-31") });
    expect(t.rows.find((r) => r.code === "FIFO")!.cogs).toBeGreaterThan(0n);
    const card = await stockCard(org, { itemId: items.FIFO, from: d("10-01"), to: d("12-31") });
    expect(card.rows.at(-1)!.balanceQty).toBe(card.closingQty);
  });
});
