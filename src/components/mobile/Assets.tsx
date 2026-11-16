"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Icon } from "@/components/Icon";
import { ApiFail, api, peso } from "./api";
import { Chips, Empty, Errors, Field, Header, Pill, Sheet, Spinner, toast } from "./ui";
import type { Me, Nav } from "./App";

type AuditRow = { id: string; number: string; name: string; location: string | null; status: string; scans: number; createdAt: string };
type Asset = { id: string; code: string; name: string; location: string | null; category: string | null; status: string; condition: string | null; lastSeenLocation: string | null };
type ScanRes = { scan: { id: string; result: string; location: string | null; repeated: boolean }; asset: Asset | null };
type Summary = {
  audit: { id: string; number: string; name: string; location: string | null; status: string };
  totals: { expected: number; found: number; missing: number; wrongLocation: number; unknown: number; pctFound: number; missingCost: string; expectedCost: string; neverTagged: number };
  missing: { id: string; code: string; name: string; location: string | null; cost: string }[];
  scans: { id: string; tagText: string; result: string; asset: { code: string; name: string } | null; scannedAt: string }[];
  byLocation: { key: string; expected: number; found: number; pct: number }[];
};

export function AssetAudit({ me, nav }: { me: Me; nav: Nav }) {
  const [audits, setAudits] = useState<AuditRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [newSheet, setNewSheet] = useState(false);
  const [name, setName] = useState("");
  const [loc, setLoc] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const load = useCallback(() => api<AuditRow[]>("GET", "asset-audits").then(setAudits).catch((e) => setErrors(e instanceof ApiFail ? e.errors : ["Failed"])), []);
  useEffect(() => { load(); }, [load]);
  if (open) return <AuditRun id={open} me={me} onBack={() => { setOpen(null); load(); }} />;
  return (
    <div className="vm-page">
      <Header title="Asset Audit" sub="Scan QR stickers to count fixed assets" icon="asset-audit" onBack={nav.back} right={<button className="vm-btn primary small" onClick={() => setNewSheet(true)}>New count</button>} />
      <Errors errors={errors} />
      {!audits ? <Spinner /> : audits.length === 0 ? <Empty icon="asset-audit" text="No asset counts yet. Start one, then scan each sticker." /> : (
        <div className="vm-list stagger">
          {audits.map((a, i) => (
            <button key={a.id} className="vm-row" style={{ animationDelay: `${i * 40}ms` }} onClick={() => setOpen(a.id)}>
              <span className="ic"><Icon name="asset-audit" size={20} /></span>
              <span className="m"><b>{a.name}</b><small>{a.number} · {a.location ?? "All locations"} · {a.scans} scanned</small></span>
              <Pill status={a.status} />
            </button>
          ))}
        </div>
      )}
      <Sheet open={newSheet} onClose={() => setNewSheet(false)} title="New asset count">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 count - Makati HQ" /></Field>
        <Field label="Location (blank = all)"><input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="As written in the asset register" /></Field>
        <button className="vm-btn primary block" onClick={async () => {
          try { const a = await api<{ id: string }>("POST", "asset-audits", { name, location: loc }); setNewSheet(false); setOpen(a.id); } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Failed"]); setNewSheet(false); }
        }}>Start scanning</button>
      </Sheet>
    </div>
  );
}

function AuditRun({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const [tab, setTab] = useState<"scan" | "summary">("scan");
  const [sum, setSum] = useState<Summary | null>(null);
  const [last, setLast] = useState<ScanRes | null>(null);
  const [condition, setCondition] = useState("GOOD");
  const [location, setLocation] = useState("");
  const [manual, setManual] = useState("");
  const [mapTag, setMapTag] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Asset[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const busy = useRef(false);
  const load = useCallback(() => api<Summary>("GET", `asset-audits/${id}`).then(setSum).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);

  const scan = useCallback(async (tagText: string) => {
    if (busy.current) return;
    busy.current = true; setErrors([]);
    try {
      const r = await api<ScanRes>("POST", `asset-audits/${id}/scans`, { tagText, condition, location: location || null });
      setLast(r);
      if (navigator.vibrate) navigator.vibrate(r.scan.result === "FOUND" ? 40 : [60, 60, 60]);
      if (r.scan.result === "UNKNOWN") setMapTag(tagText);
      load();
    } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Scan failed"]); }
    finally { setTimeout(() => { busy.current = false; }, 900); }
  }, [id, condition, location, load]);

  useEffect(() => {
    if (!mapTag) return;
    const h = setTimeout(() => api<Asset[]>("GET", `assets?q=${encodeURIComponent(q)}`).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [q, mapTag]);

  const t = sum?.totals;
  return (
    <div className="vm-page">
      <Header title={sum?.audit.name ?? "Asset count"} sub={sum ? `${sum.audit.number} · ${sum.audit.location ?? "All locations"}` : undefined} icon="asset-audit" onBack={onBack} right={sum && <Pill status={sum.audit.status} />} />
      <Errors errors={errors} />
      {t && (
        <div className="vm-progress">
          <svg viewBox="0 0 36 36" className="ring"><path className="bg" d="M18 2a16 16 0 1 1 0 32a16 16 0 1 1 0-32" /><path className="fg" strokeDasharray={`${t.pctFound}, 100`} d="M18 2a16 16 0 1 1 0 32a16 16 0 1 1 0-32" /></svg>
          <div className="pct">{t.pctFound}%</div>
          <div className="nums"><div><b>{t.found}</b>/{t.expected} found</div><div className="amber">{t.wrongLocation} wrong location</div><div className="red">{t.missing} not yet scanned</div>{t.unknown > 0 && <div className="red">{t.unknown} unknown tags</div>}</div>
        </div>
      )}
      <div className="vm-seg"><button className={tab === "scan" ? "on" : ""} onClick={() => setTab("scan")}>Scan</button><button className={tab === "summary" ? "on" : ""} onClick={() => { setTab("summary"); load(); }}>Summary</button></div>
      {tab === "scan" && sum?.audit.status === "OPEN" && (
        <>
          <QrScanner onCode={scan} />
          {last && (
            <div key={last.scan.id + Date.now()} className={`vm-scanres ${last.scan.result}`}>
              <Pill status={last.scan.result} />
              {last.asset ? <><b>{last.asset.code} · {last.asset.name}</b><small>{last.scan.result === "WRONG_LOCATION" ? `Register says ${last.asset.location ?? "-"}; found at ${last.scan.location ?? "-"}` : last.scan.repeated ? "Already scanned in this count (updated)" : `Tagged and synced to the register`}</small></> : <b>Sticker not in the register</b>}
            </div>
          )}
          <div className="vm-card">
            <Field label="Condition"><Chips options={[{ value: "GOOD", label: "Good" }, { value: "FAIR", label: "Fair" }, { value: "DAMAGED", label: "Damaged" }, { value: "FOR_REPAIR", label: "For repair" }]} value={condition} onChange={setCondition} /></Field>
            <Field label="Where you are now"><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={sum.audit.location ?? "e.g. Makati HQ - 5F"} /></Field>
            <div className="vm-inline"><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Type asset no. if the sticker is damaged" /><button className="vm-btn small" disabled={!manual.trim()} onClick={() => { scan(manual.trim()); setManual(""); }}>Add</button></div>
          </div>
        </>
      )}
      {(tab === "summary" || sum?.audit.status !== "OPEN") && sum && (
        <>
          <div className="vm-card">
            <div className="vm-section-t">By location</div>
            {sum.byLocation.map((b) => <div key={b.key} className="vm-bar"><span>{b.key}</span><div className="track"><i style={{ width: `${b.pct}%` }} /></div><b>{b.found}/{b.expected}</b></div>)}
          </div>
          {sum.missing.length > 0 && (
            <div className="vm-card">
              <div className="vm-section-t">Not yet scanned · {peso(t!.missingCost)}</div>
              {sum.missing.slice(0, 50).map((m) => <div key={m.id} className="vm-mini"><b>{m.code}</b> {m.name}<small>{m.location ?? ""} · {peso(m.cost)}</small></div>)}
            </div>
          )}
          <div className="vm-card">
            <div className="vm-section-t">Scans</div>
            {sum.scans.slice().reverse().slice(0, 60).map((s) => <div key={s.id} className="vm-mini"><Pill status={s.result} /> <b>{s.asset?.code ?? s.tagText}</b> {s.asset?.name ?? ""}</div>)}
          </div>
          {sum.audit.status === "OPEN" && me.can.postJournal && (
            <button className="vm-btn danger block" onClick={async () => {
              try { setSum(await api<Summary>("POST", `asset-audits/${id}/close`, { markMissing: true })); toast("Count closed. Unscanned assets marked missing."); } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Failed"]); }
            }}>Close count (mark {t!.missing} missing)</button>
          )}
        </>
      )}
      <Sheet open={!!mapTag} onClose={() => setMapTag(null)} title={`Map sticker "${mapTag}"`}>
        <p className="muted">This sticker is not in the register. Pick the asset it belongs to.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search asset no. or name" autoFocus />
        <div className="vm-list">
          {found.slice(0, 20).map((a) => (
            <button key={a.id} className="vm-row" onClick={async () => {
              try { await api("POST", "assets/map-tag", { tagText: mapTag, assetId: a.id }); toast(`Sticker mapped to ${a.code}`); setMapTag(null); setQ(""); load(); } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Failed"]); setMapTag(null); }
            }}><span className="m"><b>{a.code} · {a.name}</b><small>{a.location ?? ""}</small></span></button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** Live camera QR reader (jsQR works on iPhone Safari and Android Chrome). */
function QrScanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "on" | "denied">("idle");
  const lastCode = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const stream = useRef<MediaStream | null>(null);

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setState("idle"); };
  useEffect(() => () => stop(), []);
  const start = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.current!.srcObject = stream.current;
      await video.current!.play();
      setState("on");
      const loop = () => {
        if (!stream.current || !video.current || !canvas.current) return;
        const v = video.current;
        if (v.readyState === v.HAVE_ENOUGH_DATA) {
          const c = canvas.current;
          c.width = v.videoWidth; c.height = v.videoHeight;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (r?.data) {
            const now = Date.now();
            if (r.data !== lastCode.current.code || now - lastCode.current.at > 3000) { lastCode.current = { code: r.data, at: now }; onCode(r.data); }
          }
        }
        setTimeout(() => requestAnimationFrame(loop), 120);
      };
      loop();
    } catch { setState("denied"); }
  };
  return (
    <div className={`vm-qr ${state}`}>
      <video ref={video} playsInline muted />
      <canvas ref={canvas} hidden />
      <div className="frame"><i /><i /><i /><i /><span className="laser" /></div>
      {state !== "on" && (
        <button className="start" onClick={start}><Icon name="asset-audit" size={30} /><b>{state === "denied" ? "Allow camera access to scan" : "Tap to start scanning"}</b></button>
      )}
      {state === "on" && <button className="stop" onClick={stop}>Pause</button>}
    </div>
  );
}
