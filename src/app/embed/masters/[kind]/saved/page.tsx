import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { isMasterKind } from "@/lib/masters/config";
import { listMasters } from "@/lib/masters/query";
import { displayLabel } from "@/lib/masters/candidates";
import { PostSaved } from "./PostSaved";

// After saving in the pop-up: hand the new record back to the form that opened it.
export default async function Saved({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ code?: string; type?: string }> }) {
  const { kind } = await params;
  if (!isMasterKind(kind)) notFound();
  const ctx = await requireCtx();
  const { code, type } = await searchParams;
  const [r] = code ? await listMasters(kind, ctx.org.id, code, type) : [];
  if (!r) notFound();
  const pick = (k: string) => (r[k] === null || r[k] === undefined ? null : typeof r[k] === "object" ? String(r[k]) : r[k]);
  const record = {
    kind, id: String(r.id), code: String(r.code), label: displayLabel(kind, r),
    type: pick("type"), kind_: pick("kind"), currencyCode: pick("currencyCode"), isPartner: pick("isPartner"),
    rate: pick("rate"), rateToBase: pick("rateToBase"),
  };
  return <PostSaved record={record} />;
}
