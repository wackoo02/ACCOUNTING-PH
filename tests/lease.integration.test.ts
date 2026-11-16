// Lease accounting (PFRS 16) against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { voidOrReverse } from "@/lib/ledger/service";
import { importMasters } from "@/lib/masters/store";
import { toCentavos } from "@/lib/money";
import { commenceLease, modifyLease, postLeasePeriods, saveLease, terminateLease, undoLastLeaseEvent, type LeaseInput } from "@/lib/leases/service";
import { leaseLiabilitySummary, maturityAnalysis, rouRollforward } from "@/lib/leases/reports";

let org = "", owner = "", accountant = "";
const P = (n: number) => BigInt(Math.round(n * 100));
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
async function bal(code: string, leaseId?: string) {
  const a = await prisma.journalLine.aggregate({ where: { organizationId: org, accountId: await acct(code), journalEntry: { status: "POSTED", ...(leaseId ? {} : {}) } }, _sum: { debit: true, credit: true } });
  return toCentavos(a._sum.debit?.toString() ?? "0") - toCentavos(a._sum.credit?.toString() ?? "0");
}
const base = (): LeaseInput => ({
  organizationId: org, userId: owner, lessorName: "Ayala Land Offices", lessorVendorCode: "V-ALI", leaseType: "PROPERTY", assetDescription: "Makati office, 12th floor",
  commencementDate: "2026-01-01", endDate: "2028-12-31", paymentAmount: "100000", paymentFrequency: "MONTHLY", paymentTiming: "ADVANCE",
  escalationPct: "5", escalationEveryMonths: 12, incrementalBorrowingRate: "8", initialDirectCosts: "20000", initialCostsAccountId: null,
});

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "Lease Test Co", ownerUserId: owner })).id;
  await prisma.membership.create({ data: { userId: accountant, organizationId: org, role: "ACCOUNTANT" } });
  await importMasters("vendors", org, owner, [{ code: "V-ALI", name: "Ayala Land Offices" }]);
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.lease.deleteMany({ where: { organizationId: org } });
  await prisma.vendor.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, accountant] } } });
});

describe("lease lifecycle", () => {
  let id = "";
  it("saves a draft with a schedule and needs a second person to commence", async () => {
    const l = await saveLease(base());
    id = l.id;
    expect(l.number).toMatch(/^LSE-2026-/);
    expect(l.status).toBe("DRAFT");
    expect(await prisma.leaseScheduleLine.count({ where: { leaseId: id } })).toBe(36);
    await expect(commenceLease(org, owner, id)).rejects.toThrow(/Segregation of duties/);
  });

  it("commences: ROU = liability + initial direct costs, split current / non-current", async () => {
    await commenceLease(org, accountant, id);
    const l = await prisma.lease.findUniqueOrThrow({ where: { id } });
    const liab = toCentavos(l.initialLiability.toString());
    expect(toCentavos(l.initialRou.toString())).toBe(liab + P(20000));
    expect(await bal("1600")).toBe(liab + P(20000));
    expect(-(await bal("2098")) - (await bal("2520"))).toBe(liab);
    expect(-(await bal("2098"))).toBeGreaterThan(0n);
  });

  it("journal screen cannot reverse lease entries", async () => {
    const ev = await prisma.leaseEvent.findFirstOrThrow({ where: { leaseId: id, type: "COMMENCEMENT" } });
    await expect(voidOrReverse(org, owner, ev.journalEntryId!)).rejects.toThrow(/Leases/);
  });

  it("posts months: interest, depreciation, payment to AP for the lessor, reclass", async () => {
    const r = await postLeasePeriods(org, owner, new Date("2026-06-30"));
    expect(r).toEqual({ posted: 6, errors: [] });
    const rows = await prisma.leaseScheduleLine.findMany({ where: { leaseId: id }, orderBy: { periodStart: "asc" } });
    const sum = (k: "interest" | "depreciation") => rows.slice(0, 6).reduce((s, x) => s + toCentavos(x[k].toString()), 0n);
    expect(await bal("7510")).toBe(sum("interest"));
    expect(await bal("6090")).toBe(sum("depreciation"));
    expect(await bal("2010")).toBe(-P(600000));
    const ap = await prisma.journalLine.findFirst({ where: { organizationId: org, accountId: await acct("2010") } });
    expect(ap).toMatchObject({ partyType: "VENDOR", partyId: "V-ALI" });
    // GL liability = schedule closing, and the current account = schedule current portion
    expect(-(await bal("2098")) - (await bal("2520"))).toBe(toCentavos(rows[5].closing.toString()));
    expect(-(await bal("2098"))).toBe(toCentavos(rows[5].currentPortion.toString()));
  });

  it("undoes the last month and posts it again", async () => {
    await undoLastLeaseEvent(org, owner, id);
    expect(await prisma.leaseScheduleLine.count({ where: { leaseId: id, postedAt: { not: null } } })).toBe(5);
    expect((await postLeasePeriods(org, owner, new Date("2026-06-30"))).posted).toBe(1);
  });

  it("modifies: extension at a new rent remeasures the liability against the ROU asset", async () => {
    await expect(modifyLease(org, owner, id, { effectiveDate: "2026-09-01", newEndDate: "2030-12-31", newPaymentAmount: "110000", newDiscountRate: "9", memo: "Extended" })).rejects.toThrow(/Post the lease entries/);
    const rouBefore = await bal("1600");
    await modifyLease(org, owner, id, { effectiveDate: "2026-07-01", newEndDate: "2030-12-31", newPaymentAmount: "110000", newDiscountRate: "9", memo: "Renewed to 2030 at P110,000" });
    const l = await prisma.lease.findUniqueOrThrow({ where: { id } });
    expect(l.endDate.toISOString().slice(0, 10)).toBe("2030-12-31");
    const ev = await prisma.leaseEvent.findFirstOrThrow({ where: { leaseId: id, type: "MODIFICATION" } });
    expect(await bal("1600")).toBe(rouBefore + toCentavos(ev.rouRemeasurement.toString()));
    const first = await prisma.leaseScheduleLine.findFirstOrThrow({ where: { leaseId: id, periodStart: new Date("2026-07-01") } });
    expect(-(await bal("2098")) - (await bal("2520"))).toBe(toCentavos(first.opening.toString()));
    expect(await prisma.leaseScheduleLine.findFirst({ where: { leaseId: id }, orderBy: { periodStart: "desc" } })).toMatchObject({ periodEnd: new Date("2030-12-31") });
  });

  it("undoes the modification and restores the old terms", async () => {
    await undoLastLeaseEvent(org, owner, id);
    const l = await prisma.lease.findUniqueOrThrow({ where: { id } });
    expect(l.endDate.toISOString().slice(0, 10)).toBe("2028-12-31");
    expect(await prisma.leaseScheduleLine.count({ where: { leaseId: id } })).toBe(36);
  });

  it("decrease in scope: half given back, gain or loss recognised", async () => {
    await modifyLease(org, owner, id, { effectiveDate: "2026-07-01", newEndDate: "2028-12-31", newPaymentAmount: "50000", scopeReductionPct: "50", memo: "Gave back half the floor" });
    const ev = await prisma.leaseEvent.findFirstOrThrow({ where: { leaseId: id, type: "MODIFICATION" } });
    expect(toCentavos(ev.rouDerecognized.toString())).toBeGreaterThan(0n);
    expect(await bal("7040")).toBe(-toCentavos(ev.gainLoss.toString()));
    // a maturity analysis dated before the change still uses the terms in force then
    const before = (await maturityAnalysis(org, "2026-06-30")).rows.find((r) => r.id === id)!;
    expect(before.buckets[0]).toBe(P(600000) + P(105000) * 6n);
    expect(before.futureInterest).toBeGreaterThan(0n);
    expect(before.futureInterest).toBeLessThan(P(400000));
  });

  it("terminates mid-month: everything comes off, difference to profit or loss", async () => {
    await postLeasePeriods(org, owner, new Date("2026-09-30"));
    await terminateLease(org, owner, id, { date: "2026-10-15", penalty: "30000", reason: "Moved to BGC" });
    expect(await bal("1600")).toBe(0n);
    expect(await bal("1605")).toBe(0n);
    expect(await bal("2098")).toBe(0n);
    expect(await bal("2520")).toBe(0n);
    const l = await prisma.lease.findUniqueOrThrow({ where: { id } });
    expect(l.status).toBe("TERMINATED");
  });

  it("reports: rollforward, liability summary and maturity analysis tie to the GL", async () => {
    const rf = await rouRollforward(org, "2026-01-01", "2026-12-31");
    const t = rf.total;
    expect(t.costOpening + t.additions + t.remeasurements - t.derecognized).toBe(t.costClosing);
    expect(t.costClosing).toBe(0n);
    const s = await leaseLiabilitySummary(org, "2026-12-31");
    expect(s.rows.every((r) => r.closing === 0n)).toBe(true);
  });
});

describe("other lease kinds", () => {
  it("short-term lease: straight-line rent, no ROU asset", async () => {
    const l = await saveLease({ ...base(), number: "ST-1", assetDescription: "Event tent", commencementDate: "2027-01-01", endDate: "2027-06-30", paymentAmount: "60000", paymentFrequency: "QUARTERLY", exemption: "SHORT_TERM", incrementalBorrowingRate: "", initialDirectCosts: "0", vatable: true });
    await commenceLease(org, accountant, l.id);
    await postLeasePeriods(org, owner, new Date("2027-06-30"), l.id);
    expect(await bal("6030")).toBe(P(120000));
    const x = await prisma.lease.findUniqueOrThrow({ where: { id: l.id } });
    expect(x.status).toBe("ENDED");
  });

  it("existing lease taken up at go-live, then maturity analysis", async () => {
    const l = await saveLease({ ...base(), number: "OLD-1", assetDescription: "Warehouse", commencementDate: "2025-01-01", endDate: "2029-12-31", initialDirectCosts: "0", escalationPct: "0", takeUpDate: "2027-01-01" });
    await commenceLease(org, accountant, l.id);
    const row = await prisma.leaseScheduleLine.findFirstOrThrow({ where: { leaseId: l.id, periodEnd: new Date("2026-12-31") } });
    const ev = await prisma.leaseEvent.findFirstOrThrow({ where: { leaseId: l.id } });
    expect(ev.type).toBe("TAKE_UP");
    expect(toCentavos(ev.liabilityAddition.toString())).toBe(toCentavos(row.closing.toString()));
    const m = await maturityAnalysis(org, "2027-01-01");
    const r = m.rows.find((x) => x.number === "OLD-1")!;
    expect(r.buckets[0]).toBe(P(1200000));
    expect(r.total - r.futureInterest).toBe(r.carrying);
  });
});
