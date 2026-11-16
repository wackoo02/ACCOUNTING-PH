import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { certificatesForPayment } from "@/lib/ap/payments";
import { Cert2307View } from "@/components/ap/Cert2307";
import { PrintButton } from "@/components/PrintButton";

export default async function Payment2307({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const r = await certificatesForPayment(ctx.org.id, id).catch(() => null);
  if (!r) notFound();
  const [org, vendor] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }), prisma.vendor.findUniqueOrThrow({ where: { id: r.payment.vendorId } })]);
  return (<>
    <div className="top noprint"><h1>BIR Form 2307 · {r.payment.number}</h1><PrintButton /></div>
    {!r.certs.length && <div className="notice">No tax was withheld on the bills in this payment.</div>}
    {r.certs.map((c) => <Cert2307View key={`${c.year}-${c.quarter}`} cert={c} org={org} vendor={vendor} />)}
  </>);
}
