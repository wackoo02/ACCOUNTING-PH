import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { today } from "@/lib/format";
import { assetFormData } from "@/lib/assets/form-data";
import { METHOD_LABEL } from "@/lib/assets/depreciation";
import { ActionForm } from "@/components/ActionForm";
import { AccountInput, AccountList, LocationList, Pick } from "@/components/AssetPick";
import { addAssetAction } from "../../asset-actions";

export default async function NewAsset() {
  const ctx = await requireCtx("reports.view");
  const d = await assetFormData(ctx.org.id);
  return (
    <>
      <div className="top"><h1>New asset (addition)</h1></div>
      {d.categories.length === 0 && <div className="notice">Set up <Link href="/masters/asset-categories">asset categories</Link> first: they give each new asset its GL accounts, useful life and numbering.</div>}
      <ActionForm action={addAssetAction}>
        <AccountList d={d} /><LocationList d={d} />
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Asset</h3>
          <div className="grid">
            <div><label>Description *</label><input name="name" required placeholder="e.g. Dell Latitude 5440 laptop" /></div>
            <div><label>Category *</label><select name="categoryCode" required defaultValue=""><option value="" disabled>Choose…</option>{d.categories.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.usefulLifeMonths} mo., {c.prefix ?? "FA"}-…)</option>)}</select></div>
            <div><label>Asset no.</label><input name="code" placeholder="Blank = next number for the category" /></div>
            <div><label>Serial no.</label><input name="serialNo" /></div>
            <div><label>Location</label><input name="location" list="fa-locations" placeholder="e.g. Makati HQ - 5F" /></div>
            <Pick name="departmentCode" label="Department" options={d.departments} />
            <Pick name="costCenterCode" label="Cost center" options={d.costCenters} />
            <Pick name="custodianCode" label="Custodian / owner" options={d.employees} />
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Purchase and depreciation</h3>
          <div className="grid">
            <Pick name="vendorCode" label="Vendor" options={d.vendors} />
            <div><label>PO / supplier invoice no.</label><input name="poNumber" /></div>
            <div><label>Purchase date *</label><input type="date" name="acquisitionDate" required defaultValue={today()} /></div>
            <div><label>In-service date</label><input type="date" name="inServiceDate" /><div className="muted" style={{ fontSize: 12 }}>Blank = purchase date. On or before the 15th depreciates from that month.</div></div>
            <div><label>Acquisition cost *</label><input name="cost" required inputMode="decimal" placeholder="0.00" /><div className="muted" style={{ fontSize: 12 }}>Purchase price plus costs to bring it to use, net of VAT you can claim.</div></div>
            <div><label>Salvage value</label><input name="salvageValue" inputMode="decimal" placeholder="Blank = category %" /></div>
            <div><label>Useful life (months)</label><input name="usefulLifeMonths" inputMode="numeric" placeholder="Blank = category" /></div>
            <div><label>Method</label><select name="depreciationMethod" defaultValue=""><option value="">Category default</option>{Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <AccountInput name="accountCode" label="GL asset account" placeholder="Blank = category" />
            <AccountInput name="accumDepAccountCode" label="Accumulated depreciation account" placeholder="Blank = category" />
            <AccountInput name="depExpenseAccountCode" label="Depreciation expense account" placeholder="Blank = category" />
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Accounting entry</h3>
          <div className="grid">
            <div><label>Post to the GL?</label><select name="postToGl" defaultValue="yes">
              <option value="yes">Yes: Dr asset account / Cr the account below</option>
              <option value="no">No: already in the books (AP bill, opening balance)</option>
            </select></div>
            <AccountInput name="offsetAccountCode" label="Account to credit" placeholder="e.g. 2010 Accounts Payable, 1020 Cash in bank" help="When posting. Use Accounts Payable when the supplier bill is not yet in Veritus." />
            <div><label>Reference</label><input name="reference" placeholder="e.g. SI 12345" /></div>
            <div><label>Notes</label><input name="memo" /></div>
            <div><label>Opening accumulated depreciation</label><input name="openingAccum" inputMode="decimal" placeholder="Only when not posting" /></div>
            <div><label>…depreciated through</label><input type="date" name="depreciatedThrough" /><div className="muted" style={{ fontSize: 12 }}>Last month-end covered, e.g. 2025-12-31.</div></div>
          </div>
        </div>
        <button>Save asset</button>
      </ActionForm>
    </>
  );
}
