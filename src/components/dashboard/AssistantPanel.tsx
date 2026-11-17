"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";

type Msg = { role: "user" | "assistant"; content: string; links?: { label: string; href: string }[] };

const SUGGESTIONS = ["Show overdue receivables", "Prepare my VAT (2550Q) summary", "Check low stock items", "Prepare payroll summary", "Show sales by customer"];

/** AI ERP assistant: answers from the company's live figures via /api/assistant. */
export function AssistantPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const sp = useSearchParams();
  const asked = useRef(false);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setText("");
    setBusy(true);
    try {
      const r = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, history }) });
      const j = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: j.answer ?? j.error ?? "Something went wrong.", links: j.links }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "I could not reach the server. Try again in a moment." }]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const q = sp.get("ask");
    if (q && !asked.current) { asked.current = true; void ask(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  return (
    <section className="assistant" id="assistant" aria-label="AI ERP assistant">
      <div className="as-head">
        <span className="as-bot"><Icon name="sparkle" size={24} /></span>
        <div><strong>AI ERP Assistant</strong><small>Ask. Analyze. Act.</small></div>
        {msgs.length > 0 && <button type="button" className="as-clear" onClick={() => setMsgs([])}>New chat</button>}
      </div>
      <div className="as-body" ref={list}>
        {msgs.length === 0 ? (
          <div className="as-intro">
            <strong>How can I help you today?</strong>
            <small>Here are some things you can try:</small>
            <div className="as-sugs">
              {SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`as-msg from-${m.role}`}>
              <div className="as-bubble">{m.content}</div>
              {m.links && m.links.length > 0 && <div className="as-links">{m.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}</div>}
            </div>
          ))
        )}
        {busy && <div className="as-msg from-assistant"><div className="as-bubble typing"><i /><i /><i /></div></div>}
      </div>
      <form className="as-input" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your question here..." aria-label="Ask the assistant" />
        <button type="submit" aria-label="Send" disabled={busy || !text.trim()}><Icon name="send" size={17} /></button>
      </form>
      {!aiEnabled && <div className="as-note">Answers come straight from your books. Add ANTHROPIC_API_KEY to let Claude answer free-form questions.</div>}
    </section>
  );
}
