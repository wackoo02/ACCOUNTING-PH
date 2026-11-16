import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { cents } from "@/lib/ap/common";
import { amountInWords } from "@/lib/ap/payments";
import { peso } from "@/lib/ap/view";
import { PrintButton } from "@/components/PrintButton";

/** Check face: payee, date, amount in figures and words. Align with the bank's check stock when printing. */
export default async function CheckPrint({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const p = await prisma.apPayment.findFirst({ where: { id, organizationId: ctx.org.id, status: "POSTED", method: "CHECK" } });
  if (!p) notFound();
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: p.vendorId } });
  const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { id: p.bankAccountId } });
  return (<>
    <div className="top noprint"><h1>Check {p.checkNo} · {bank.name}</h1><PrintButton /></div>
    <p className="muted noprint">Print on the bank&apos;s check stock. The layout fits a standard 8 x 3 inch Philippine check; adjust your printer margins once and reuse.</p>
    <div style={{ width: "8in", height: "3in", border: "1px dashed #bbb", position: "relative", fontFamily: "monospace", fontSize: 14, background: "#fff" }}>
      <div style={{ position: "absolute", top: "0.35in", right: "0.5in" }}>{fmtDate(p.checkDate ?? p.date)}</div>
      <div style={{ position: "absolute", top: "0.95in", left: "1.0in" }}>**{vendor.name}**</div>
      <div style={{ position: "absolute", top: "0.95in", right: "0.5in" }}>**{peso(p.amount)}**</div>
      <div style={{ position: "absolute", top: "1.35in", left: "0.6in", right: "0.5in" }}>**{amountInWords(cents(p.amount), p.currencyCode)}**</div>
    </div>
  </>);
}
