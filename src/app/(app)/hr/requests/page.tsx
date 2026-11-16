import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RequestList } from "@/components/HrRequests";

export default async function HrRequests({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireCtx("hr.manage");
  const status = (await searchParams).status ?? "PENDING";
  const reqs = await prisma.hrRequest.findMany({ where: { organizationId: ctx.org.id, ...(status === "ALL" ? {} : { status }) }, include: { employee: true }, orderBy: { createdAt: "desc" }, take: 300 });
  return (
    <>
      <div className="top"><h1>Employee Requests</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><select name="status" defaultValue={status}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>CANCELLED</option><option value="ALL">All</option></select></div><div style={{ flex: 0 }}><button className="secondary">Show</button></div></form></div>
      <p className="muted">Leave, overtime, time amendments and schedule changes. Each goes to the employee's reporting manager; HR can also decide any request here.</p>
      <RequestList organizationId={ctx.org.id} requests={reqs} canDecide />
    </>
  );
}
