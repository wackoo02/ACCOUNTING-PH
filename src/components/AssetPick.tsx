// Pick lists shared by the fixed asset forms: type-ahead comboboxes over the master lists (values are codes).
import type { AssetFormData } from "@/lib/assets/form-data";
import type { AddTarget } from "./MasterLookup";
import { MasterPicker } from "./MasterPicker";
import { codeOpts, dimTypeAdd } from "@/lib/lookup";

type Opt = { code: string; name: string };
const ADD: Record<string, AddTarget> = {
  departmentCode: dimTypeAdd("DEPARTMENT"), costCenterCode: dimTypeAdd("COST_CENTER"),
  custodianCode: { kind: "employees" }, vendorCode: { kind: "vendors" }, customerCode: { kind: "customers" },
};
export function Pick({ name, label, options, value, blank = "—", required }: { name: string; label: string; options: Opt[]; value?: string | null; blank?: string; required?: boolean }) {
  return (
    <div><label>{label}</label>
      <MasterPicker name={name} ariaLabel={label} options={codeOpts(options)} defaultValue={value ?? ""} required={required} emptyLabel={blank} placeholder={blank} add={ADD[name]} valueIsCode />
    </div>
  );
}

/** Account code field with type-ahead from the chart of accounts. */
export function AccountInput({ d, name, label, value, placeholder, help }: { d: AssetFormData; name: string; label: string; value?: string | null; placeholder?: string; help?: string }) {
  return (
    <div><label>{label}</label>
      <MasterPicker name={name} ariaLabel={label} options={codeOpts(d.accounts)} defaultValue={value ?? ""} emptyLabel={placeholder ?? "—"} placeholder={placeholder} add={{ kind: "accounts" }} valueIsCode />
      {help && <div className="muted" style={{ fontSize: 12 }}>{help}</div>}
    </div>
  );
}
/** Kept for the asset pages; account fields carry their own list now. */
export function AccountList(_: { d: AssetFormData }) {
  return null;
}
export function LocationList({ d }: { d: AssetFormData }) {
  return <datalist id="fa-locations">{d.locations.map((l) => <option key={l} value={l} />)}</datalist>;
}
