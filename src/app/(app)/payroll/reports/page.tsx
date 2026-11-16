import { requireCtx } from "@/lib/auth";
import { manilaToday } from "@/lib/payroll/attendance";

export default async function PayrollReports() {
  await requireCtx("payroll.process");
  const t = manilaToday(), y = t.slice(0, 4), m1 = `${t.slice(0, 8)}01`;
  const Report = ({ doc, title, help, period }: { doc: string; title: string; help: string; period: "range" | "year" }) => (
    <form className="card" action="/api/payroll/pdf" target="_blank">
      <input type="hidden" name="doc" value={doc} />
      <h2 style={{ marginTop: 0 }}>{title}</h2><p className="muted" style={{ marginTop: 0 }}>{help}</p>
      <div className="row">
        {period === "range" ? <><div><label>Paid from</label><input type="date" name="from" defaultValue={m1} /></div><div><label>to</label><input type="date" name="to" defaultValue={t} /></div></>
          : <div><label>Year</label><input name="year" type="number" defaultValue={y} /></div>}
        <div style={{ flex: 0 }}><button>Open PDF</button></div>
      </div>
    </form>
  );
  return (
    <>
      <div className="top"><h1>Payroll Reports</h1></div>
      <p className="muted">All payroll and HR reports are PDF. They include finalized payrolls only. The payroll register of each run is on the run's page.</p>
      <Report doc="labor" title="Labor cost by department" help="Salaries, overtime and employer contributions and benefits per department and cost center." period="range" />
      <Report doc="tax" title="Tax and contributions report" help="Per employee taxable compensation and tax withheld (basis for BIR 1601-C), plus SSS, PhilHealth and Pag-IBIG employee and employer shares to remit." period="range" />
      <Report doc="earnings" title="Employee earnings summary" help="Year-to-date basic, overtime, holiday and night pay, allowances, 13th month and bonuses, tax and net pay per employee." period="year" />
      <form className="card" action="/api/payroll/pdf" target="_blank">
        <input type="hidden" name="doc" value="attendance" /><input type="hidden" name="scope" value="all" />
        <h2 style={{ marginTop: 0 }}>Attendance summary (all employees)</h2>
        <div className="row"><div><label>From</label><input type="date" name="from" defaultValue={m1} /></div><div><label>to</label><input type="date" name="to" defaultValue={t} /></div><div style={{ flex: 0 }}><button>Open PDF</button></div></div>
      </form>
      <form className="card" action="/api/payroll/pdf" target="_blank">
        <input type="hidden" name="doc" value="leave" /><input type="hidden" name="scope" value="all" />
        <h2 style={{ marginTop: 0 }}>Leave balances and requests (all employees)</h2>
        <div className="row"><div><label>Year</label><input name="year" type="number" defaultValue={y} /></div><div style={{ flex: 0 }}><button>Open PDF</button></div></div>
      </form>
    </>
  );
}
