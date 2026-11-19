import { useEffect, useRef, useState } from "react";
import { ResultChart, DataTable } from "./Charts.jsx";
import { fmtNum } from "./format.js";

const ESEMPI = [
  "Quanti pezzi ha fatto Mario questa settimana?",
  "Quale macchina ha avuto piu' ore di fermo a ottobre?",
  "Tasso di scarto per turno nell'ultimo mese",
  "Classifica degli operatori per pezzi prodotti questo mese",
  "Andamento dell'OEE della FRESA-03 settimana per settimana",
  "Quali clienti hanno piu' ordini consegnati in ritardo?",
];

function Answer({ m }) {
  return (
    <div className="msg-ai">
      <div className="answer">{m.answer}</div>
      <ResultChart grafico={m.grafico} columns={m.columns} rows={m.rows} />
      {m.rows.length > 1 && <DataTable columns={m.columns} rows={m.rows} max={200} />}
      {m.sql && (
        <details className="sql">
          <summary>Come l'ho calcolato (SQL sullo staging)</summary>
          {m.spiegazione && <p>{m.spiegazione}</p>}
          <pre className="code">{m.sql}</pre>
        </details>
      )}
      <div className="meta">
        <span className="pill">{m.providerLabel}{m.model ? ` · ${m.model}` : ""}</span>
        <span>{fmtNum(m.ms / 1000, 1)} s</span>
        {m.sql && <span>{fmtNum(m.rows.length)} {m.rows.length === 1 ? "riga" : "righe"}{m.truncated ? " (troncato)" : ""}</span>}
      </div>
    </div>
  );
}

export default function AskPanel({ providers, provider, setProvider }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    setText("");
    const history = messages.filter((m) => m.role === "ai" && m.sql).slice(-4).map((m) => ({ question: m.question, sql: m.sql }));
    setMessages((ms) => [...ms, { role: "user", text: q }]);
    setBusy(true);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, provider, history }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Errore ${r.status}`);
      const label = providers.find((p) => p.id === data.provider)?.label ?? data.provider;
      setMessages((ms) => [...ms, { role: "ai", question: q, providerLabel: label, ...data }]);
    } catch (e) {
      setMessages((ms) => [...ms, { role: "error", text: e.message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card ask">
      <div className="ask-head">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 15l.8 1.9 1.9.8-1.9.8L19 20.4l-.8-1.9-1.9-.8 1.9-.8z" />
        </svg>
        <h2>Chiedi ai dati</h2>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Modello AI">
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.id !== "demo" ? ` (${p.model})` : ""}</option>)}
        </select>
        {messages.length > 0 && <button className="btn ghost" onClick={() => setMessages([])} title="Nuova conversazione">Nuova</button>}
        <div className="sub">La domanda diventa una query SQL sulle 6 tabelle di staging: l'ERP non viene mai interrogato.</div>
      </div>

      <div className="thread" ref={threadRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>Fai una domanda sulla produzione, in italiano. Per esempio:</p>
            <div className="chips">
              {ESEMPI.map((e) => <button key={e} className="chip" onClick={() => ask(e)}>{e}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? <div key={i} className="msg-user">{m.text}</div>
          : m.role === "error" ? (
            <div key={i} className="error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
              <span>{m.text}</span>
            </div>
          )
          : <Answer key={i} m={m} />,
        )}
        {busy && <div className="typing"><i /><i /><i /> <span style={{ marginLeft: 6 }}>Sto interrogando lo staging…</span></div>}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <textarea
          rows={1}
          value={text}
          placeholder="Es. quanti pezzi ha fatto Mario ieri?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(text); } }}
        />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Chiedi</button>
      </form>
    </div>
  );
}
