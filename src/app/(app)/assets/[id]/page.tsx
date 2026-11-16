import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { today } from "@/lib/format";
import { qrPayload } from "@/lib/assets/audit";
import { OFF_BOOKS, TXN_LABEL, stateOf } from "@/lib/assets/service";
import { assetLifeSchedule } from "@/lib/assets/reports";
import { assetFormData } from "@/lib/assets/form-data";
import { METHOD_LABEL, monthIdx, monthsRemaining } from "@/lib/assets/depreciation";
import { ActionForm } from "@/components/ActionForm";
import { AccountInput, AccountList, LocationList, Pick } from "@/components/AssetPick";
import { PrintButton } from "@/components/PrintButton";
import { assetTxnAction } from "../../asset-actions";

const p = (v: { toString(): string } | null | undefined) => formatPeso(toCentavos(v?.toString() ?? "0"));
const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? "—";

export default async function AssetView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const sp = await searchParams;
  const a = await prisma.fixedAsset.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!a) notFound();
  const [txns, d, life, svg, lastAudit] = await Promise.all([
    prisma.fixedAssetTxn.findMany({ where: { assetId: a.id }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
    assetFormData(ctx.org.id),
    assetLifeSchedule(a),
    QRCode.toString(qrPayload(a.code), { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1E1338", light: "#ffffff" } }),
    a.lastAuditId ? prisma.assetAudit.findUnique({ where: { id: a.lastAuditId } }) : null,
  ]);
  const jes = await prisma.journalEntry.findMany({ where: { id: { in: txns.map((t) => t.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, number: true } });
  const jeNo = new Map(jes.map((j) => [j.id, j.number]));
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(txns.map((t) => t.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const live = !OFF_BOOKS.includes(a.status);
  const nbv = toCentavos(a.cost.toString()) - toCentavos(a.accumulatedDepreciation.toString());
  const left = monthsRemaining(stateOf(a), monthIdx(a.depreciatedThrough ?? new Date()));
  const latest = [...txns].filter((t) => t.status === "POSTED").sort((x, y) => +y.createdAt - +x.createdAt)[0];
  const post = can(ctx.role, "journal.post"), create = can(ctx.role, "journal.create");
  const moved = live && a.lastSeenLocation && a.location && a.lastSeenLocation.trim().toLowerCase() !== a.location.trim().toLowerCase();
  const emp = (code: string | null) => (code ? `${code} ${d.employees.find((e) => e.code === code)?.name ?? ""}` : "—");
  return (
    <>
      <div className="top">
        <h1>{a.code} · {a.name} <span className={`badge ${live ? (a.status === "ACTIVE" ? "POSTED" : "PENDING_APPROVAL") : "VOID"}`}>{a.status.replace("_", " ")}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: "0 0 auto", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
          {can(ctx.role, "masters.manage") && <Link className="btn secondary" href={`/masters/assets/edit?code=${encodeURIComponent(a.code)}`}>Edit master data</Link>}
          <Link className="btn secondary" href={`/assets/stickers?q=${encodeURIComponent(a.code)}`}>Print sticker</Link>
          <PrintButton label="Print" />
        </div>
      </div>
      {sp.saved && <div className="notice">Asset saved.</div>}
      {moved && (
        <div className="notice">Last asset count found this at <b>{a.lastSeenLocation}</b> ({day(a.lastSeenAt)}), but the register says <b>{a.location}</b>.
          {create && <ActionForm action={assetTxnAction} style={{ display: "inline" }}><input type="hidden" name="op" value="accept-location" /><input type="hidden" name="assetId" value={a.id} /> <button className="secondary">Accept new location</button></ActionForm>}
        </div>
      )}
      {a.status === "MISSING" && <div className="errors">Not found in the last asset count{lastAudit ? ` (${lastAudit.number})` : ""}. Scan it in the next count, or retire it if it is lost.</div>}

      <div className="grid2">
        <div className="card grid">
          <div><label>Category</label>{a.category ?? "—"}</div>
          <div><label>Serial no.</label>{a.serialNo ?? "—"}</div>
          <div><label>Location</label>{a.location ?? "—"}</div>
          <div><label>Custodian</label>{emp(a.custodianCode)}</div>
          <div><label>Department / cost center</label>{a.departmentCode ?? "—"} / {a.costCenterCode ?? "—"}</div>
          <div><label>Vendor / PO</label>{a.vendorCode ?? "—"} / {a.poNumber ?? "—"}</div>
          <div><label>Purchased / in service</label>{day(a.acquisitionDate)} / {day(a.inServiceDate)}</div>
          <div><label>Method</label>{METHOD_LABEL[a.depreciationMethod] ?? a.depreciationMethod}</div>
          <div><label>Useful life</label>{a.usefulLifeMonths ? `${a.usefulLifeMonths} months` : "—"}{left !== null && <div className="muted">{left} left</div>}</div>
          <div><label>GL accounts</label>{a.accountCode ?? "—"} / {a.accumDepAccountCode ?? "—"} / {a.depExpenseAccountCode ?? "—"}<div className="muted">cost / accum. / expense</div></div>
          <div><label>Old tag</label>{a.tagCode ?? "—"}</div>
          <div><label>Last seen</label>{a.lastSeenAt ? `${day(a.lastSeenAt)} at ${a.lastSeenLocation ?? "?"}` : a.taggedAt ? "Tagged" : "Never scanned"}{a.condition && <div className="muted">{a.condition.replace("_", " ")}</div>}</div>
        </div>
        <div className="card">
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span style={{ width: 120, display: "block" }} dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="grid" style={{ flex: 1 }}>
              <div className="stat"><div className="n">{p(a.cost)}</div><div className="l">Cost</div></div>
              <div className="stat"><div className="n">{p(a.accumulatedDepreciation)}</div><div className="l">Accumulated depreciation</div></div>
              <div className="stat"><div className="n">{formatPeso(nbv)}</div><div className="l">Net book value</div></div>
              <div className="stat"><div className="n">{p(a.salvageValue)}</div><div className="l">Salvage value</div></div>
            </div>
          </div>
          <p className="muted">Depreciated through {day(a.depreciatedThrough)}{a.disposedAt ? ` · ${a.status.toLowerCase()} ${day(a.disposedAt)}` : ""}</p>
        </div>
      </div>

      <h2>History</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Details</th><th className="num">Cost</th><th className="num">Depreciation</th><th className="num">Accum. change</th><th>Journal</th><th>By</th><th className="noprint" /></tr></thead>
        <tbody>
          {txns.map((t) => {
            const det = (t.details ?? {}) as { from?: Record<string, string | null>; to?: Record<string, string | null>; changed?: string[]; buyer?: string; voidReason?: string };
            const moves = t.type === "TRANSFER" && det.changed ? det.changed.map((k) => `${k.replace("Code", "")}: ${det.from?.[k] ?? "—"} → ${det.to?.[k] ?? "—"}`).join("; ") : "";
            return (
              <tr key={t.id} style={t.status === "VOID" ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                <td>{day(t.date)}</td><td>{t.number}</td><td>{TXN_LABEL[t.type] ?? t.type}</td>
                <td>{t.memo}{moves && <div className="muted">{moves}</div>}{t.gainLoss && Number(t.gainLoss) !== 0 && <div className="muted">{Number(t.gainLoss) > 0 ? "Gain" : "Loss"} {formatPeso(toCentavos(t.gainLoss.toString()) * (Number(t.gainLoss) > 0 ? 1n : -1n))}{det.buyer ? ` · ${det.buyer}` : ""}</div>}{t.lifeChangeMonths ? <div className="muted">Life +{t.lifeChangeMonths} months</div> : null}{det.voidReason && <div className="muted">Undone: {det.voidReason}</div>}</td>
                <td className="num">{Number(t.costChange) ? p(t.costChange) : ""}</td>
                <td className="num">{Number(t.depreciation) ? p(t.depreciation) : ""}</td>
                <td className="num">{Number(t.accumChange) ? p(t.accumChange) : ""}</td>
                <td>{t.journalEntryId ? <Link href={`/journals/${t.journalEntryId}`}>{jeNo.get(t.journalEntryId)}</Link> : t.type === "TRANSFER" ? "No GL effect" : t.type === "OPENING" ? "Already in GL" : ""}</td>
                <td>{users.get(t.createdById) ?? (t.createdById === "system" ? "System" : "")}</td>
                <td className="noprint">{post && latest?.id === t.id && !["DEPRECIATION", "OPENING"].includes(t.type) && (
                  <details><summary>Undo</summary>
                    <ActionForm action={assetTxnAction} confirm="Undo this transaction? Its journal entry is reversed.">
                      <input type="hidden" name="op" value="void" /><input type="hidden" name="assetId" value={a.id} /><input type="hidden" name="txnId" value={t.id} />
                      <input name="reason" placeholder="Reason" required /> <button className="secondary">Undo</button>
                    </ActionForm>
                  </details>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>

      {live && (create || post) && <div className="noprint">
        <AccountList d={d} /><LocationList d={d} />
        <h2>Transactions</h2>
        {create && <details className="card"><summary><b>Transfer</b>: new location, custodian, department or cost center</summary>
          <ActionForm action={assetTxnAction}>
            <input type="hidden" name="op" value="transfer" /><input type="hidden" name="assetId" value={a.id} />
            <div className="grid">
              <div><label>Date</label><input type="date" name="date" defaultValue={today()} /></div>
              <div><label>Location</label><input name="location" list="fa-locations" defaultValue={a.location ?? ""} /></div>
              <Pick name="custodianCode" label="Custodian" options={d.employees} value={a.custodianCode} />
              <Pick name="departmentCode" label="Department" options={d.departments} value={a.departmentCode} />
              <Pick name="costCenterCode" label="Cost center" options={d.costCenters} value={a.costCenterCode} />
              <div><label>Reference</label><input name="reference" placeholder="e.g. transfer slip no." /></div>
              <div><label>Notes</label><input name="memo" /></div>
            </div>
            <button>Record transfer</button> <span className="muted">No GL entry; depreciation from the next run is charged to the new department / cost center.</span>
          </ActionForm>
        </details>}
        {post && <details className="card"><summary><b>Improvement</b>: capitalize an upgrade or major repair that adds future benefit</summary>
          <ActionForm action={assetTxnAction}>
            <input type="hidden" name="op" value="improve" /><input type="hidden" name="assetId" value={a.id} />
            <div className="grid">
              <div><label>Date</label><input type="date" name="date" defaultValue={today()} /></div>
              <div><label>Amount capitalized</label><input name="amount" required inputMode="decimal" /></div>
              <div><label>Extend useful life by (months)</label><input name="extendLifeMonths" inputMode="numeric" placeholder="0" /></div>
              <div><label>What was done</label><input name="memo" required placeholder="e.g. engine overhaul" /></div>
              <div><label>Post to the GL?</label><select name="postToGl" defaultValue="yes"><option value="yes">Yes: Dr asset / Cr account below</option><option value="no">No: already booked (AP bill)</option></select></div>
              <AccountInput name="offsetAccountCode" label="Account to credit" placeholder="e.g. 2010" />
              <Pick name="vendorCode" label="Vendor" options={d.vendors} value={a.vendorCode} />
              <div><label>Reference</label><input name="reference" /></div>
            </div>
            <button>Capitalize</button> <span className="muted">Routine repairs and maintenance are expenses, not improvements (PAS 16.12).</span>
          </ActionForm>
        </details>}
        {post && <details className="card"><summary><b>Sale / disposal</b></summary>
          <ActionForm action={assetTxnAction} confirm="Post the sale? Depreciation to the sale date, removal of cost and accumulated depreciation, and the gain or loss go to the GL.">
            <input type="hidden" name="op" value="dispose" /><input type="hidden" name="assetId" value={a.id} />
            <div className="grid">
              <div><label>Date sold</label><input type="date" name="date" defaultValue={today()} /></div>
              <div><label>Selling price (net of VAT)</label><input name="proceeds" inputMode="decimal" required /></div>
              <div><label>Output VAT</label><input name="outputVat" inputMode="decimal" placeholder="0.00" /><div className="muted" style={{ fontSize: 12 }}>12% if your company is VAT-registered.</div></div>
              <AccountInput name="proceedsAccountCode" label="Debit (cash or receivable)" placeholder="e.g. 1020 or 1100" />
              <div><label>Buyer</label><input name="buyer" /></div>
              <Pick name="customerCode" label="Customer (if on account)" options={d.customers} />
              <AccountInput name="gainLossAccountCode" label="Gain / loss account" placeholder="Blank = 7030 gain or 7545 loss" />
              <div><label>Reference</label><input name="reference" placeholder="e.g. deed of sale, SI no." /></div>
              <div><label>Notes</label><input name="memo" required placeholder="e.g. sold to employee" /></div>
            </div>
            <button>Post sale</button>
          </ActionForm>
        </details>}
        {post && <details className="card"><summary><b>Retirement / write-off</b>: scrapped, lost, stolen or donated</summary>
          <ActionForm action={assetTxnAction} confirm="Retire this asset? Its net book value is written off as a loss.">
            <input type="hidden" name="op" value="retire" /><input type="hidden" name="assetId" value={a.id} />
            <div className="grid">
              <div><label>Date</label><input type="date" name="date" defaultValue={today()} /></div>
              <div><label>Reason</label><input name="memo" required placeholder="e.g. beyond repair, scrapped" /></div>
              <AccountInput name="gainLossAccountCode" label="Loss account" placeholder="Blank = 7545" />
              <div><label>Reference</label><input name="reference" placeholder="e.g. incident report no." /></div>
            </div>
            <button>Retire asset</button>
          </ActionForm>
        </details>}
      </div>}

      {life.length > 0 && <>
        <h2>Depreciation still to come</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Year</th><th className="num">Months</th><th className="num">Depreciation</th><th className="num">Net book value at year end</th></tr></thead>
          <tbody>{life.map((y) => <tr key={y.year}><td>{y.year}</td><td className="num">{y.months}</td><td className="num">{formatPeso(y.depreciation)}</td><td className="num">{formatPeso(y.closingNbv)}</td></tr>)}</tbody>
        </table></div>
      </>}
    </>
  );
}
