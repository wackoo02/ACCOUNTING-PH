// Native pick lists shared by the fixed asset forms (server-rendered, no client JS).
import type { AssetFormData } from "@/lib/assets/form-data";

type Opt = { code: string; name: string };
export function Pick({ name, label, options, value, blank = "—", required }: { name: string; label: string; options: Opt[]; value?: string | null; blank?: string; required?: boolean }) {
  return (
    <div><label>{label}</label>
      <select name={name} defaultValue={value ?? ""} required={required}>
        <option value="">{blank}</option>
        {options.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
      </select>
    </div>
  );
}

/** Account code input with type-ahead from the chart of accounts. */
export function AccountInput({ name, label, value, placeholder, help }: { name: string; label: string; value?: string | null; placeholder?: string; help?: string }) {
  return <div><label>{label}</label><input name={name} list="fa-accounts" defaultValue={value ?? ""} placeholder={placeholder} />{help && <div className="muted" style={{ fontSize: 12 }}>{help}</div>}</div>;
}
export function AccountList({ d }: { d: AssetFormData }) {
  return <datalist id="fa-accounts">{d.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</datalist>;
}
export function LocationList({ d }: { d: AssetFormData }) {
  return <datalist id="fa-locations">{d.locations.map((l) => <option key={l} value={l} />)}</datalist>;
}
