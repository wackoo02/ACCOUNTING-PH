// Demo data: a parent company and a subsidiary with sample postings. Run: npm run db:seed
// Sign in as owner@demo.ph, accountant@demo.ph or bookkeeper@demo.ph (password: demo12345).
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";
import { provisionOrganization } from "../src/lib/org";
import { postJournal, recordIntercompany, recordJournal, setupIntercompany } from "../src/lib/ledger/service";
import { importMasters } from "../src/lib/masters/store";

async function main() {
  if (await prisma.user.findUnique({ where: { email: "owner@demo.ph" } })) return console.log("Demo data already present.");
  const hash = await bcrypt.hash("demo12345", 12);
  const mk = (email: string, name: string) => prisma.user.create({ data: { email, name, passwordHash: hash } });
  const owner = await mk("owner@demo.ph", "Demo Owner");
  const acc = await mk("accountant@demo.ph", "Ana Accountant");
  const bk = await mk("bookkeeper@demo.ph", "Ben Bookkeeper");
  const parent = await provisionOrganization({ name: "Demo Holdings Inc.", tin: "000-123-456-00000", ownerUserId: owner.id });
  const sub = await provisionOrganization({ name: "Demo Trading Corp.", tin: "000-654-321-00000", ownerUserId: owner.id });
  await prisma.organization.update({ where: { id: parent.id }, data: { code: "DEMOHOLD" } });
  await prisma.organization.update({ where: { id: sub.id }, data: { code: "DEMOTRD", parentId: parent.id, entityType: "SUBSIDIARY" } });
  for (const o of [parent.id, sub.id]) {
    await prisma.membership.createMany({ data: [
      { userId: acc.id, organizationId: o, role: "ACCOUNTANT", approvalLimit: "500000" },
      { userId: bk.id, organizationId: o, role: "BOOKKEEPER" },
    ] });
  }
  const P = parent.id;
  await importMasters("dimensions", P, owner.id, [
    { type: "DEPARTMENT", code: "ADMIN", name: "Administration" }, { type: "DEPARTMENT", code: "SALES", name: "Sales and Marketing" },
    { type: "DEPARTMENT", code: "OPS", name: "Operations" }, { type: "BRANCH", code: "MNL", name: "Manila" }, { type: "BRANCH", code: "CEB", name: "Cebu" },
    { type: "PROJECT", code: "PRJ-001", name: "SM Fit-out Project" }, { type: "COST_CENTER", code: "CC100", name: "Head Office" },
  ]);
  await importMasters("currencies", P, owner.id, [{ code: "USD", name: "US Dollar", symbol: "$", rateToBase: "58.25" }]);
  await importMasters("accounts", P, owner.id, [{ code: "1027", name: "Cash in Bank - USD Savings", type: "ASSET", ifrsGroup: "Cash and cash equivalents", isCurrent: true, parentCode: "1000", currencyCode: "USD" }]);
  const id = async (code: string, org = P) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
  const dim = async (code: string) => (await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: P, code } })).id;
  const y = new Date().getUTCFullYear();
  const dt = (s: string) => new Date(`${y}-${s}`);

  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-02"), memo: "Opening capital contribution", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await id("1020"), debit: "2000000" }, { accountId: await id("3010"), credit: "2000000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-10"), memo: "Consulting billing to XYZ Trading (SI 0001)", reference: "SI 0001", source: "SALES", action: "post",
    lines: [{ accountId: await id("1100"), debit: "336000", partyType: "CUSTOMER", partyId: "C-0001" }, { accountId: await id("4020"), credit: "300000", dims: { departmentId: await dim("SALES"), projectId: await dim("PRJ-001") } }, { accountId: await id("2030"), credit: "36000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-31"), memo: "Collection from XYZ Trading net of 2% CWT (OR 0001)", reference: "OR 0001", source: "SALES", action: "post",
    lines: [{ accountId: await id("1020"), debit: "330000" }, { accountId: await id("1320"), debit: "6000" }, { accountId: await id("1100"), credit: "336000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("02-05"), memo: "Export consulting received in USD", source: "SALES", action: "post",
    lines: [{ accountId: await id("1027"), debit: "5000", currencyCode: "USD", fxRate: "57.80" }, { accountId: await id("4020"), credit: "5000", currencyCode: "USD", fxRate: "57.80", dims: { departmentId: await dim("SALES") } }] });
  // Manual entries through the approval workflow: bookkeeper prepares, accountant approves.
  const manual = [
    { date: "01-15", memo: "Office rent for January, less 5% EWT", ref: "CV 0001", lines: [
      { accountId: await id("6030"), debit: "60000", dims: { departmentId: await dim("ADMIN"), costCenterId: await dim("CC100") } }, { accountId: await id("1310"), debit: "7200" },
      { accountId: await id("2045"), credit: "3000" }, { accountId: await id("1020"), credit: "64200" }] },
    { date: "01-31", memo: "January salaries", ref: "PR-01", lines: [
      { accountId: await id("6010"), debit: "120000", dims: { departmentId: await dim("OPS") } }, { accountId: await id("6010"), debit: "80000", dims: { departmentId: await dim("SALES") } },
      { accountId: await id("2040"), credit: "18000" }, { accountId: await id("1020"), credit: "182000" }] },
    { date: "02-12", memo: "Grab rides for client visits", ref: "GCASH-0212", lines: [
      { accountId: await id("6050"), debit: "2350", dims: { departmentId: await dim("SALES"), projectId: await dim("PRJ-001") } }, { accountId: await id("1030"), credit: "2350" }] },
  ];
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-03"), memo: "Fund GCash corporate wallet", source: "BANK", action: "post",
    lines: [{ accountId: await id("1030"), debit: "20000" }, { accountId: await id("1020"), credit: "20000" }] });
  for (const m of manual) {
    const e = await recordJournal({ organizationId: P, userId: bk.id, date: dt(m.date), memo: m.memo, reference: m.ref, lines: m.lines, action: "submit" });
    await postJournal(P, acc.id, e.id);
  }
  await recordJournal({ organizationId: P, userId: bk.id, date: dt("02-20"), memo: "Office supplies from ABC Supplies", reference: "SI 4471", action: "submit",
    lines: [{ accountId: await id("6060"), debit: "4500", dims: { departmentId: await dim("ADMIN") } }, { accountId: await id("1310"), debit: "540" }, { accountId: await id("1010"), credit: "5040" }],
    attachments: [{ name: "SI 4471 scan", url: "https://example.com/si-4471.pdf" }] });

  await setupIntercompany(owner.id, P, sub.id);
  await recordJournal({ organizationId: sub.id, userId: owner.id, date: dt("01-02"), memo: "Opening capital from parent", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await id("1020", sub.id), debit: "500000" }, { accountId: await id("3010", sub.id), credit: "500000" }] });
  await recordIntercompany({ userId: owner.id, date: dt("02-28"), memo: "Management fee charged to Demo Trading for February", reference: "IC-MF-02",
    from: { organizationId: P, lines: [{ accountId: await id("7040"), credit: "25000" }] },
    to: { organizationId: sub.id, lines: [{ accountId: await id("6070", sub.id), debit: "25000" }] } });
  console.log("Demo created. Sign in as owner@demo.ph / accountant@demo.ph / bookkeeper@demo.ph, password demo12345");
}
main().finally(() => prisma.$disconnect());
