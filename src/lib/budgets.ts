// Budgets: 12 monthly amounts per account (optionally per dimension value) per fiscal year.
import ExcelJS from "exceljs";
import { Prisma, type DimensionType } from "@prisma/client";
import { prisma } from "./db";
import { fiscalYearRange } from "./ledger/service";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodLabels(startMonth: number) {
  return Array.from({ length: 12 }, (_, i) => MONTHS[(startMonth - 1 + i) % 12]);
}

export async function budgetWorkbook(organizationId: string, fiscalYear: number) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const labels = periodLabels(org.fiscalYearStartMonth);
  const [accounts, budgets, dims] = await Promise.all([
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true }, orderBy: { code: "asc" } }),
    prisma.budget.findMany({ where: { organizationId, fiscalYear } }),
    prisma.dimensionValue.findMany({ where: { organizationId } }),
  ]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  ws.columns = [
    { header: "Account Code *", key: "code", width: 14 }, { header: "Account Name (info only)", key: "name", width: 36 },
    { header: "Dimension", key: "dt", width: 16 }, { header: "Dimension Code", key: "dc", width: 14 },
    ...labels.map((l, i) => ({ header: `P${i + 1} ${l}`, key: `m${i + 1}`, width: 12 })),
    { header: "Annual (info only)", key: "annual", width: 14 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F2540" } };
  const pl = accounts.filter((a) => a.type === "INCOME" || a.type === "EXPENSE");
  const rows = budgets.length ? budgets : pl.map((a) => ({ accountId: a.id, dimensionValueId: null }) as unknown as (typeof budgets)[number]);
  rows.forEach((b, idx) => {
    const a = accounts.find((x) => x.id === b.accountId);
    if (!a) return;
    const dv = dims.find((d) => d.id === b.dimensionValueId);
    const r = ws.addRow({ code: a.code, name: a.name, dt: dv?.type ?? "", dc: dv?.code ?? "",
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i + 1}`, b && "m1" in b ? Number((b as unknown as Record<string, Prisma.Decimal>)[`m${i + 1}`]) : 0])) });
    r.getCell(17).value = { formula: `SUM(E${idx + 2}:P${idx + 2})` };
  });
  const info = wb.addWorksheet("Instructions");
  info.addRows([
    [`Budget for FY${fiscalYear}. Amounts in ${org.baseCurrency}, one column per fiscal month.`],
    ["Income accounts: budgeted revenue. Expense accounts: budgeted cost. Enter positive amounts."],
    ["Leave Dimension blank for a company-wide budget, or set it (e.g. DEPARTMENT + FIN) for a department/project budget."],
    ["Dimension values: DEPARTMENT, BRANCH, BUSINESS_UNIT, PROJECT, COST_CENTER, PROFIT_CENTER, LOCATION, PRODUCT_LINE."],
    ["Uploading replaces the budget for every account/dimension listed in the file. Rows not in the file are kept."],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function importBudget(organizationId: string, userId: string, fiscalYear: number, buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { return { errors: ["The file could not be read. Please upload the .xlsx template."], saved: 0 }; }
  const ws = wb.getWorksheet("Data") ?? wb.worksheets[0];
  const [accounts, dims] = await Promise.all([
    prisma.account.findMany({ where: { organizationId } }),
    prisma.dimensionValue.findMany({ where: { organizationId } }),
  ]);
  const errors: string[] = [];
  const out: { accountId: string; dimensionValueId: string | null; m: string[] }[] = [];
  const val = (v: unknown) => {
    if (v && typeof v === "object" && "result" in (v as object)) v = (v as { result: unknown }).result;
    return String(v ?? "").trim();
  };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const code = val(row.getCell(1).value).toUpperCase();
    if (!code) return;
    const a = accounts.find((x) => x.code === code);
    if (!a) { errors.push(`Row ${n}: account ${code} not found`); return; }
    if (!a.isPostable) { errors.push(`Row ${n}: ${code} is a header account`); return; }
    const dt = val(row.getCell(3).value).toUpperCase().replace(/\s+/g, "_");
    const dc = val(row.getCell(4).value).toUpperCase();
    let dimensionValueId: string | null = null;
    if (dt || dc) {
      const dv = dims.find((d) => d.type === (dt as DimensionType) && d.code === dc);
      if (!dv) { errors.push(`Row ${n}: dimension ${dt} ${dc} not found`); return; }
      dimensionValueId = dv.id;
    }
    const m: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = val(row.getCell(5 + i).value).replace(/,/g, "") || "0";
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) { errors.push(`Row ${n}: P${i + 1} must be a number with up to 2 decimals`); return; }
      m.push(s);
    }
    if (out.some((o) => o.accountId === a.id && o.dimensionValueId === dimensionValueId)) { errors.push(`Row ${n}: ${code} ${dt} ${dc} appears twice`); return; }
    out.push({ accountId: a.id, dimensionValueId, m });
  });
  if (errors.length) return { errors, saved: 0 };
  await prisma.$transaction(async (tx) => {
    for (const r of out) {
      const data = Object.fromEntries(r.m.map((v, i) => [`m${i + 1}`, new Prisma.Decimal(v)]));
      // Prisma can't upsert on a compound unique that contains a null, so find first.
      const ex = await tx.budget.findFirst({ where: { organizationId, fiscalYear, accountId: r.accountId, dimensionValueId: r.dimensionValueId } });
      if (ex) await tx.budget.update({ where: { id: ex.id }, data });
      else await tx.budget.create({ data: { organizationId, fiscalYear, accountId: r.accountId, dimensionValueId: r.dimensionValueId, ...data } });
    }
    await tx.auditLog.create({ data: { organizationId, userId, action: "budget.import", entity: "budget", entityId: String(fiscalYear), details: { rows: out.length } } });
  }, { timeout: 60_000 });
  return { errors: [], saved: out.length };
}

export async function fiscalStart(organizationId: string, fiscalYear: number) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return { ...fiscalYearRange(org.fiscalYearStartMonth, fiscalYear), labels: periodLabels(org.fiscalYearStartMonth) };
}
