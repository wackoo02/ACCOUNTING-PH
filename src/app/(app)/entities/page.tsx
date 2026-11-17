import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { entityTree } from "@/lib/group";
import { ActionForm } from "@/components/ActionForm";
import { createEntity, setupIntercompanyAction } from "../actions";
import { MasterPicker } from "@/components/MasterPicker";

export default async function Entities() {
  const ctx = await requireCtx();
  const tree = await entityTree(ctx.user.id);
  const links = await prisma.intercompanyLink.findMany({ where: { organizationId: ctx.org.id }, include: { counterparty: true } });
  const accts = await prisma.account.findMany({ where: { id: { in: links.flatMap((l) => [l.dueFromAccountId, l.dueToAccountId]) } } });
  const name = (id: string) => { const a = accts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ""; };
  const admins = tree.filter((o) => o.role === "OWNER" || o.role === "ADMIN");
  return (
    <>
      <div className="top"><h1>Entities and Intercompany</h1></div>
      <p className="muted">Each entity (company, subsidiary, branch) keeps its own books, chart of accounts and BIR registration. The hierarchy drives the consolidated reports.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Entity</th><th>Company code</th><th>Type</th><th>TIN</th><th className="num">Parent ownership</th><th>Your role</th></tr></thead>
        <tbody>
          {tree.map((o) => (
            <tr key={o.id} className={o.id === ctx.org.id ? "header" : ""}>
              <td style={{ paddingLeft: 8 + o.depth * 22 }}>{o.depth > 0 ? "└ " : ""}{o.name}{o.id === ctx.org.id ? " (current)" : ""}</td>
              <td>{o.code ?? "—"}</td><td>{o.entityType}</td><td>{o.tin ?? ""}</td>
              <td className="num">{o.parentId ? `${o.ownershipPct.toString()}%` : ""}</td><td>{o.role}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>Add an entity</h2>
      <ActionForm action={createEntity} className="card">
        <div className="row">
          <div style={{ flex: 2 }}><label>Registered name</label><input name="name" required /></div>
          <div><label>Company code</label><input name="code" required placeholder="e.g. SUB1" /></div>
          <div><label>TIN</label><input name="tin" /></div>
          <div><label>Type</label><select name="entityType" defaultValue="SUBSIDIARY"><option>COMPANY</option><option>SUBSIDIARY</option><option>BRANCH</option><option>DIVISION</option></select></div>
          <div><label>Parent entity</label><MasterPicker name="parentId" ariaLabel="Parent entity" defaultValue={ctx.org.id} emptyLabel="None (top level)" placeholder="None (top level)" options={admins.map((o) => ({ value: o.id, label: o.name }))} /></div>
          <div><label>Ownership %</label><input name="ownershipPct" defaultValue="100" /></div>
          <div style={{ flex: 0 }}><button>Create</button></div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>The new entity gets the standard PH chart of accounts. You become its owner.</p>
      </ActionForm>

      <h2>Intercompany accounts for {ctx.org.name}</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Counterparty</th><th>Due from (receivable)</th><th>Due to (payable)</th></tr></thead>
        <tbody>
          {links.map((l) => <tr key={l.id}><td>{l.counterparty.name}</td><td>{name(l.dueFromAccountId)}</td><td>{name(l.dueToAccountId)}</td></tr>)}
          {links.length === 0 && <tr><td colSpan={3} className="muted">None set up yet.</td></tr>}
        </tbody>
      </table></div>
      {admins.filter((o) => o.id !== ctx.org.id && !links.some((l) => l.counterpartyOrgId === o.id)).length > 0 && (
        <ActionForm action={setupIntercompanyAction} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <div style={{ flex: 3 }}><label>Set up intercompany with</label>
              <MasterPicker name="counterpartyId" ariaLabel="Counterparty entity" options={admins.filter((o) => o.id !== ctx.org.id && !links.some((l) => l.counterpartyOrgId === o.id)).map((o) => ({ value: o.id, label: o.name }))} required /></div>
            <div style={{ flex: 0 }}><button>Create Due from / Due to accounts</button></div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>Creates a Due from and a Due to account in both entities and links them, so intercompany entries balance and eliminate on consolidation.</p>
        </ActionForm>
      )}
    </>
  );
}
