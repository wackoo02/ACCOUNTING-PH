import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";
import { toCentavos } from "../money";

/** Options for the invoice, credit memo and billing contract forms. */
export async function invoiceFormData(organizationId: string) {
  const [customers, products, accounts, dimValues, taxCodes, currencies, org] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true, type: { in: ["INCOME", "LIABILITY", "ASSET"] } }, select: { id: true, code: true, name: true, type: true, systemRole: true }, orderBy: { code: "asc" } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: "EWT" }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { organizationId, isActive: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  const skip = new Set(["AR_CONTROL", "OUTPUT_VAT", "CUSTOMER_ADVANCES"]);
  return {
    customers: customers.map((c) => ({ id: c.id, code: c.code, name: c.name, termsDays: c.paymentTermsDays, currencyCode: c.currencyCode, withholdsTax: c.withholdsTax, invoiceEmails: c.invoiceEmails ?? c.email ?? "" })),
    products: products.map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit ?? "", price: p.sellingPrice.toString(), vatType: p.vatType, kind: p.kind })),
    accounts: accounts.filter((a) => !(a.systemRole && skip.has(a.systemRole))),
    dims: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })) })).filter((d) => d.values.length),
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate.toString() })),
    currencies: currencies.map((c) => ({ code: c.code, rate: c.rateToBase.toString() })),
    baseCurrency: org.baseCurrency, vatRegistered: org.vatRegistered, requireApproval: org.requireApproval,
  };
}
export type InvoiceFormData = Awaited<ReturnType<typeof invoiceFormData>>;

/** Options for the collection form: customers, deposit accounts and every open invoice. */
export async function receiptFormData(organizationId: string) {
  const [customers, banks, taxCodes, invoices, org] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId, isActive: true, kind: { not: "CREDIT_CARD" } }, orderBy: { code: "asc" } }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: "EWT" }, orderBy: { code: "asc" } }),
    prisma.salesInvoice.findMany({ where: { organizationId, kind: "INVOICE", status: "POSTED" }, orderBy: [{ dueDate: "asc" }, { number: "asc" }] }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  const open = invoices.map((i) => ({ id: i.id, customerId: i.customerId, number: i.number ?? "", date: i.date.toISOString().slice(0, 10), dueDate: i.dueDate.toISOString().slice(0, 10), currencyCode: i.currencyCode,
    open: Number(toCentavos(i.totalAmount.toString()) - toCentavos(i.appliedAmount.toString())) / 100, ewt: Number(i.ewtAmount), total: Number(i.totalAmount), ewtTaxCodeId: i.ewtTaxCodeId }))
    .filter((i) => i.open > 0);
  return {
    customers: customers.map((c) => ({ id: c.id, code: c.code, name: c.name, currencyCode: c.currencyCode })),
    banks: banks.map((b) => ({ id: b.id, code: b.code, name: b.name, currencyCode: b.currencyCode })),
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate.toString() })),
    invoices: open, baseCurrency: org.baseCurrency, requireApproval: org.requireApproval,
  };
}
export type ReceiptFormData = Awaited<ReturnType<typeof receiptFormData>>;
