import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { updateEntity } from "../actions";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default async function Settings() {
  const ctx = await requireCtx("org.manage");
  const o = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  return (
    <>
      <div className="top"><h1>Company Settings</h1></div>
      <ActionForm action={updateEntity} className="card">
        <h2 style={{ marginTop: 0 }}>Company</h2>
        <div className="row">
          <div style={{ flex: 2 }}><label>Registered name</label><input name="name" defaultValue={o.name} required /></div>
          <div><label>Company code</label><input name="code" defaultValue={o.code ?? ""} /></div>
          <div><label>TIN</label><input name="tin" defaultValue={o.tin ?? ""} /></div>
          <div><label>RDO code</label><input name="rdoCode" defaultValue={o.rdoCode ?? ""} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 3 }}><label>Registered address</label><input name="registeredAddress" defaultValue={o.registeredAddress ?? ""} /></div>
          <div><label>Fiscal year starts in</label><select name="fiscalYearStartMonth" defaultValue={o.fiscalYearStartMonth}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
          <div><label>Base / reporting currency</label><input value={o.baseCurrency} readOnly /></div>
        </div>
        <label style={{ display: "flex", gap: 6, marginTop: 10, color: "var(--ink)" }}><input type="checkbox" name="vatRegistered" defaultChecked={o.vatRegistered} style={{ width: "auto" }} /> VAT registered</label>
        <h2>Controls</h2>
        <label style={{ display: "flex", gap: 6, color: "var(--ink)" }}><input type="checkbox" name="requireApproval" defaultChecked={o.requireApproval} style={{ width: "auto" }} /> Posting approval workflow: manual journal entries must be submitted and approved before they post</label>
        <label style={{ display: "flex", gap: 6, marginTop: 6, color: "var(--ink)" }}><input type="checkbox" name="segregationOfDuties" defaultChecked={o.segregationOfDuties} style={{ width: "auto" }} /> Segregation of duties: the person who prepared or edited an entry cannot approve it</label>
        <p className="muted">Approval limits per person are set in Users and Roles. Restrict accounts to sub-ledger postings with &quot;Allow Manual Journals&quot; in the Chart of Accounts. Month and year locks are under Fiscal Periods.</p>
        <button>Save settings</button>
      </ActionForm>
    </>
  );
}
