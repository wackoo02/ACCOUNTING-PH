import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";

// GET /api/search?q= -> records matching by name, code or document number (used by the Ctrl+K search).
export async function GET(req: Request) {
  const ctx = await requireCtx();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ results: [] });
  const organizationId = ctx.org.id;
  const like = { contains: q, mode: "insensitive" as const };
  const nameOrCode = { organizationId, OR: [{ name: like }, { code: like }] };
  const [customers, vendors, products, employees, invoices, bills, journals] = await Promise.all([
    prisma.customer.findMany({ where: nameOrCode, take: 5, select: { code: true, name: true } }),
    prisma.vendor.findMany({ where: nameOrCode, take: 5, select: { code: true, name: true } }),
    prisma.product.findMany({ where: nameOrCode, take: 5, select: { code: true, name: true } }),
    prisma.employee.findMany({ where: { organizationId, OR: [{ code: like }, { lastName: like }, { firstName: like }] }, take: 5, select: { code: true, lastName: true, firstName: true } }),
    prisma.salesInvoice.findMany({ where: { organizationId, OR: [{ number: like }, { customerName: like }] }, take: 5, orderBy: { date: "desc" }, select: { id: true, number: true, customerName: true, kind: true } }),
    prisma.apBill.findMany({ where: { organizationId, OR: [{ number: like }, { supplierInvoiceNo: like }] }, take: 5, orderBy: { date: "desc" }, select: { id: true, number: true, supplierInvoiceNo: true } }),
    prisma.journalEntry.findMany({ where: { organizationId, OR: [{ number: like }, { memo: like }, { reference: like }] }, take: 5, orderBy: { date: "desc" }, select: { id: true, number: true, memo: true } }),
  ]);
  const m = (kind: string) => (r: { code: string; name: string }) => ({ group: "Master data", label: r.name, hint: `${kind} · ${r.code}`, href: `/masters/${kind.toLowerCase()}s/edit?code=${encodeURIComponent(r.code)}` });
  const results = [
    ...customers.map(m("Customer")),
    ...vendors.map(m("Vendor")),
    ...products.map(m("Product")),
    ...employees.map((e) => ({ group: "Master data", label: `${e.lastName}, ${e.firstName}`, hint: `Employee · ${e.code}`, href: `/masters/employees/edit?code=${encodeURIComponent(e.code)}` })),
    ...invoices.map((i) => ({ group: "Documents", label: `${i.kind === "CREDIT_MEMO" ? "Credit memo" : "Sales invoice"} ${i.number ?? "(draft)"}`, hint: i.customerName, href: `/receivables/${i.id}` })),
    ...bills.map((b) => ({ group: "Documents", label: `Supplier bill ${b.number}`, hint: `Invoice ${b.supplierInvoiceNo}`, href: `/ap/bills/${b.id}` })),
    ...journals.map((j) => ({ group: "Documents", label: `Journal ${j.number ?? "(draft)"}`, hint: j.memo.slice(0, 60), href: `/journals/${j.id}` })),
  ];
  return NextResponse.json({ results });
}
