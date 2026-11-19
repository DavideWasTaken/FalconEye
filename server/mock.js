// Provider "Demo offline": nessuna chiamata esterna. Riconosce poche domande tipo con regole
// fisse. Serve per provare l'interfaccia senza chiave API o come paracadute se manca la rete.
import { getDb } from "./staging.js";

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function periodo(q, today) {
  const t = quote(today);
  if (/\boggi\b/.test(q)) return { where: `data = ${t}`, label: "oggi" };
  if (/\bieri\b/.test(q)) return { where: `data = date(${t}, '-1 day')`, label: "ieri" };
  if (/settimana scorsa/.test(q)) return { where: `data BETWEEN date(${t}, 'weekday 0', '-13 days') AND date(${t}, 'weekday 0', '-7 days')`, label: "la settimana scorsa" };
  if (/settimana/.test(q)) return { where: `data >= date(${t}, 'weekday 0', '-6 days')`, label: "questa settimana" };
  if (/mese scorso/.test(q)) return { where: `anno_mese = strftime('%Y-%m', ${t}, 'start of month', '-1 month')`, label: "il mese scorso" };
  if (/questo mese|\bmese\b/.test(q)) return { where: `anno_mese = strftime('%Y-%m', ${t})`, label: "questo mese" };
  if (/ottobre/.test(q)) return { where: `anno_mese = strftime('%Y', ${t}) || '-10'`, label: "a ottobre" };
  if (/settembre/.test(q)) return { where: `anno_mese = strftime('%Y', ${t}) || '-09'`, label: "a settembre" };
  if (/novembre/.test(q)) return { where: `anno_mese = strftime('%Y', ${t}) || '-11'`, label: "a novembre" };
  return { where: `data > date(${t}, '-30 days')`, label: "negli ultimi 30 giorni" };
}

const NESSUNO = { tipo: "nessuno", x: "", y: [] };

export function mockGenerateSql(question, today) {
  const q = norm(question);
  const p = periodo(q, today);
  const operatori = getDb().prepare(`SELECT DISTINCT operatore, operatore_nome, operatore_cognome FROM stg_produzione`).all();
  const op = operatori.find((o) => q.includes(norm(o.operatore_nome)) || q.includes(norm(o.operatore_cognome)));

  if (op && /pezz|prodott|fatto/.test(q)) {
    const chiave = q.includes(norm(op.operatore_nome)) ? op.operatore_nome : op.operatore_cognome;
    return {
      sql: `SELECT operatore, SUM(pezzi_buoni) AS pezzi_buoni, SUM(pezzi_scarto) AS pezzi_scarto,\n       ROUND(100.0 * SUM(pezzi_scarto) / SUM(pezzi_totali), 1) AS scarto_pct\nFROM stg_produzione\nWHERE operatore LIKE ${quote("%" + chiave + "%")} AND ${p.where}\nGROUP BY operatore`,
      spiegazione: `Somma dei pezzi dichiarati dall'operatore ${p.label}.`,
      grafico: NESSUNO,
    };
  }
  if (/fermi|ferm/.test(q)) {
    return {
      sql: `SELECT macchina, ROUND(SUM(durata_minuti) / 60.0, 1) AS ore_fermo, COUNT(*) AS numero_fermi\nFROM stg_fermi_macchina\nWHERE pianificato = 0 AND ${p.where}\nGROUP BY macchina\nORDER BY ore_fermo DESC`,
      spiegazione: `Ore di fermo non pianificato per macchina ${p.label}.`,
      grafico: { tipo: "barre", x: "macchina", y: ["ore_fermo"] },
    };
  }
  if (/scart/.test(q) && /turn/.test(q)) {
    return {
      sql: `SELECT turno, SUM(pezzi_scarto) AS pezzi_scarto, ROUND(100.0 * SUM(pezzi_scarto) / SUM(pezzi_totali), 2) AS scarto_pct\nFROM stg_produzione\nWHERE ${p.where}\nGROUP BY turno\nORDER BY scarto_pct DESC`,
      spiegazione: `Tasso di scarto per turno ${p.label}.`,
      grafico: { tipo: "barre", x: "turno", y: ["scarto_pct"] },
    };
  }
  if (/scart/.test(q)) {
    return {
      sql: `SELECT causale, SUM(quantita) AS pezzi, ROUND(SUM(costo_stimato_eur), 0) AS costo_eur\nFROM stg_scarti\nWHERE ${p.where}\nGROUP BY causale\nORDER BY pezzi DESC`,
      spiegazione: `Scarti per causale ${p.label}.`,
      grafico: { tipo: "barre", x: "causale", y: ["pezzi"] },
    };
  }
  if (/ritard/.test(q)) {
    return {
      sql: `SELECT numero_odp, cliente, articolo_descrizione, stato, data_consegna_prevista, giorni_ritardo, percentuale_completamento\nFROM stg_ordini_produzione\nWHERE in_ritardo = 1 AND stato <> 'CHIUSO'\nORDER BY giorni_ritardo DESC`,
      spiegazione: "Ordini di produzione ancora aperti con data di consegna superata.",
      grafico: NESSUNO,
    };
  }
  if (/oee|efficien/.test(q)) {
    return {
      sql: `SELECT macchina, ROUND(100.0 * SUM(oee * tempo_pianificato_min) / SUM(tempo_pianificato_min), 1) AS oee_pct\nFROM stg_kpi_macchina_giorno\nWHERE ${p.where}\nGROUP BY macchina\nORDER BY oee_pct DESC`,
      spiegazione: `OEE medio pesato per macchina ${p.label}.`,
      grafico: { tipo: "barre", x: "macchina", y: ["oee_pct"] },
    };
  }
  if (/andamento|giorn|trend/.test(q)) {
    return {
      sql: `SELECT data, SUM(pezzi_buoni) AS prodotti_finiti\nFROM stg_produzione\nWHERE fase_finale = 1 AND ${p.where}\nGROUP BY data\nORDER BY data`,
      spiegazione: `Prodotti finiti al giorno ${p.label}.`,
      grafico: { tipo: "linee", x: "data", y: ["prodotti_finiti"] },
    };
  }
  return {
    sql: "",
    spiegazione: "In modalita' demo offline capisco solo alcune domande (pezzi di un operatore, fermi, scarti, ordini in ritardo, OEE, andamento giornaliero). Aggiungi una chiave Claude o OpenAI nel file .env per fare qualsiasi domanda.",
    grafico: NESSUNO,
  };
}

const fmt = (v) => (typeof v === "number" ? v.toLocaleString("it-IT", { maximumFractionDigits: 1 }) : v);

export function mockAnswer({ rows, columns }) {
  if (!rows.length) return "Nessun dato trovato per questa richiesta nel periodo considerato.";
  if (rows.length === 1) return columns.map((c) => `${c.replace(/_/g, " ")}: ${fmt(rows[0][c])}`).join(" · ");
  const [a, b] = columns;
  const first = rows[0], last = rows[rows.length - 1];
  return `${rows.length} righe. Primo: ${fmt(first[a])} (${fmt(first[b])}); ultimo: ${fmt(last[a])} (${fmt(last[b])}).`;
}
