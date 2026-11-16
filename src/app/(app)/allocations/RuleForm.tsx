"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { saveAllocationRule } from "../actions";

type Opt = { id: string; code: string; name: string };
export function RuleForm({ accounts, dims, types }: { accounts: Opt[]; dims: (Opt & { type: string })[]; types: { type: string; label: string }[] }) {
  const [type, setType] = useState(types.find((t) => dims.some((d) => d.type === t.type))?.type ?? "DEPARTMENT");
  const [splits, setSplits] = useState([{ dimensionValueId: "", pct: "" }, { dimensionValueId: "", pct: "" }]);
  const vals = dims.filter((d) => d.type === type);
  const total = splits.reduce((t, s) => t + (Number(s.pct) || 0), 0);
  return (
    <ActionForm action={saveAllocationRule} className="card">
      <input type="hidden" name="splits" value={JSON.stringify(splits)} />
      <div className="row">
        <div><label>Rule name</label><input name="name" required placeholder="e.g. Rent by department" /></div>
        <div><label>Allocate from account</label><select name="sourceAccountId" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
        <div><label>To account</label><select name="targetAccountId"><option value="">Same account</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
        <div><label>Split by</label><select name="dimensionType" value={type} onChange={(e) => { setType(e.target.value); setSplits(splits.map((s) => ({ ...s, dimensionValueId: "" }))); }}>
          {types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></div>
      </div>
      {splits.map((s, i) => (
        <div className="row" key={i} style={{ marginTop: 6 }}>
          <div style={{ flex: 3 }}><select value={s.dimensionValueId} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, dimensionValueId: e.target.value } : x)))}>
            <option value="">Choose…</option>{vals.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}</select></div>
          <div><input className="num" placeholder="%" value={s.pct} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} /></div>
          <div style={{ flex: 0 }}>{splits.length > 2 && <button type="button" className="link" onClick={() => setSplits(splits.filter((_, j) => j !== i))}>✕</button>}</div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button type="button" className="secondary" onClick={() => setSplits([...splits, { dimensionValueId: "", pct: "" }])}>+ Add split</button>
        <span className={Math.abs(total - 100) < 0.001 ? "diff-ok" : "diff-bad"}>Total {total}%</span>
        <button>Save rule</button>
      </div>
      {vals.length === 0 && <p className="muted">No values for this dimension yet. Add them under Master Lists → Dimensions.</p>}
    </ActionForm>
  );
}
