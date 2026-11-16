import { prisma } from "../db";
import { fromCentavos } from "../money";
import { cents } from "./common";
import { openBalances } from "./bills";
import type { OpenBill } from "@/components/ap/PaymentForm";

export async function openBills(organizationId: string, excludePaymentId?: string): Promise<OpenBill[]> {
  const bills = await prisma.apBill.findMany({ where: { organizationId, status: "POSTED" }, orderBy: { dueDate: "asc" } });
  const paid = await openBalances(prisma, organizationId, bills.map((b) => b.id), excludePaymentId);
  return bills.map((b) => ({ id: b.id, number: b.number, vendorId: b.vendorId, invoiceNo: b.supplierInvoiceNo, dueDate: b.dueDate.toISOString().slice(0, 10), currency: b.currencyCode, total: b.total.toString(), ewt: b.ewtAmount.toString(), onHold: b.onHold, open: fromCentavos(cents(b.netPayable) - (paid.get(b.id) ?? 0n)) })).filter((b) => cents(b.open) > 0n);
}

export async function payFormProps(organizationId: string) {
  const [vendors, banks, currencies, org] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    prisma.bankAccount.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, kind: true, currencyCode: true, nextCheckNo: true } }),
    prisma.currency.findMany({ where: { organizationId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  return { vendors, banks, baseCurrency: org.baseCurrency, rates: Object.fromEntries(currencies.map((c) => [c.code, c.rateToBase.toString()])) };
}

