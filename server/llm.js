// Domanda in linguaggio naturale -> SQL -> risposta, con Claude oppure OpenAI.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describeSchema } from "./staging.js";
import { mockGenerateSql, mockAnswer } from "./mock.js";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

export function availableProviders() {
  const p = [];
  if (process.env.ANTHROPIC_API_KEY) p.push({ id: "claude", label: "Claude", model: CLAUDE_MODEL });
  if (process.env.OPENAI_API_KEY) p.push({ id: "openai", label: "OpenAI", model: OPENAI_MODEL });
  p.push({ id: "demo", label: "Demo offline", model: "regole fisse" });
  return p;
}
export function defaultProvider() {
  const pref = process.env.LLM_PROVIDER;
  const ids = availableProviders().map((p) => p.id);
  return ids.includes(pref) ? pref : ids[0];
}

let anthropic = null, openai = null;
const claude = () => (anthropic ??= new Anthropic());
const gpt = () => (openai ??= new OpenAI());

// ---------- prompt ----------
let schemaCache = null;
export function resetSchemaCache() { schemaCache = null; }
function sqlSystemPrompt() {
  schemaCache ??= describeSchema();
  return `Sei l'analista dati di Officine Demo S.r.l., un'azienda metalmeccanica. Trasformi le domande del personale, scritte in italiano, in UNA query SQL per SQLite sulle tabelle di staging della produzione descritte qui sotto.

REGOLE
- Una sola istruzione SELECT (oppure WITH ... SELECT). Mai INSERT/UPDATE/DELETE/PRAGMA/ATTACH o altro.
- Usa solo le tabelle e le colonne elencate. Dialetto SQLite: le date sono testo 'YYYY-MM-DD', usa date(), strftime(), julianday().
- Per "oggi" usa sempre la data di riferimento che ricevi nel messaggio, scritta come letterale (es. date('2026-11-19', '-6 days')), mai date('now').
  * "questa settimana" = da lunedi': data >= date('<oggi>', 'weekday 0', '-6 days')
  * "settimana scorsa" = data BETWEEN date('<oggi>', 'weekday 0', '-13 days') AND date('<oggi>', 'weekday 0', '-7 days')
  * "questo mese" = anno_mese = strftime('%Y-%m', '<oggi>'); "mese scorso" = anno_mese = strftime('%Y-%m', '<oggi>', 'start of month', '-1 month')
  * senza periodo indicato considera tutto lo storico disponibile e dillo nella spiegazione.
- Persone: cerca senza distinzione di maiuscole su nome o cognome, es. operatore LIKE '%mario%'. Raggruppa per operatore, cosi' se ci sono omonimi si vedono separati.
- Macchine, causali, turni, stati: usa i valori esatti elencati nello schema.
- "Fermi" o "ore di fermo" senza altre indicazioni = solo fermi NON pianificati (pianificato = 0): quelli pianificati sono manutenzione programmata e attesa per mancanza di lavoro, non problemi della macchina. Dillo nella spiegazione.
- "Pezzi prodotti" da un operatore o da una macchina = SUM(pezzi_buoni) su stg_produzione (tutte le fasi). "Prodotti finiti" dell'azienda = solo fase_finale = 1.
- Nomi di colonna in output leggibili in italiano (snake_case). Percentuali gia' moltiplicate per 100 e arrotondate a 1 decimale, con suffisso _pct nel nome.
- Ordina in modo utile e metti LIMIT 200 se il risultato puo' essere lungo.
- Se la domanda non riguarda questi dati o non si puo' rispondere, restituisci sql vuoto e spiega il perche' in "spiegazione".
- "spiegazione": una frase in italiano su cosa calcola la query (periodo, filtri, ipotesi fatte).
- "grafico": "linee" per andamenti nel tempo, "barre" per confronti tra categorie, "torta" solo per composizioni con al massimo 6 parti, "nessuno" se il risultato e' un solo numero o un elenco di dettaglio. "x" = colonna delle etichette/asse X, "y" = colonne numeriche da disegnare (stessa unita' di misura). Con "nessuno" usa x vuoto e y vuoto.

SCHEMA DELLE TABELLE DI STAGING
${schemaCache}`;
}

const SQL_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "string", description: "Query SQLite, oppure stringa vuota se non si puo' rispondere" },
    spiegazione: { type: "string" },
    grafico: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["barre", "linee", "torta", "nessuno"] },
        x: { type: "string" },
        y: { type: "array", items: { type: "string" } },
      },
      required: ["tipo", "x", "y"],
      additionalProperties: false,
    },
  },
  required: ["sql", "spiegazione", "grafico"],
  additionalProperties: false,
};

const ANSWER_SYSTEM = `Sei l'assistente di produzione di Officine Demo S.r.l. Rispondi in italiano alla domanda dell'utente usando SOLO i risultati della query che ricevi.
- Da 1 a 3 frasi, dirette, come parleresti a un responsabile di reparto.
- Numeri in formato italiano (1.234 pezzi, 87,5%). Cita i valori chiave e, se utile, il primo e l'ultimo di una classifica.
- Non inventare nulla che non sia nei risultati. Se il risultato e' vuoto, dillo e suggerisci come riformulare.
- Non mostrare la query SQL e non usare elenchi puntati o markdown.`;

function sqlUserMessage({ question, history, today, previousError }) {
  let msg = `Data di riferimento (oggi): ${today}\n`;
  if (history?.length) {
    msg += `\nDomande precedenti della conversazione (per interpretare riferimenti come "e lui?", "e a ottobre?"):\n`;
    for (const h of history) msg += `- Domanda: ${h.question}\n  SQL usata: ${h.sql || "(nessuna)"}\n`;
  }
  msg += `\nDomanda: ${question}`;
  if (previousError) msg += `\n\nATTENZIONE: il tuo tentativo precedente\n${previousError.sql}\nha dato questo errore: ${previousError.message}\nCorreggi la query.`;
  return msg;
}

function answerUserMessage({ question, sql, columns, rows, truncated }) {
  const sample = rows.slice(0, 60);
  return `Domanda: ${question}\n\nQuery eseguita:\n${sql}\n\nColonne: ${columns.join(", ")}\nRighe totali: ${rows.length}${truncated ? "+ (troncato)" : ""}\nRisultati (JSON${rows.length > sample.length ? `, prime ${sample.length} righe` : ""}):\n${JSON.stringify(sample)}`;
}

// ---------- chiamate ai provider ----------
function claudeText(r) {
  if (r.stop_reason === "refusal") throw new Error("Claude ha rifiutato la richiesta.");
  if (r.stop_reason === "max_tokens") throw new Error("La risposta di Claude e' stata troncata.");
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function callClaude({ system, user, schema, effort }) {
  const r = await claude().beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    // se il modello declina per i filtri di sicurezza, l'API ripete la richiesta su un modello di riserva
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const text = claudeText(r);
  return schema ? JSON.parse(text) : text;
}

async function callOpenAI({ system, user, schema }) {
  const r = await gpt().chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "risposta", strict: true, schema } } } : {}),
  });
  const msg = r.choices[0]?.message;
  if (msg?.refusal) throw new Error(`OpenAI ha rifiutato la richiesta: ${msg.refusal}`);
  const text = (msg?.content ?? "").trim();
  return schema ? JSON.parse(text) : text;
}

const call = (provider, args) => (provider === "claude" ? callClaude(args) : callOpenAI(args));

export async function generateSql(provider, { question, history, today, previousError }) {
  if (provider === "demo") return mockGenerateSql(question, today);
  return call(provider, {
    system: sqlSystemPrompt(),
    user: sqlUserMessage({ question, history, today, previousError }),
    schema: SQL_SCHEMA,
    effort: process.env.CLAUDE_EFFORT_SQL || "medium",
  });
}

export async function answerFromRows(provider, data) {
  if (provider === "demo") return mockAnswer(data);
  return call(provider, { system: ANSWER_SYSTEM, user: answerUserMessage(data), effort: "low" });
}

export function modelName(provider) {
  return availableProviders().find((p) => p.id === provider)?.model ?? "";
}
