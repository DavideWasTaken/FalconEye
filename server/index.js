import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

// Il file .env vince sulle variabili gia' presenti nel sistema (es. una vecchia OPENAI_API_KEY)
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const [k, v] of Object.entries(util.parseEnv(fs.readFileSync(envFile, "utf8")))) if (v !== "") process.env[k] = v;
}

const { default: express } = await import("express");
const { getDb, closeDb, runSelect, etlInfo, UnsafeSqlError, STG_PATH } = await import("./staging.js");
const { availableProviders, defaultProvider, generateSql, answerFromRows, modelName, resetSchemaCache } = await import("./llm.js");

if (!fs.existsSync(STG_PATH)) {
  console.error("Database di staging non trovato. Esegui prima:  npm run db:reset");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "100kb" }));

let etlRunning = false;
app.use(["/api/dashboard", "/api/ask"], (_req, res, next) => {
  if (etlRunning) return res.status(503).json({ error: "Aggiornamento dello staging in corso, riprova tra un istante." });
  next();
});

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

app.get("/api/health", (_req, res) => {
  res.json({ providers: availableProviders(), defaultProvider: defaultProvider(), etl: etlInfo(), today: today() });
});

// KPI fissi della dashboard: ultimi 7 giorni di dati rispetto ai 7 precedenti
app.get("/api/dashboard", (_req, res) => {
  const db = getDb();
  // ultimo giorno COMPLETO: la giornata in corso falserebbe i confronti
  const ref = db.prepare(`SELECT COALESCE((SELECT MAX(data) FROM stg_kpi_macchina_giorno WHERE data < ?), (SELECT MAX(data) FROM stg_kpi_macchina_giorno)) d`).get(today()).d;
  const win = (from, to) => ({ from, to });
  const cur = win(`date(@ref, '-6 days')`, `@ref`);
  const prev = win(`date(@ref, '-13 days')`, `date(@ref, '-7 days')`);
  const kpi = (w) => db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(pezzi_buoni), 0) FROM stg_produzione WHERE fase_finale = 1 AND data BETWEEN ${w.from} AND ${w.to}) AS prodotti_finiti,
      (SELECT ROUND(100.0 * SUM(pezzi_scarto) / NULLIF(SUM(pezzi_totali), 0), 2) FROM stg_produzione WHERE data BETWEEN ${w.from} AND ${w.to}) AS scarto_pct,
      (SELECT ROUND(100.0 * SUM(oee * tempo_pianificato_min) / NULLIF(SUM(tempo_pianificato_min), 0), 1) FROM stg_kpi_macchina_giorno WHERE data BETWEEN ${w.from} AND ${w.to}) AS oee_pct,
      (SELECT ROUND(COALESCE(SUM(durata_minuti), 0) / 60.0, 1) FROM stg_fermi_macchina WHERE pianificato = 0 AND categoria <> 'Setup' AND data BETWEEN ${w.from} AND ${w.to}) AS ore_fermo_guasti
  `).get({ ref });
  const ordini = db.prepare(`
    SELECT SUM(CASE WHEN stato <> 'CHIUSO' AND in_ritardo = 1 THEN 1 ELSE 0 END) AS aperti_in_ritardo,
           SUM(CASE WHEN stato IN ('RILASCIATO', 'IN_LAVORAZIONE') THEN 1 ELSE 0 END) AS aperti,
           ROUND(100.0 * SUM(CASE WHEN stato = 'CHIUSO' AND in_ritardo = 0 AND data_chiusura > date(@ref, '-30 days') THEN 1 ELSE 0 END)
                 / NULLIF(SUM(CASE WHEN stato = 'CHIUSO' AND data_chiusura > date(@ref, '-30 days') THEN 1 ELSE 0 END), 0), 1) AS puntualita_30gg_pct
    FROM stg_ordini_produzione`).get({ ref });
  const giornaliero = db.prepare(`
    SELECT k.data,
           (SELECT COALESCE(SUM(pezzi_buoni), 0) FROM stg_produzione p WHERE p.fase_finale = 1 AND p.data = k.data) AS prodotti_finiti,
           ROUND(100.0 * SUM(k.oee * k.tempo_pianificato_min) / NULLIF(SUM(k.tempo_pianificato_min), 0), 1) AS oee_pct
    FROM stg_kpi_macchina_giorno k
    WHERE k.data > date(@ref, '-30 days') AND k.data <= @ref
    GROUP BY k.data ORDER BY k.data`).all({ ref });
  const oeeMacchine = db.prepare(`
    SELECT macchina, ROUND(100.0 * SUM(oee * tempo_pianificato_min) / NULLIF(SUM(tempo_pianificato_min), 0), 1) AS oee_pct
    FROM stg_kpi_macchina_giorno WHERE data > date(@ref, '-30 days')
    GROUP BY macchina ORDER BY oee_pct DESC`).all({ ref });
  const fermiCategorie = db.prepare(`
    SELECT categoria, ROUND(SUM(durata_minuti) / 60.0, 1) AS ore
    FROM stg_fermi_macchina WHERE pianificato = 0 AND data > date(@ref, '-30 days')
    GROUP BY categoria ORDER BY ore DESC`).all({ ref });
  const ritardi = db.prepare(`
    SELECT numero_odp, cliente, articolo_descrizione, data_consegna_prevista, giorni_ritardo, percentuale_completamento
    FROM stg_ordini_produzione WHERE stato <> 'CHIUSO' AND in_ritardo = 1
    ORDER BY giorni_ritardo DESC LIMIT 6`).all();
  res.json({ ref, kpi: { corrente: kpi(cur), precedente: kpi(prev), ordini }, giornaliero, oeeMacchine, fermiCategorie, ritardi });
});

function friendlyError(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return "Chiave API non valida o senza permessi: controlla il file .env.";
  if (status === 429) return "Limite di richieste raggiunto presso il provider AI, riprova tra poco.";
  if (status === 404) return "Modello non trovato: controlla CLAUDE_MODEL / OPENAI_MODEL nel file .env.";
  if (status >= 500) return "Il servizio AI non e' disponibile al momento, riprova.";
  if (err?.name === "APIConnectionError" || err?.code === "ENOTFOUND") return "Impossibile raggiungere il servizio AI: controlla la connessione.";
  return err?.message || "Errore imprevisto.";
}

app.post("/api/ask", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim().slice(0, 500) : "";
  if (!question) return res.status(400).json({ error: "Scrivi una domanda." });
  const providers = availableProviders().map((p) => p.id);
  const provider = providers.includes(req.body?.provider) ? req.body.provider : defaultProvider();
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-4).map((h) => ({
    question: String(h?.question ?? "").slice(0, 500),
    sql: String(h?.sql ?? "").slice(0, 4000),
  }));

  const t0 = Date.now();
  try {
    let gen = await generateSql(provider, { question, history, today: today() });
    let result = null;
    if (gen.sql) {
      try {
        result = runSelect(gen.sql);
      } catch (e) {
        if (provider === "demo") throw e;
        // un secondo tentativo: il modello vede l'errore e corregge la query
        gen = await generateSql(provider, { question, history, today: today(), previousError: { sql: gen.sql, message: e.message } });
        if (gen.sql) result = runSelect(gen.sql);
      }
    }
    if (!result) {
      return res.json({ provider, model: modelName(provider), answer: gen.spiegazione, spiegazione: gen.spiegazione, sql: "", columns: [], rows: [], grafico: { tipo: "nessuno", x: "", y: [] }, ms: Date.now() - t0 });
    }
    const answer = await answerFromRows(provider, { question, ...result });
    res.json({ provider, model: modelName(provider), answer, spiegazione: gen.spiegazione, grafico: gen.grafico, ...result, ms: Date.now() - t0 });
  } catch (err) {
    const msg = err instanceof UnsafeSqlError ? `Query rifiutata: ${err.message}` : friendlyError(err);
    if (!(err instanceof UnsafeSqlError) && !err?.status) console.error(err);
    res.status(err instanceof UnsafeSqlError ? 422 : 502).json({ error: msg });
  }
});

// Riesegue l'ETL ERP -> staging (in un processo separato, poi riapre la connessione)
app.post("/api/etl", (_req, res) => {
  if (etlRunning) return res.status(409).json({ error: "ETL gia' in esecuzione." });
  etlRunning = true;
  closeDb();
  execFile(process.execPath, [path.join(here, "db", "etl.js")], { cwd: ROOT }, (err, stdout, stderr) => {
    etlRunning = false;
    if (err) return res.status(500).json({ error: stderr || err.message });
    resetSchemaCache();
    res.json({ ok: true, etl: etlInfo(), log: stdout });
  });
});

// In produzione serve anche il frontend compilato (npm run build)
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.API_PORT) || 3001;
app.listen(PORT, () => {
  console.log(`API pronta su http://localhost:${PORT}  (provider: ${availableProviders().map((p) => p.id).join(", ")})`);
});
