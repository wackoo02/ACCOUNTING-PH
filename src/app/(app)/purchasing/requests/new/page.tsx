import { requireCtx } from "@/lib/auth";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader } from "@/lib/ap/view";
import { DocForm } from "@/components/ap/DocForm";

export default async function NewPr() {
  const ctx = await requireCtx("journal.create");
  const data = await apFormData(ctx.org.id);
  return (<><div className="top"><h1>New Purchase Request</h1></div>
    <p className="muted">List what you need. After approval, Purchasing canvasses suppliers (RFQ) or orders directly.</p>
    <DocForm mode="PR" data={data} initial={blankHeader()} initialLines={[]} /></>);
}
