"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";
import type { mobilitySetup } from "@/lib/expense/service";
import { ApiFail, api, loadSession, saveSession, setCurrent, setUnauthorizedHandler, type Session } from "./api";
import { Errors, Spinner, Tile, Toaster } from "./ui";
import { Capture } from "./Capture";
import { ClaimDetail, ClaimList } from "./Claims";
import { SalesScan } from "./Sales";
import { AssetAudit } from "./Assets";
import { Insights } from "./Insights";

export type Setup = Awaited<ReturnType<typeof mobilitySetup>>;
export type Me = { user: { id: string; name: string; email: string }; company: { id: string; name: string }; role: string; can: Record<string, boolean>; companies: { id: string; name: string; role: string }[] };
export type ModuleKey = "PETTY_CASH" | "TRAVEL" | "TRANSPORT" | "DELIVERY";
export type Screen =
  | { name: "home" } | { name: "capture"; module: ModuleKey; id?: string } | { name: "claims"; queue?: "mine" | "manager" | "finance" }
  | { name: "claim"; id: string; from?: "mine" | "manager" | "finance" } | { name: "sales" } | { name: "assets" } | { name: "insights" } | { name: "profile" };
export type Nav = { go: (s: Screen) => void; back: () => void };

export function MobileApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const s = loadSession();
    setCurrent(s); setSession(s); setReady(true);
    setUnauthorizedHandler(() => { saveSession(null); setCurrent(null); setSession(null); });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  if (!ready) return <Splash />;
  return (
    <>
      {session ? <Signed session={session} onSession={(s) => { saveSession(s); setCurrent(s); setSession(s); }} /> : <Login onSession={(s) => { saveSession(s); setCurrent(s); setSession(s); }} />}
      <Toaster />
    </>
  );
}

function Splash() {
  return <div className="vm-splash"><div className="mark"><LogoMark size={76} /></div><div className="name">VERITUS</div><div className="tag">Mobility</div></div>;
}

function Login({ onSession }: { onSession: (s: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors([]);
    try {
      const r = await api<{ token: string; user: Session["user"]; companies: Session["companies"] }>("POST", "auth/login", { email, password });
      onSession({ token: r.token, user: r.user, companies: r.companies, companyId: r.companies[0].id });
    } catch (err) {
      setErrors(err instanceof ApiFail ? err.errors : ["Cannot reach the server. Check your connection."]);
    } finally { setBusy(false); }
  };
  return (
    <div className="vm-login">
      <div className="vm-login-hero">
        <div className="orb o1" /><div className="orb o2" /><div className="orb o3" />
        <div className="mark"><LogoMark size={64} /></div>
        <div className="name">VERITUS</div>
        <div className="tag">Mobility</div>
        <p>Receipts, trips, deliveries, sales invoices and asset counts. Straight to your books.</p>
      </div>
      <form className="vm-card vm-login-card" onSubmit={submit}>
        <Errors errors={errors} />
        <label className="vm-field"><span className="l">Work email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="vm-field"><span className="l">Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="vm-btn primary block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="vm-fine">Same account as Veritus ERP on the web.</p>
      </form>
    </div>
  );
}

function Signed({ session, onSession }: { session: Session; onSession: (s: Session | null) => void }) {
  const [stack, setStack] = useState<Screen[]>([{ name: "home" }]);
  const [me, setMe] = useState<Me | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [counts, setCounts] = useState<{ manager: number; finance: number; returned: number }>({ manager: 0, finance: 0, returned: 0 });
  const [err, setErr] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("GET", "me");
      setMe(m);
      const [s, mq, fq, ret] = await Promise.all([
        m.can.capture ? api<Setup>("GET", "mobility/setup") : Promise.resolve(null),
        api<unknown[]>("GET", "vouchers?queue=manager").catch(() => []),
        m.can.finance ? api<unknown[]>("GET", "vouchers?queue=finance").catch(() => []) : Promise.resolve([]),
        api<unknown[]>("GET", "vouchers?mine=1&status=RETURNED").catch(() => []),
      ]);
      setSetup(s);
      setCounts({ manager: mq.length, finance: fq.length, returned: ret.length });
    } catch (e) {
      setErr(e instanceof ApiFail ? e.errors : ["Cannot reach the server"]);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh, session.companyId]);

  const screen = stack[stack.length - 1];
  const nav: Nav = {
    go: (s) => { setStack((st) => [...st, s]); window.scrollTo(0, 0); },
    back: () => { setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)); refresh(); window.scrollTo(0, 0); },
  };
  const tab = (s: Screen) => { setStack([s]); refresh(); window.scrollTo(0, 0); };

  if (err) return <div className="vm-page"><Errors errors={err} /><button className="vm-btn" onClick={() => { setErr(null); refresh(); }}>Try again</button><button className="vm-btn ghost" onClick={() => onSession(null)}>Sign out</button></div>;
  if (!me) return <Splash />;

  let body: React.ReactNode;
  switch (screen.name) {
    case "home": body = <Home me={me} setup={setup} counts={counts} nav={nav} />; break;
    case "capture": body = setup ? <Capture key={`${screen.module}${screen.id ?? ""}`} module={screen.module} id={screen.id} setup={setup} me={me} nav={nav} /> : <Spinner />; break;
    case "claims": body = <ClaimList key={screen.queue ?? "mine"} queue={screen.queue ?? "mine"} me={me} nav={nav} />; break;
    case "claim": body = <ClaimDetail key={screen.id} id={screen.id} from={screen.from ?? "mine"} me={me} setup={setup} nav={nav} />; break;
    case "sales": body = <SalesScan setup={setup} nav={nav} />; break;
    case "assets": body = <AssetAudit me={me} nav={nav} />; break;
    case "insights": body = <Insights nav={nav} />; break;
    case "profile": body = <Profile me={me} session={session} setup={setup} onSession={onSession} />; break;
  }
  const active = screen.name === "claims" || screen.name === "claim" ? "claims" : screen.name === "profile" ? "profile" : screen.name === "insights" ? "insights" : "home";
  return (
    <div className="vm-app">
      <div className="vm-screen" key={stack.length + screen.name}>{body}</div>
      <nav className="vm-tabbar">
        <button className={active === "home" ? "on" : ""} onClick={() => tab({ name: "home" })}><Icon name="dashboard" size={22} /><span>Home</span></button>
        <button className={active === "claims" ? "on" : ""} onClick={() => tab({ name: "claims", queue: "mine" })}><Icon name="claims" size={22} /><span>My claims</span>{counts.returned > 0 && <i className="dot" />}</button>
        <button className="vm-fab" onClick={() => nav.go({ name: "capture", module: "TRANSPORT" })} aria-label="Quick capture"><Icon name="camera" size={26} /></button>
        <button className={active === "insights" ? "on" : ""} onClick={() => tab({ name: "insights" })} disabled={!me.can.reports}><Icon name="activity" size={22} /><span>Insights</span></button>
        <button className={active === "profile" ? "on" : ""} onClick={() => tab({ name: "profile" })}><Icon name="users" size={22} /><span>Me</span></button>
      </nav>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Home({ me, setup, counts, nav }: { me: Me; setup: Setup | null; counts: { manager: number; finance: number; returned: number }; nav: Nav }) {
  const first = me.user.name.split(" ")[0];
  const tiles: { icon: Parameters<typeof Tile>[0]["icon"]; label: string; blurb: string; tone: Parameters<typeof Tile>[0]["tone"]; go: () => void; show: boolean }[] = [
    { icon: "petty-cash", label: "Petty Cash", blurb: "Fund receipts", tone: "purple", go: () => nav.go({ name: "capture", module: "PETTY_CASH" }), show: !!me.can.capture },
    { icon: "travel", label: "Travel", blurb: "Local & abroad", tone: "sky", go: () => nav.go({ name: "capture", module: "TRAVEL" }), show: !!me.can.capture },
    { icon: "transport", label: "Transport", blurb: "Grab · inDrive · JoyRide", tone: "orange", go: () => nav.go({ name: "capture", module: "TRANSPORT" }), show: !!me.can.capture },
    { icon: "sent-package", label: "Sent Package", blurb: "Lalamove · Transportify", tone: "teal", go: () => nav.go({ name: "capture", module: "DELIVERY" }), show: !!me.can.capture },
    { icon: "receipt", label: "Sales Invoice", blurb: "Scan & post", tone: "rose", go: () => nav.go({ name: "sales" }), show: !!me.can.sales },
    { icon: "asset-audit", label: "Asset Audit", blurb: "Scan QR tags", tone: "ink", go: () => nav.go({ name: "assets" }), show: !!me.can.assetAudit },
  ];
  return (
    <div className="vm-page home">
      <div className="vm-hero">
        <div className="orb o1" /><div className="orb o2" />
        <div className="row"><LogoMark size={34} /><div className="co">{me.company.name}</div></div>
        <div className="hi">{greeting()}, {first}</div>
        <div className="sub">{setup?.me ? `${setup.me.code} · ${setup.me.department ?? ""}` : "Your user is not linked to an employee record yet"}</div>
      </div>
      {counts.returned > 0 && (
        <button className="vm-alert" onClick={() => nav.go({ name: "claims", queue: "mine" })}>
          <Icon name="claims" size={20} /><span>{counts.returned} claim{counts.returned === 1 ? "" : "s"} returned to you. Tap to fix.</span>
        </button>
      )}
      <div className="vm-grid">
        {tiles.filter((t) => t.show).map((t, i) => <Tile key={t.label} icon={t.icon} label={t.label} blurb={t.blurb} tone={t.tone} delay={60 + i * 55} onClick={t.go} />)}
      </div>
      {(counts.manager > 0 || me.can.approve || me.can.finance) && (
        <div className="vm-section">
          <div className="vm-section-t">To review</div>
          <div className="vm-list">
            <button className="vm-row" onClick={() => nav.go({ name: "claims", queue: "manager" })}>
              <span className="ic"><Icon name="approvals" size={20} /></span><span className="m"><b>Manager approvals</b><small>Business purpose, budget, cost center</small></span>
              {counts.manager > 0 && <span className="vm-count">{counts.manager}</span>}
            </button>
            {me.can.finance && (
              <button className="vm-row" onClick={() => nav.go({ name: "claims", queue: "finance" })}>
                <span className="ic"><Icon name="audit" size={20} /></span><span className="m"><b>Finance review</b><small>Receipt, tax and duplicate checks</small></span>
                {counts.finance > 0 && <span className="vm-count">{counts.finance}</span>}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Profile({ me, session, setup, onSession }: { me: Me; session: Session; setup: Setup | null; onSession: (s: Session | null) => void }) {
  return (
    <div className="vm-page">
      <div className="vm-card center">
        <div className="vm-avatar">{me.user.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</div>
        <div className="vm-h2">{me.user.name}</div>
        <div className="muted">{me.user.email}</div>
        <div className="muted">{me.role.toLowerCase()} · {me.company.name}</div>
        {setup?.me && <div className="muted">Employee {setup.me.code}{setup.me.supervisorCode ? ` · approver ${setup.me.supervisorCode}` : ""}</div>}
      </div>
      {session.companies.length > 1 && (
        <div className="vm-card">
          <div className="vm-section-t">Company</div>
          {session.companies.map((c) => (
            <button key={c.id} className={`vm-row ${c.id === session.companyId ? "sel" : ""}`} onClick={() => onSession({ ...session, companyId: c.id })}>
              <span className="m"><b>{c.name}</b><small>{c.role.toLowerCase()}</small></span>{c.id === session.companyId && <span className="vm-pill green">Active</span>}
            </button>
          ))}
        </div>
      )}
      <div className="vm-card">
        <div className="vm-section-t">Install on your phone</div>
        <p className="muted">iPhone: open in Safari, tap Share, then Add to Home Screen. Android: open in Chrome, tap the menu, then Install app.</p>
      </div>
      <button className="vm-btn ghost block" onClick={async () => { await api("POST", "auth/logout").catch(() => {}); onSession(null); }}>Sign out</button>
    </div>
  );
}
