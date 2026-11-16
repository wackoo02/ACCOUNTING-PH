import { requireCtx } from "@/lib/auth";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader, openPurchaseOrders } from "@/lib/ap/view";
import { DocForm, blankLine, type DocLine } from "@/components/ap/DocForm";

export default async function NewBill({ searchParams }: { searchParams: Promise<{ po?: string }> }) {
  const ctx = await requireCtx("journal.create");
  const sp = await searchParams;
  const [data, pos] = await Promise.all([apFormData(ctx.org.id), openPurchaseOrders(ctx.org.id)]);
  const po = pos.find((p) => p.id === sp.po);
  const vendor = data.vendors.find((v) => v.id === po?.vendorId);
  const lines: DocLine[] = po ? po.lines.filter((l) => Number(l.open) > 0).map((l) => ({ ...blankLine(), description: l.description, category: l.category, accountId: l.accountId, quantity: l.open, unit: l.unit ?? "", unitPrice: l.unitPrice, vatType: l.vatType, poLineId: l.id, dims: l.dims, ewtTaxCodeId: vendor?.ewtTaxCodeId ?? "" })) : [];
  return (<><div className="top"><h1>New Supplier Bill</h1></div>
    <p className="muted">Record the supplier&apos;s invoice. Link the PO so the bill is matched to what was ordered and received (3-way match).</p>
    <DocForm mode="BILL" data={data} openPos={pos} initialLines={lines}
      initial={blankHeader({ vendorId: po?.vendorId ?? "", purchaseOrderId: po?.id ?? "", vatInclusive: po?.vatInclusive ?? true, currencyCode: po?.currencyCode ?? vendor?.currency ?? data.baseCurrency, fxRate: po?.fxRate ?? "1" })} /></>);
}
