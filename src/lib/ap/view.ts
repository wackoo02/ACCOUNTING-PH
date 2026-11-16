// View helpers for purchasing / payables pages (no "use client": shared by server pages).
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { formatPeso, toCentavos } from "../money";
import { today } from "../format";
import { fromQ4 } from "./compute";
import { q4of } from "./common";
import { poProgress } from "../purchasing/service";
import type { DocHeader, DocLine, OpenPo } from "@/components/ap/DocForm";

export const peso = (v: { toString(): string } | null | undefined) => formatPeso(toCentavos(v?.toString() ?? "0"));
export const qty = (v: { toString(): string }) => fromQ4(q4of(v.toString()));
export const statusText = (s: string) => (s === "PENDING_APPROVAL" ? "FOR APPROVAL" : s.replace(/_/g, " "));
export const d10 = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

export const blankHeader = (o: Partial<DocHeader> = {}): DocHeader => ({
  vendorId: "", date: today(), neededBy: "", purpose: "", deliverTo: "", terms: "", vatInclusive: true, currencyCode: "PHP", fxRate: "1", notes: "",
  invoiceNo: "", invoiceDate: today(), dueDate: "", purchaseOrderId: "", departmentId: "", costCenterId: "", projectId: "", branchId: "", requestId: "", rfqId: "", inboxDocumentId: "", ...o,
});

const dimsOf = (j: Prisma.JsonValue | null) => Object.fromEntries(Object.entries((j as Record<string, string>) ?? {}).filter(([, v]) => v)) as Record<string, string>;

export function docLine(l: { description: string; category: string; accountId: string | null; quantity: Prisma.Decimal; unit?: string | null; unitPrice?: Prisma.Decimal; estUnitCost?: Prisma.Decimal; vatType?: string; ewtTaxCodeId?: string | null; poLineId?: string | null; dims?: Prisma.JsonValue | null; productId?: string | null; prepaidStart?: Date | null; prepaidEnd?: Date | null }): DocLine {
  return {
    productId: l.productId ?? "", description: l.description, category: l.category, accountId: l.accountId ?? "", quantity: qty(l.quantity), unit: l.unit ?? "",
    unitPrice: fromQ4(q4of((l.unitPrice ?? l.estUnitCost ?? 0).toString())), vatType: l.vatType ?? "VATABLE", ewtTaxCodeId: l.ewtTaxCodeId ?? "", poLineId: l.poLineId ?? "",
    dims: dimsOf(l.dims ?? null), prepaidStart: d10(l.prepaidStart), prepaidEnd: d10(l.prepaidEnd),
  };
}

/** Approved POs with what is received and not yet billed, for linking a bill. */
export async function openPurchaseOrders(organizationId: string, excludeBillId?: string, include?: string | null): Promise<OpenPo[]> {
  const pos = await prisma.purchaseOrder.findMany({ where: { organizationId, OR: [{ status: "APPROVED" }, ...(include ? [{ id: include }] : [])], lines: { some: {} } }, orderBy: { poDate: "desc" }, take: 300 });
  const out: OpenPo[] = [];
  for (const p of pos) {
    const prog = await poProgress(prisma, p.id, excludeBillId);
    out.push({
      id: p.id, number: p.number, vendorId: p.vendorId ?? "", vatInclusive: p.vatInclusive, currencyCode: p.currencyCode, fxRate: p.fxRate.toString(),
      lines: prog.map((x) => ({ id: x.line.id, lineNo: x.line.lineNo, description: x.line.description, open: fromQ4(x.received - x.billed > 0n ? x.received - x.billed : 0n), unit: x.line.unit, unitPrice: fromQ4(q4of(x.line.unitPrice)), vatType: x.line.vatType, category: x.line.category, accountId: x.line.accountId, dims: dimsOf(x.line.dims) })),
    });
  }
  return out;
}

export async function userNames(ids: (string | null | undefined)[]) {
  const us = await prisma.user.findMany({ where: { id: { in: ids.filter(Boolean) as string[] } }, select: { id: true, name: true } });
  const m = new Map(us.map((u) => [u.id, u.name]));
  return (id: string | null | undefined) => (id ? m.get(id) ?? "—" : "—");
}
