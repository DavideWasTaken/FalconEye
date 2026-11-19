import { useCallback, useEffect, useState } from "react";
import Dashboard from "./Dashboard.jsx";
import AskPanel from "./AskPanel.jsx";

export default function App() {
  const [health, setHealth] = useState(null);
  const [dash, setDash] = useState(null);
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async (tentativi = 8) => {
    setLoading(true);
    for (let i = 0; i < tentativi; i++) {
      try {
        const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(); return r.json(); };
        const [h, d] = await Promise.all([get("/api/health"), get("/api/dashboard")]);
        setHealth(h);
        setDash(d);
        setProvider((p) => p || h.defaultProvider);
        setLoading(false);
        return;
      } catch {
        await new Promise((res) => setTimeout(res, 1000)); // l'API potrebbe essere ancora in avvio
      }
    }
    setToast("Server API non raggiungibile: e' avviato?");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);

  async function runEtl() {
    setLoading(true);
    const r = await fetch("/api/etl", { method: "POST" });
    const data = await r.json().catch(() => ({}));
    setToast(r.ok ? "Staging riallineato dall'ERP" : data.error || "ETL non riuscito");
    await load();
  }

  const etl = health?.etl;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div>
            <h1>FalconEye</h1>
            <p>Officine Demo S.r.l. · produzione dalle tabelle di staging alimentate dall'ERP</p>
          </div>
        </div>
        <div className="pipeline" title="Flusso dei dati">
          <span className="node">ERP (26 tabelle)</span>→
          <span className="node">ETL</span>→
          <span className="node on">Staging (6 tabelle)</span>→
          <span className="node on">Dashboard + AI</span>
        </div>
        <button className="btn" onClick={runEtl} disabled={loading} title={etl ? `Ultimo ETL: ${etl.eseguito_il}` : ""}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
          {loading ? "Aggiorno…" : `Riallinea staging${etl ? ` · ${etl.eseguito_il.slice(11, 16)}` : ""}`}
        </button>
      </header>

      <div className="layout">
        <Dashboard data={dash} loading={loading} />
        {health && <AskPanel providers={health.providers} provider={provider} setProvider={setProvider} />}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
