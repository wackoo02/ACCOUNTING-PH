// Fixed assets: categories, additions posted to the GL, opening balances from the Master List, monthly
// depreciation runs (and undo), improvements, transfers, disposals with gain/loss and VAT, retirements,
// reports that tie to the GL, and the asset count (QR scan) syncing back to the register.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { importMasters } from "@/lib/masters/store";
import { addAsset, acceptSeenLocation, disposeAsset, improveAsset, previewDepreciation, runDepreciation, transferAsset, undoDepreciationRun, voidAssetTxn } from "@/lib/assets/service";
import { assetRegister, depreciationSchedule, disposalReport, rollforward } from "@/lib/assets/reports";
import { closeAudit, scanAsset, startAudit } from "@/lib/assets/audit";
import { voidOrReverse } from "@/lib/ledger/service";

let org = "", owner = "";
const tag = `${Date.now()}`;
const d = (s: string) => new Date(s + "T00:00:00Z");

async function glBalance(code: string, to = "2099-12-31") {
  const lines = await prisma.journalLine.findMany({ where: { organizationId: org, account: { code }, journalEntry: { status: "POSTED", date: { lte: d(to) } } } });
  return lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
}
const asset = (code: string) => prisma.fixedAsset.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } });

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `fa${tag}@test.local`, name: "FA Owner", passwordHash: "x" } })).id;
  org = (await provisionOrganization({ name: "Assets Co", ownerUserId: owner })).id;
  await importMasters("dimensions", org, owner, [{ type: "DEPARTMENT", code: "FIN", name: "Finance" }, { type: "DEPARTMENT", code: "OPS", name: "Operations" }, { type: "COST_CENTER", code: "CC-ADMIN", name: "Admin" }]);
  await importMasters("employees", org, owner, [{ code: "E-1", lastName: "Santos", firstName: "Maria" }, { code: "E-2", lastName: "Cruz", firstName: "Jose" }]);
  await importMasters("vendors", org, owner, [{ code: "V-1", name: "PC Express" }]);
});

afterAll(async () => {
  await prisma.assetScan.deleteMany({ where: { organizationId: org } });
  await prisma.assetAudit.deleteMany({ where: { organizationId: org } });
  await prisma.fixedAssetTxn.deleteMany({ where: { organizationId: org } });
  await prisma.depreciationRun.deleteMany({ where: { organizationId: org } });
  await prisma.fixedAsset.deleteMany({ where: { organizationId: org } });
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.organization.delete({ where: { id: org } });
  await prisma.user.delete({ where: { id: owner } });
});

describe("fixed assets", () => {
  it("new companies get starter categories; asset numbers follow the category prefix", async () => {
    const cats = await prisma.assetCategory.findMany({ where: { organizationId: org } });
    expect(cats.map((x) => x.code).sort()).toEqual(["BLDG", "FURN", "IT", "LAND", "OFFEQ", "VEH"]);
    const a = await addAsset(org, owner, {
      name: "Dell Latitude 5440", categoryCode: "IT", serialNo: "5CG1", location: "Makati HQ", departmentCode: "FIN", custodianCode: "E-1", vendorCode: "V-1", poNumber: "PO-1",
      acquisitionDate: d("2026-01-10"), cost: "72000", postToGl: true, offsetAccountCode: "2010",
    });
    expect(a.code).toBe("IT-000001");
    expect(a.usefulLifeMonths).toBe(36);
    expect(a.accumDepAccountCode).toBe("1535");
    expect(await glBalance("1530")).toBe(72000);
    expect(await glBalance("2010")).toBe(-72000);
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { organizationId: org, sourceId: a.id } });
    expect(je.source).toBe("FIXED_ASSETS");
    const ap = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: je.id, credit: { gt: 0 } } });
    expect([ap.partyType, ap.partyId]).toEqual(["VENDOR", "V-1"]);
  });

  it("rejects bad setup with clear messages", async () => {
    await expect(addAsset(org, owner, { name: "X", categoryCode: "NOPE", acquisitionDate: d("2026-01-10"), cost: "100", postToGl: true, offsetAccountCode: "2010" })).rejects.toThrow(/category NOPE not found/);
    await expect(addAsset(org, owner, { name: "X", categoryCode: "IT", acquisitionDate: d("2026-01-10"), cost: "100", salvageValue: "200", postToGl: true, offsetAccountCode: "2010" })).rejects.toThrow(/Salvage value/);
    await expect(addAsset(org, owner, { name: "X", categoryCode: "IT", acquisitionDate: d("2026-01-10"), cost: "100", postToGl: true })).rejects.toThrow(/account to credit/);
  });

  it("imports already-depreciated assets from the Master List without touching the GL", async () => {
    await importMasters("assets", org, owner, [
      { code: "VEH-OLD", name: "Toyota Innova", categoryCode: "VEH", location: "Cebu", costCenterCode: "CC-ADMIN", acquisitionDate: d("2025-01-05"), cost: 1200000, accumulatedDepreciation: 240000, depreciatedThrough: d("2025-12-31") },
      { code: "LAND-1", name: "Lot in Laguna", categoryCode: "LAND", acquisitionDate: d("2020-03-01"), cost: 5000000 },
    ]);
    const v = await asset("VEH-OLD");
    expect(v.usefulLifeMonths).toBe(60);
    expect(v.depreciatedThrough?.toISOString().slice(0, 10)).toBe("2025-12-31");
    expect(await glBalance("1540")).toBe(0);
    const opening = await prisma.fixedAssetTxn.findFirstOrThrow({ where: { assetId: v.id } });
    expect([opening.type, Number(opening.costChange), Number(opening.accumChange)]).toEqual(["OPENING", 1200000, 240000]);
    // Re-uploading with a new location records a transfer instead of silently overwriting it.
    await importMasters("assets", org, owner, [{ code: "VEH-OLD", name: "Toyota Innova", categoryCode: "VEH", location: "Davao", costCenterCode: "CC-ADMIN", acquisitionDate: d("2025-01-05"), cost: 1200000, accumulatedDepreciation: 240000, depreciatedThrough: d("2025-12-31") }]);
    expect((await asset("VEH-OLD")).location).toBe("Davao");
    expect(await prisma.fixedAssetTxn.count({ where: { assetId: v.id, type: "TRANSFER" } })).toBe(1);
  });

  it("monthly run: one journal by account and department, catch-up, sequential months, undo", async () => {
    const p = await previewDepreciation(org, 2026, 1);
    expect(p.rows.map((r) => [r.asset.code, Number(r.amount) / 100])).toEqual([["IT-000001", 2000], ["VEH-OLD", 20000]]);
    const run = await runDepreciation(org, owner, 2026, 1);
    expect(Number(run.total)).toBe(22000);
    expect(await glBalance("6090")).toBe(22000);
    expect(await glBalance("1535")).toBe(-2000);
    const exp = await prisma.journalLine.findMany({ where: { journalEntryId: run.journalEntryId!, debit: { gt: 0 } }, include: { account: true } });
    const fin = await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: org, code: "FIN" } });
    expect(exp.find((l) => Number(l.debit) === 2000)?.departmentId).toBe(fin.id);
    await expect(runDepreciation(org, owner, 2026, 1)).rejects.toThrow(/already ran/);
    // The GL entry can't be reversed from the journal screen.
    await expect(voidOrReverse(org, owner, run.journalEntryId!)).rejects.toThrow(/Fixed Assets/);
    // Skip a month: March catches up February too.
    const mar = await runDepreciation(org, owner, 2026, 3);
    expect(Number(mar.total)).toBe(44000);
    await undoDepreciationRun(org, owner, mar.id);
    expect(Number((await asset("IT-000001")).accumulatedDepreciation)).toBe(2000);
    expect(await glBalance("6090")).toBe(22000);
    await runDepreciation(org, owner, 2026, 2);
    expect(await glBalance("6090")).toBe(44000);
  });

  it("improvement adds cost and spreads it over the remaining life; latest transaction can be undone", async () => {
    const a = await asset("IT-000001");
    await improveAsset(org, owner, { assetId: a.id, date: d("2026-03-05"), amount: "6800", memo: "RAM and SSD upgrade", postToGl: true, offsetAccountCode: "2010" });
    const p = await previewDepreciation(org, 2026, 3);
    // (78,800 - 4,000) / 34 months = 2,200
    expect(Number(p.rows.find((r) => r.asset.code === "IT-000001")!.amount) / 100).toBe(2200);
    const imp = await prisma.fixedAssetTxn.findFirstOrThrow({ where: { assetId: a.id, type: "IMPROVEMENT" } });
    await voidAssetTxn(org, owner, imp.id, "Wrong asset");
    expect(Number((await asset("IT-000001")).cost)).toBe(72000);
    expect(await glBalance("1530")).toBe(72000);
    await improveAsset(org, owner, { assetId: a.id, date: d("2026-03-05"), amount: "6800", memo: "RAM and SSD upgrade", postToGl: true, offsetAccountCode: "2010" });
    await runDepreciation(org, owner, 2026, 3);
    expect(Number((await asset("IT-000001")).accumulatedDepreciation)).toBe(6200);
  });

  it("transfer changes where future depreciation is charged", async () => {
    const a = await asset("IT-000001");
    await transferAsset(org, owner, { assetId: a.id, date: d("2026-04-01"), location: "Ortigas", departmentCode: "OPS", custodianCode: "E-2", memo: "Moved to ops" });
    const run = await runDepreciation(org, owner, 2026, 4);
    const ops = await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: org, code: "OPS" } });
    const line = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: run.journalEntryId!, debit: 2200 } });
    expect(line.departmentId).toBe(ops.id);
    await expect(transferAsset(org, owner, { assetId: a.id, date: d("2026-04-02"), location: "Ortigas" })).rejects.toThrow(/Nothing to transfer/);
  });

  it("sale: depreciation to date, derecognition, output VAT and gain/loss", async () => {
    const v = await asset("VEH-OLD");
    // Depreciated through April; sold 20 May -> May depreciation (20,000) is charged on the disposal.
    await disposeAsset(org, owner, { assetId: v.id, type: "DISPOSAL", date: d("2026-05-20"), proceeds: "900000", outputVat: "108000", proceedsAccountCode: "1100", buyer: "Juan dela Cruz", memo: "Sold to employee" });
    const after = await asset("VEH-OLD");
    expect(after.status).toBe("DISPOSED");
    // accum = 240,000 + 4 x 20,000 + 20,000 = 340,000; NBV 860,000; gain 40,000
    const t = await prisma.fixedAssetTxn.findFirstOrThrow({ where: { assetId: v.id, type: "DISPOSAL" } });
    expect([Number(t.depreciation), Number(t.gainLoss)]).toEqual([20000, 40000]);
    expect(await glBalance("1100")).toBe(1008000);
    expect(await glBalance("2030")).toBe(-108000);
    expect(await glBalance("7030")).toBe(-40000);
    await runDepreciation(org, owner, 2026, 5);
    expect((await previewDepreciation(org, 2026, 6)).rows.map((r) => r.asset.code)).toEqual(["IT-000001"]);
  });

  it("retirement writes off the net book value as a loss", async () => {
    const a = await addAsset(org, owner, { name: "Office chair", categoryCode: "FURN", acquisitionDate: d("2026-02-01"), cost: "6000", postToGl: true, offsetAccountCode: "1010" });
    await runDepreciation(org, owner, 2026, 6); // Feb-Jun = 5 x 100 for the chair
    await disposeAsset(org, owner, { assetId: a.id, type: "RETIREMENT", date: d("2026-07-10"), memo: "Broken, scrapped" });
    const t = await prisma.fixedAssetTxn.findFirstOrThrow({ where: { assetId: a.id, type: "RETIREMENT" } });
    expect(Number(t.gainLoss)).toBe(-5500);
    expect(await glBalance("7545")).toBe(5500);
    await expect(disposeAsset(org, owner, { assetId: a.id, type: "RETIREMENT", date: d("2026-07-10"), memo: "again" })).rejects.toThrow(/already retired/);
  });

  it("reports: register and rollforward tie to the GL; schedule shows posted and projected months", async () => {
    const reg = await assetRegister(org, "2026-06-30");
    const gl = (await glBalance("1530", "2026-06-30")) + (await glBalance("1550", "2026-06-30"));
    // VEH-OLD and LAND-1 came in as opening balances (outside this GL), so compare GL-posted assets only.
    const posted = reg.rows.filter((r) => !["VEH-OLD", "LAND-1"].includes(r.asset.code));
    expect(posted.reduce((s, r) => s + Number(r.cost), 0) / 100).toBe(gl);
    const accumGl = -((await glBalance("1535", "2026-06-30")) + (await glBalance("1555", "2026-06-30")));
    expect(posted.reduce((s, r) => s + Number(r.accum), 0) / 100).toBe(accumGl);
    expect(reg.rows.some((r) => r.asset.code === "VEH-OLD")).toBe(false); // sold in May

    const rf = await rollforward(org, "2026-01-01", "2026-12-31");
    const t = rf.total;
    expect(t.closeCost).toBe(t.openCost + t.additions + t.improvements + t.disposals);
    const veh = rf.rows.find((r) => r.key === "Vehicles")!;
    expect([Number(veh.openCost) / 100, Number(veh.disposals) / 100, Number(veh.closeCost)]).toEqual([1200000, -1200000, 0]);
    expect([Number(veh.openAccum) / 100, Number(veh.depreciation) / 100, Number(veh.closeAccum)]).toEqual([240000, 100000, 0]);

    const disp = await disposalReport(org, "2026-01-01", "2026-12-31");
    expect(disp.rows.map((r) => [r.asset.code, Number(r.nbv) / 100, Number(r.gainLoss) / 100])).toEqual([["VEH-OLD", 860000, 40000], [expect.stringMatching(/^FF-/), 5500, -5500]]);

    const sch = await depreciationSchedule(org, 2026);
    const it = sch.rows.find((r) => r.asset.code === "IT-000001")!;
    expect(it.cells.map((x) => Number(x.amount) / 100).slice(0, 7)).toEqual([2000, 2000, 2200, 2200, 2200, 2200, 2200]);
    expect(it.cells[5].projected).toBe(false);
    expect(it.cells[6].projected).toBe(true);
  });

  it("asset count scans sync to the register: found, moved (accepted as transfer), missing", async () => {
    await addAsset(org, owner, { code: "FA-9", name: "Projector", categoryCode: "OFFEQ", location: "Ortigas", acquisitionDate: d("2026-03-01"), cost: "30000", postToGl: true, offsetAccountCode: "2010" });
    const au = await startAudit(org, owner, { name: "Mid-year count" });
    await scanAsset(org, owner, au.id, { tagText: "VFA:IT-000001", location: "Ortigas", condition: "GOOD" });
    await scanAsset(org, owner, au.id, { tagText: "VFA:FA-9", location: "BGC" });
    await closeAudit(org, owner, au.id);
    const reg = await assetRegister(org, "2026-12-31");
    const st = Object.fromEntries(reg.rows.map((r) => [r.asset.code, r.audit]));
    expect(st["IT-000001"]).toBe("Found");
    expect(st["FA-9"]).toBe("Moved");
    expect(st["LAND-1"]).toBe("Missing");
    await acceptSeenLocation(org, owner, (await asset("FA-9")).id);
    expect((await asset("FA-9")).location).toBe("BGC");
  });
});
