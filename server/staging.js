// Accesso in SOLA LETTURA alle tabelle di staging + descrizione dello schema per il modello.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STG_PATH = path.resolve(here, "../data/staging.db");
export const MAX_ROWS = 1000;

let db = null;
export function getDb() {
  if (!db) db = new Database(STG_PATH, { readonly: true, fileMustExist: true });
  return db;
}
// prima di un nuovo ETL: su Windows un file aperto non puo' essere sostituito
export function closeDb() {
  if (db) db.close();
  db = null;
}

// Descrizioni delle colonne: aiutano il modello a scegliere i campi giusti.
const DESCRIZIONI = {
  stg_produzione: {
    _: "Avanzamento di produzione: una riga per ogni dichiarazione fatta da un operatore su una macchina, per una fase di un ordine di produzione (ODP). Usala per 'quanti pezzi ha fatto X', produttivita', pezzi per macchina/turno/articolo.",
    pezzi_buoni: "pezzi conformi dichiarati in quella fase",
    pezzi_scarto: "pezzi scartati in quella fase",
    fase_finale: "1 se e' l'ultima fase del ciclo: per contare i prodotti FINITI usa SUM(pezzi_buoni) WHERE fase_finale = 1 (altrimenti un pezzo viene contato in ogni fase)",
    minuti_lavorazione: "minuti effettivi di lavorazione (senza fermi)",
    tempo_ciclo_std_sec: "tempo ciclo standard per pezzo, in secondi",
    operatore: "nome e cognome, es. 'Mario Rossi'",
    data: "data del turno (YYYY-MM-DD); il turno di Notte inizia alle 22:00 di questa data",
  },
  stg_ordini_produzione: {
    _: "Ordini di produzione (ODP) con avanzamento, stato e ritardo rispetto alla consegna prevista.",
    stato: "PIANIFICATO (non ancora rilasciato), RILASCIATO (non ancora iniziato), IN_LAVORAZIONE, CHIUSO",
    quantita_prodotta: "pezzi buoni completati all'ultima fase",
    in_ritardo: "1 se chiuso dopo la consegna prevista, oppure ancora aperto con consegna gia' passata",
    giorni_ritardo: "giorni di ritardo (0 se puntuale)",
    valore_ordine_eur: "valore di vendita dell'ordine in euro",
  },
  stg_fermi_macchina: {
    _: "Fermi macchina: una riga per ogni fermo con causale e durata.",
    pianificato: "1 = fermo pianificato (manutenzione programmata, mancanza lavoro), 0 = fermo non pianificato (guasti, setup, microfermate...)",
    categoria: "Guasto, Setup, Microfermate, Logistica, Qualita', Organizzativo, Manutenzione",
    durata_minuti: "durata del fermo in minuti",
  },
  stg_scarti: {
    _: "Dettaglio degli scarti per causale (una dichiarazione puo' avere piu' causali).",
    quantita: "pezzi scartati per quella causale",
    costo_stimato_eur: "quantita x costo standard dell'articolo",
  },
  stg_presenze: {
    _: "Presenze giornaliere del personale (tutti i reparti, non solo produzione).",
    tipo_giornata: "PRESENZA, FERIE, MALATTIA, PERMESSO",
    turno: "turno lavorato (NULL se assente)",
  },
  stg_kpi_macchina_giorno: {
    _: "KPI giornalieri per macchina, gia' calcolati. OEE = disponibilita x performance x qualita (valori tra 0 e 1). Per medie su piu' giorni preferisci la media pesata: SUM(oee * tempo_pianificato_min) / SUM(tempo_pianificato_min).",
    tempo_disponibile_min: "turni_lavorati x 450 minuti",
    tempo_pianificato_min: "disponibile meno fermi pianificati",
    tempo_operativo_min: "pianificato meno fermi non pianificati",
    disponibilita: "tempo_operativo / tempo_pianificato",
    performance: "tempo teorico (pezzi x ciclo std) / tempo operativo",
    qualita: "pezzi buoni / pezzi totali",
  },
};

export const STAGING_TABLES = Object.keys(DESCRIZIONI);

// Colonne testuali a bassa cardinalita': si passano i valori possibili, cosi' il modello
// scrive WHERE con i valori esatti (es. 'Notte', 'FRESA-03', 'Mario Rossi').
const VALORI = {
  stg_produzione: ["turno", "operatore", "reparto", "macchina", "articolo_codice", "articolo_descrizione", "giorno_settimana"],
  stg_ordini_produzione: ["stato", "cliente", "tipo_articolo"],
  stg_fermi_macchina: ["causale", "categoria"],
  stg_scarti: ["causale", "categoria_scarto"],
  stg_presenze: ["tipo_giornata", "mansione", "reparto"],
  stg_kpi_macchina_giorno: [],
};

export function describeSchema() {
  const d = getDb();
  const out = [];
  for (const t of STAGING_TABLES) {
    const cols = d.prepare(`PRAGMA table_info(${t})`).all();
    const n = d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const desc = DESCRIZIONI[t];
    out.push(`TABELLA ${t} (${n} righe) -- ${desc._}`);
    const campione = d.prepare(`SELECT * FROM ${t} LIMIT 1`).get() ?? {};
    for (const c of cols) {
      // le colonne calcolate (CASE, espressioni) non hanno tipo dichiarato: lo si deduce dal dato
      const v = campione[c.name];
      const tipo = c.type || (typeof v === "number" ? (Number.isInteger(v) ? "INTEGER" : "REAL") : "TEXT");
      let line = `  - ${c.name} ${tipo}`;
      if (desc[c.name]) line += ` -- ${desc[c.name]}`;
      if (VALORI[t].includes(c.name)) {
        const vals = d.prepare(`SELECT DISTINCT ${c.name} v FROM ${t} WHERE ${c.name} IS NOT NULL ORDER BY 1 LIMIT 60`).all().map((r) => r.v);
        line += ` -- valori: ${vals.map((v) => `'${v}'`).join(", ")}`;
      }
      out.push(line);
    }
    if (["stg_produzione", "stg_kpi_macchina_giorno", "stg_fermi_macchina"].includes(t)) {
      const r = d.prepare(`SELECT MIN(data) a, MAX(data) b FROM ${t}`).get();
      out.push(`  (dati dal ${r.a} al ${r.b})`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function etlInfo() {
  try {
    const r = getDb().prepare(`SELECT eseguito_il, durata_ms, righe FROM _etl_info ORDER BY eseguito_il DESC LIMIT 1`).get();
    return r ? { ...r, righe: JSON.parse(r.righe) } : null;
  } catch {
    return null;
  }
}

// ---------- esecuzione sicura delle query generate dall'AI ----------
const VIETATE = /\b(attach|detach|pragma|vacuum|reindex|analyze|insert|update|delete|replace|create|drop|alter|load_extension|readfile|writefile)\b/i;

export class UnsafeSqlError extends Error {}

export function runSelect(sqlRaw) {
  const sql = String(sqlRaw ?? "").trim().replace(/;+\s*$/, "");
  const senzaCommenti = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(senzaCommenti)) throw new UnsafeSqlError("Sono ammesse solo query SELECT.");
  if (senzaCommenti.includes(";")) throw new UnsafeSqlError("E' ammessa una sola istruzione SQL.");
  if (VIETATE.test(senzaCommenti.replace(/'[^']*'/g, "''"))) throw new UnsafeSqlError("La query contiene istruzioni non consentite.");

  const stmt = getDb().prepare(sql); // connessione read-only: qualsiasi scrittura fallirebbe comunque
  if (!stmt.reader) throw new UnsafeSqlError("La query non restituisce dati.");
  const columns = stmt.columns().map((c) => c.name);
  const rows = [];
  let truncated = false;
  for (const row of stmt.iterate()) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    rows.push(row);
  }
  return { sql, columns, rows, truncated };
}
