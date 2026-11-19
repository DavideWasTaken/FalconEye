// Crea data/erp.db: un ERP fittizio di un'azienda metalmeccanica ("Officine Demo S.r.l.")
// con anagrafiche, ordini, cicli di lavoro e ~90 giorni di produzione simulata.
// I dati sono generati con un PRNG a seme fisso, quindi ogni esecuzione e' riproducibile
// (cambia solo la finestra di date, che termina sempre "oggi").
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, "../../data");
const ERP_PATH = path.join(DATA_DIR, "erp.db");

const GIORNI_STORICO = 90;

// ---------- utilita' ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261119);
const rand = (a, b) => a + rnd() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
function pickWeighted(items) {
  const tot = items.reduce((s, i) => s + i.w, 0);
  let r = rnd() * tot;
  for (const i of items) { if ((r -= i.w) <= 0) return i; }
  return items[items.length - 1];
}

const pad = (n) => String(n).padStart(2, "0");
const dayMs = 86400000;
function ymd(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function addDays(d, n) { return new Date(d.getTime() + n * dayMs); }
function isWorkday(d) { const w = d.getUTCDay(); return w >= 1 && w <= 5; }
function addWorkdays(d, n) { let x = d; let k = 0; while (k < n) { x = addDays(x, 1); if (isWorkday(x)) k++; } return x; }
// minuti dalla mezzanotte del giorno d (anche > 1440 per il turno di notte) -> "YYYY-MM-DD HH:MM"
function stamp(d, minutes) {
  const t = new Date(d.getTime() + Math.round(minutes) * 60000);
  return `${ymd(t)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

const now = new Date();
const TODAY = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
const NOW_MIN = now.getHours() * 60 + now.getMinutes();
const START = addDays(TODAY, -GIORNI_STORICO + 1);

// ---------- anagrafiche ----------
const reparti = [
  { codice: "TAG", descrizione: "Taglio laser" },
  { codice: "TOR", descrizione: "Tornitura CNC" },
  { codice: "FRE", descrizione: "Fresatura CNC" },
  { codice: "SAL", descrizione: "Saldatura" },
  { codice: "ASS", descrizione: "Assemblaggio" },
  { codice: "VER", descrizione: "Verniciatura" },
  { codice: "QUA", descrizione: "Controllo qualita'" },
  { codice: "MAG", descrizione: "Magazzino e logistica" },
  { codice: "UFF", descrizione: "Uffici e direzione" },
];

const centri = [
  { codice: "CL-TAG", descrizione: "Centro taglio laser", reparto: "TAG", costo_orario: 85, turni: ["M", "P"] },
  { codice: "CL-TOR", descrizione: "Centro tornitura", reparto: "TOR", costo_orario: 70, turni: ["M", "P", "N"] },
  { codice: "CL-FRE", descrizione: "Centro fresatura", reparto: "FRE", costo_orario: 75, turni: ["M", "P", "N"] },
  { codice: "CL-SAL", descrizione: "Centro saldatura", reparto: "SAL", costo_orario: 60, turni: ["M", "P"] },
  { codice: "CL-ASS", descrizione: "Linea assemblaggio", reparto: "ASS", costo_orario: 45, turni: ["M", "P"] },
  { codice: "CL-VER", descrizione: "Impianto verniciatura", reparto: "VER", costo_orario: 55, turni: ["M", "P"] },
];

// guasto = probabilita' di guasto per turno, perf = fattore di velocita', scarto = tasso base
const macchine = [
  { codice: "LASER-01", descrizione: "Laser fibra 3kW", centro: "CL-TAG", marca: "Trumpf", modello: "TruLaser 3030", anno: 2016, guasto: 0.05, perf: 0.95, scarto: 0.012 },
  { codice: "LASER-02", descrizione: "Laser fibra 6kW", centro: "CL-TAG", marca: "Trumpf", modello: "TruLaser 3040", anno: 2021, guasto: 0.025, perf: 1.0, scarto: 0.008 },
  { codice: "TORN-01", descrizione: "Tornio CNC 2 assi", centro: "CL-TOR", marca: "Mazak", modello: "QT-250", anno: 2014, guasto: 0.06, perf: 0.92, scarto: 0.018 },
  { codice: "TORN-02", descrizione: "Tornio CNC 2 assi", centro: "CL-TOR", marca: "Mazak", modello: "QT-250", anno: 2018, guasto: 0.035, perf: 0.97, scarto: 0.012 },
  { codice: "TORN-03", descrizione: "Tornio CNC multitasking", centro: "CL-TOR", marca: "DMG Mori", modello: "CLX 450", anno: 2022, guasto: 0.02, perf: 1.0, scarto: 0.008 },
  { codice: "FRESA-01", descrizione: "Centro di lavoro 5 assi", centro: "CL-FRE", marca: "DMG Mori", modello: "DMU 50", anno: 2015, guasto: 0.04, perf: 0.95, scarto: 0.014 },
  { codice: "FRESA-02", descrizione: "Centro di lavoro verticale", centro: "CL-FRE", marca: "Haas", modello: "VF-4", anno: 2019, guasto: 0.03, perf: 0.97, scarto: 0.011 },
  { codice: "FRESA-03", descrizione: "Centro di lavoro verticale", centro: "CL-FRE", marca: "Haas", modello: "VF-2", anno: 2011, guasto: 0.07, perf: 0.9, scarto: 0.02, problemaMandrino: true },
  { codice: "SALD-01", descrizione: "Robot di saldatura MIG", centro: "CL-SAL", marca: "Fanuc", modello: "ARC Mate 100iD", anno: 2020, guasto: 0.03, perf: 1.0, scarto: 0.01 },
  { codice: "SALD-02", descrizione: "Postazione saldatura manuale", centro: "CL-SAL", marca: "Lincoln Electric", modello: "Speedtec 400SP", anno: 2012, guasto: 0.02, perf: 0.9, scarto: 0.022 },
  { codice: "ASS-01", descrizione: "Linea di assemblaggio manuale", centro: "CL-ASS", marca: "Interna", modello: "LA-1", anno: 2018, guasto: 0.01, perf: 0.96, scarto: 0.006 },
  { codice: "VERN-01", descrizione: "Impianto verniciatura a polvere", centro: "CL-VER", marca: "Wagner", modello: "SuperCenter EVO", anno: 2017, guasto: 0.04, perf: 0.95, scarto: 0.015 },
];

const turni = [
  { codice: "M", descrizione: "Mattino", ora_inizio: "06:00", ora_fine: "14:00", startMin: 360 },
  { codice: "P", descrizione: "Pomeriggio", ora_inizio: "14:00", ora_fine: "22:00", startMin: 840 },
  { codice: "N", descrizione: "Notte", ora_inizio: "22:00", ora_fine: "06:00", startMin: 1320 },
];
const TURNO = Object.fromEntries(turni.map((t) => [t.codice, t]));
const MIN_TURNO = 450; // 8 ore meno 30 minuti di pausa

// perf = produttivita' personale, scarto = moltiplicatore del tasso di scarto
const dipendenti = [
  ["Giuseppe", "Esposito", "TAG", "M", "Operatore laser", 1.0, 1.0],
  ["Francesca", "Romano", "TAG", "M", "Operatore laser", 1.02, 0.8],
  ["Andrea", "Colombo", "TAG", "P", "Operatore laser", 0.97, 1.1],
  ["Marco", "Ricci", "TAG", "P", "Operatore laser", 0.95, 1.2],
  ["Davide", "Marino", "TAG", "J", "Jolly taglio", 0.93, 1.3],
  ["Mario", "Rossi", "TOR", "M", "Tornitore CNC senior", 1.05, 0.6],
  ["Luigi", "Bianchi", "TOR", "M", "Tornitore CNC", 0.98, 1.0],
  ["Paolo", "Greco", "TOR", "M", "Tornitore CNC", 0.96, 1.1],
  ["Stefano", "Bruno", "TOR", "P", "Tornitore CNC", 1.0, 0.9],
  ["Alessandro", "Gallo", "TOR", "P", "Tornitore CNC", 0.94, 1.2],
  ["Roberto", "Conti", "TOR", "P", "Tornitore CNC", 0.99, 1.0],
  ["Antonio", "De Luca", "TOR", "N", "Tornitore CNC", 0.95, 1.2],
  ["Fabio", "Mancini", "TOR", "N", "Tornitore CNC", 0.97, 1.1],
  ["Simone", "Costa", "TOR", "N", "Tornitore CNC", 0.92, 1.3],
  ["Matteo", "Giordano", "TOR", "J", "Jolly tornitura", 0.94, 1.2],
  ["Giovanni", "Rizzo", "FRE", "M", "Fresatore CNC senior", 1.03, 0.7],
  ["Elena", "Lombardi", "FRE", "M", "Fresatore CNC", 1.01, 0.8],
  ["Francesco", "Moretti", "FRE", "M", "Fresatore CNC", 0.97, 1.0],
  ["Daniele", "Barbieri", "FRE", "P", "Fresatore CNC", 0.98, 1.0],
  ["Claudio", "Fontana", "FRE", "P", "Fresatore CNC", 0.96, 1.1],
  ["Sergio", "Santoro", "FRE", "P", "Fresatore CNC", 0.99, 0.9],
  ["Luca", "Ferri", "FRE", "N", "Fresatore CNC", 0.93, 1.9],
  ["Massimo", "Pellegrini", "FRE", "N", "Fresatore CNC", 0.96, 1.2],
  ["Enrico", "Marini", "FRE", "N", "Fresatore CNC", 0.95, 1.1],
  ["Riccardo", "Rinaldi", "FRE", "J", "Jolly fresatura", 0.94, 1.2],
  ["Salvatore", "Leone", "SAL", "M", "Saldatore", 1.0, 0.9],
  ["Vincenzo", "Longo", "SAL", "M", "Saldatore", 0.97, 1.1],
  ["Nicola", "Gentile", "SAL", "P", "Saldatore", 0.98, 1.0],
  ["Emanuele", "Martinelli", "SAL", "P", "Saldatore", 0.95, 1.2],
  ["Pietro", "Vitale", "SAL", "J", "Jolly saldatura", 0.93, 1.3],
  ["Chiara", "Lombardo", "ASS", "M", "Assemblatore", 1.02, 0.8],
  ["Sara", "Serra", "ASS", "P", "Assemblatore", 0.99, 1.0],
  ["Giorgio", "Coppola", "VER", "M", "Verniciatore", 1.0, 1.0],
  ["Alberto", "De Santis", "VER", "P", "Verniciatore", 0.97, 1.1],
  ["Laura", "Marchetti", "QUA", "M", "Addetta controllo qualita'", 1, 1],
  ["Valentina", "Parisi", "QUA", "P", "Addetta controllo qualita'", 1, 1],
  ["Bruno", "Villa", "MAG", "M", "Magazziniere", 1, 1],
  ["Carlo", "Conte", "MAG", "P", "Magazziniere", 1, 1],
  ["Federica", "Ferrara", "UFF", "M", "Responsabile di produzione", 1, 1],
  ["Ivan", "Pellegrini", "UFF", "M", "Pianificatore di produzione", 1, 1],
].map(([nome, cognome, reparto, turno, mansione, perf, scarto], i) => ({
  matricola: `M${String(1001 + i)}`, nome, cognome, reparto, turno, mansione, perf, scarto,
  produzione: ["TAG", "TOR", "FRE", "SAL", "ASS", "VER"].includes(reparto),
}));

const clienti = [
  ["Idraulica Padana S.p.A.", "Mantova", "MN", "Italia", "Idraulica"],
  ["Meccanica Valtrompia S.r.l.", "Lumezzane", "BS", "Italia", "Meccanica"],
  ["Agritech Emilia S.r.l.", "Reggio Emilia", "RE", "Italia", "Macchine agricole"],
  ["Fluidotecnica Berica S.p.A.", "Vicenza", "VI", "Italia", "Oleodinamica"],
  ["Sollevamenti Orobici S.r.l.", "Bergamo", "BG", "Italia", "Sollevamento"],
  ["Automazioni Brianza S.r.l.", "Monza", "MB", "Italia", "Automazione"],
  ["Termotecnica Adriatica S.r.l.", "Pesaro", "PU", "Italia", "Termotecnica"],
  ["Nautica Ligure S.p.A.", "La Spezia", "SP", "Italia", "Nautica"],
  ["Rail Components Torino S.r.l.", "Torino", "TO", "Italia", "Ferroviario"],
  ["Energia Verde Impianti S.r.l.", "Padova", "PD", "Italia", "Energia"],
  ["Packaging Machines Bologna S.p.A.", "Bologna", "BO", "Italia", "Packaging"],
  ["Veicoli Industriali Friuli S.r.l.", "Udine", "UD", "Italia", "Automotive"],
  ["Alpen Maschinenbau GmbH", "Innsbruck", "", "Austria", "Meccanica"],
  ["Bayern Antriebstechnik GmbH", "Augsburg", "", "Germania", "Trasmissioni"],
  ["Rhone Hydraulique SAS", "Lione", "", "Francia", "Idraulica"],
  ["Iberia Agro Maquinaria S.L.", "Saragozza", "", "Spagna", "Macchine agricole"],
  ["Pompe Sannite S.r.l.", "Benevento", "BN", "Italia", "Pompe"],
  ["Compressori Toscani S.p.A.", "Prato", "PO", "Italia", "Compressori"],
].map(([ragione_sociale, citta, provincia, nazione, settore], i) => ({
  codice: `C${String(101 + i)}`, ragione_sociale, citta, provincia, nazione, settore,
  partita_iva: nazione === "Italia" ? String(10000000000 + Math.floor(rnd() * 89999999999)).slice(0, 11) : `EU${randInt(100000000, 999999999)}`,
  peso: rand(0.4, 2.5),
}));

const fornitori = [
  ["Acciai Lombardi S.p.A.", "Brescia", "Italia", "Acciaio"],
  ["Metalli Speciali Nord S.r.l.", "Milano", "Italia", "Leghe e bronzi"],
  ["Alluminio Veneto S.r.l.", "Verona", "Italia", "Alluminio"],
  ["Polveri e Vernici Industriali S.r.l.", "Bergamo", "Italia", "Vernici"],
  ["Viteria Emiliana S.r.l.", "Modena", "Italia", "Minuteria"],
  ["Cuscinetti e Trasmissioni S.p.A.", "Torino", "Italia", "Cuscinetti"],
  ["Tenute Tecniche S.r.l.", "Bologna", "Italia", "Guarnizioni"],
  ["Gas Tecnici Saldatura S.r.l.", "Brescia", "Italia", "Consumabili saldatura"],
  ["Utensileria di Precisione S.r.l.", "Lecco", "Italia", "Utensili"],
].map(([ragione_sociale, citta, nazione, categoria], i) => ({
  codice: `F${String(201 + i)}`, ragione_sociale, citta, nazione, categoria,
  partita_iva: String(10000000000 + Math.floor(rnd() * 89999999999)).slice(0, 11),
}));

// Materie prime (MP), semilavorati (SL), prodotti finiti (PF)
const articoli = [
  { codice: "MP-S355", descrizione: "Lamiera acciaio S355 sp. 6mm", tipo: "MP", um: "KG", costo: 1.35, fornitore: "F201" },
  { codice: "MP-C45", descrizione: "Barra tonda acciaio C45 d.60", tipo: "MP", um: "KG", costo: 1.6, fornitore: "F201" },
  { codice: "MP-AL6082", descrizione: "Barra alluminio 6082 d.80", tipo: "MP", um: "KG", costo: 4.2, fornitore: "F203" },
  { codice: "MP-CUSN12", descrizione: "Barra bronzo CuSn12 d.40", tipo: "MP", um: "KG", costo: 11.5, fornitore: "F202" },
  { codice: "MP-RAL5010", descrizione: "Vernice a polvere RAL 5010", tipo: "MP", um: "KG", costo: 7.8, fornitore: "F204" },
  { codice: "MP-VITM8", descrizione: "Vite TE M8x25 classe 8.8", tipo: "MP", um: "PZ", costo: 0.07, fornitore: "F205" },
  { codice: "MP-CUS6205", descrizione: "Cuscinetto radiale 6205-2RS", tipo: "MP", um: "PZ", costo: 2.4, fornitore: "F206" },
  { codice: "MP-OR040", descrizione: "O-ring NBR 40x3", tipo: "MP", um: "PZ", costo: 0.12, fornitore: "F207" },
  { codice: "MP-FILSG2", descrizione: "Filo saldatura SG2 d.1,0", tipo: "MP", um: "KG", costo: 3.1, fornitore: "F208" },
  { codice: "SL-ING30", descrizione: "Ingranaggio cilindrico Z30 m2", tipo: "SL", um: "PZ", costo: 18.5, prezzo: 0, ciclo: [["CL-TOR", 150, 25], ["CL-FRE", 210, 30]], bom: [["MP-C45", 1.6]], qty: [80, 300], domanda: 0.6 },
  { codice: "PF-FL100", descrizione: "Flangia DN100 PN16", tipo: "PF", um: "PZ", costo: 14.2, prezzo: 27.5, ciclo: [["CL-TAG", 40, 15], ["CL-TOR", 110, 25], ["CL-FRE", 80, 20], ["CL-VER", 25, 30]], bom: [["MP-S355", 3.2], ["MP-RAL5010", 0.05]], qty: [150, 600], domanda: 1.4 },
  { codice: "PF-AL200", descrizione: "Albero di trasmissione L200", tipo: "PF", um: "PZ", costo: 21.0, prezzo: 44.0, ciclo: [["CL-TOR", 170, 30], ["CL-FRE", 140, 25]], bom: [["MP-C45", 2.4]], qty: [100, 400], domanda: 1.0 },
  { codice: "PF-ST050", descrizione: "Staffa di supporto 50x120", tipo: "PF", um: "PZ", costo: 6.4, prezzo: 13.9, ciclo: [["CL-TAG", 25, 10], ["CL-SAL", 55, 15], ["CL-VER", 20, 30]], bom: [["MP-S355", 1.1], ["MP-FILSG2", 0.02], ["MP-RAL5010", 0.03]], qty: [300, 1200], domanda: 1.3 },
  { codice: "PF-CV300", descrizione: "Corpo valvola DN30 alluminio", tipo: "PF", um: "PZ", costo: 38.0, prezzo: 79.0, ciclo: [["CL-TOR", 230, 35], ["CL-FRE", 290, 40], ["CL-ASS", 110, 10]], bom: [["MP-AL6082", 1.9], ["MP-OR040", 2], ["MP-VITM8", 4]], qty: [60, 250], domanda: 0.9 },
  { codice: "PF-PG010", descrizione: "Perno guida d.20 rettificato", tipo: "PF", um: "PZ", costo: 3.2, prezzo: 7.4, ciclo: [["CL-TOR", 55, 15]], bom: [["MP-C45", 0.45]], qty: [400, 2000], domanda: 1.1 },
  { codice: "PF-CS400", descrizione: "Carter di protezione 400", tipo: "PF", um: "PZ", costo: 29.0, prezzo: 61.0, ciclo: [["CL-TAG", 85, 15], ["CL-SAL", 170, 20], ["CL-VER", 55, 30]], bom: [["MP-S355", 8.5], ["MP-FILSG2", 0.08], ["MP-RAL5010", 0.15]], qty: [60, 250], domanda: 0.8 },
  { codice: "PF-GR120", descrizione: "Gruppo riduttore R120", tipo: "PF", um: "PZ", costo: 142.0, prezzo: 289.0, ciclo: [["CL-ASS", 540, 20]], bom: [["SL-ING30", 2], ["PF-AL200", 1], ["MP-CUS6205", 2], ["MP-VITM8", 8], ["MP-OR040", 1]], qty: [20, 80], domanda: 0.5 },
  { codice: "PF-MZ080", descrizione: "Mozzo ruota d.80", tipo: "PF", um: "PZ", costo: 17.5, prezzo: 36.0, ciclo: [["CL-TOR", 140, 25], ["CL-FRE", 115, 20]], bom: [["MP-C45", 2.1]], qty: [100, 450], domanda: 1.0 },
  { codice: "PF-TP020", descrizione: "Telaio portante TP20 saldato", tipo: "PF", um: "PZ", costo: 96.0, prezzo: 198.0, ciclo: [["CL-TAG", 110, 20], ["CL-SAL", 400, 30], ["CL-VER", 140, 30]], bom: [["MP-S355", 24], ["MP-FILSG2", 0.3], ["MP-RAL5010", 0.4]], qty: [20, 90], domanda: 0.6 },
  { codice: "PF-BC030", descrizione: "Boccola in bronzo d.30", tipo: "PF", um: "PZ", costo: 5.9, prezzo: 12.8, ciclo: [["CL-TOR", 45, 10]], bom: [["MP-CUSN12", 0.35]], qty: [500, 2500], domanda: 0.9 },
];
const ART = Object.fromEntries(articoli.map((a) => [a.codice, a]));

const causaliFermo = [
  { codice: "GUASTO_MECC", descrizione: "Guasto meccanico", categoria: "Guasto", pianificato: 0 },
  { codice: "GUASTO_ELET", descrizione: "Guasto elettrico/elettronico", categoria: "Guasto", pianificato: 0 },
  { codice: "ATTREZZ", descrizione: "Attrezzaggio / cambio produzione", categoria: "Setup", pianificato: 0 },
  { codice: "CAMBIO_UT", descrizione: "Cambio utensile", categoria: "Setup", pianificato: 0 },
  { codice: "MICRO", descrizione: "Microfermata", categoria: "Microfermate", pianificato: 0 },
  { codice: "MANC_MAT", descrizione: "Mancanza materiale", categoria: "Logistica", pianificato: 0 },
  { codice: "ATT_QUAL", descrizione: "Attesa controllo qualita'", categoria: "Qualita'", pianificato: 0 },
  { codice: "MANC_LAV", descrizione: "Mancanza lavoro / ordini", categoria: "Organizzativo", pianificato: 1 },
  { codice: "MAN_PROG", descrizione: "Manutenzione programmata", categoria: "Manutenzione", pianificato: 1 },
];

const causaliScarto = [
  { codice: "DIM", descrizione: "Fuori tolleranza dimensionale", categoria: "Dimensionale" },
  { codice: "SUP", descrizione: "Difetto superficiale / rugosita'", categoria: "Estetico" },
  { codice: "BAV", descrizione: "Bave o taglio irregolare", categoria: "Lavorazione" },
  { codice: "SALD", descrizione: "Saldatura difettosa / porosita'", categoria: "Lavorazione" },
  { codice: "VERN", descrizione: "Verniciatura non conforme", categoria: "Estetico" },
  { codice: "MAT", descrizione: "Difetto del materiale grezzo", categoria: "Materiale" },
  { codice: "MONT", descrizione: "Errore di montaggio", categoria: "Lavorazione" },
  { codice: "PROVA", descrizione: "Pezzo di prova attrezzaggio", categoria: "Setup" },
];
const SCARTO_PER_CENTRO = {
  "CL-TAG": [{ c: "BAV", w: 5 }, { c: "DIM", w: 3 }, { c: "MAT", w: 1 }, { c: "PROVA", w: 2 }],
  "CL-TOR": [{ c: "DIM", w: 6 }, { c: "SUP", w: 3 }, { c: "MAT", w: 1 }, { c: "PROVA", w: 2 }],
  "CL-FRE": [{ c: "DIM", w: 6 }, { c: "SUP", w: 3 }, { c: "PROVA", w: 2 }],
  "CL-SAL": [{ c: "SALD", w: 7 }, { c: "DIM", w: 2 }],
  "CL-ASS": [{ c: "MONT", w: 5 }, { c: "MAT", w: 2 }],
  "CL-VER": [{ c: "VERN", w: 6 }, { c: "SUP", w: 2 }],
};

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of [ERP_PATH, ERP_PATH + "-wal", ERP_PATH + "-shm"]) if (fs.existsSync(f)) fs.rmSync(f);
const db = new Database(ERP_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE reparti (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL);
CREATE TABLE centri_lavoro (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL, reparto_id INTEGER NOT NULL REFERENCES reparti(id), costo_orario REAL NOT NULL);
CREATE TABLE macchine (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL, centro_lavoro_id INTEGER NOT NULL REFERENCES centri_lavoro(id), marca TEXT, modello TEXT, anno_installazione INTEGER, stato TEXT NOT NULL DEFAULT 'ATTIVA');
CREATE TABLE turni (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL, ora_inizio TEXT NOT NULL, ora_fine TEXT NOT NULL);
CREATE TABLE dipendenti (id INTEGER PRIMARY KEY, matricola TEXT UNIQUE NOT NULL, nome TEXT NOT NULL, cognome TEXT NOT NULL, reparto_id INTEGER NOT NULL REFERENCES reparti(id), mansione TEXT, turno_abituale_id INTEGER REFERENCES turni(id), data_assunzione TEXT, attivo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE clienti (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, ragione_sociale TEXT NOT NULL, partita_iva TEXT, citta TEXT, provincia TEXT, nazione TEXT, settore TEXT);
CREATE TABLE fornitori (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, ragione_sociale TEXT NOT NULL, partita_iva TEXT, citta TEXT, nazione TEXT, categoria TEXT);
CREATE TABLE unita_misura (codice TEXT PRIMARY KEY, descrizione TEXT NOT NULL);
CREATE TABLE magazzini (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL);
CREATE TABLE articoli (id INTEGER PRIMARY KEY, codice TEXT UNIQUE NOT NULL, descrizione TEXT NOT NULL, tipo TEXT NOT NULL CHECK (tipo IN ('MP','SL','PF')), um TEXT NOT NULL REFERENCES unita_misura(codice), costo_standard REAL, prezzo_listino REAL, fornitore_abituale_id INTEGER REFERENCES fornitori(id));
CREATE TABLE distinta_base (id INTEGER PRIMARY KEY, articolo_padre_id INTEGER NOT NULL REFERENCES articoli(id), articolo_figlio_id INTEGER NOT NULL REFERENCES articoli(id), quantita REAL NOT NULL);
CREATE TABLE cicli_lavoro (id INTEGER PRIMARY KEY, articolo_id INTEGER NOT NULL REFERENCES articoli(id), fase INTEGER NOT NULL, descrizione_fase TEXT, centro_lavoro_id INTEGER NOT NULL REFERENCES centri_lavoro(id), tempo_ciclo_sec REAL NOT NULL, tempo_attrezzaggio_min REAL NOT NULL, UNIQUE (articolo_id, fase));
CREATE TABLE ordini_cliente (id INTEGER PRIMARY KEY, numero TEXT UNIQUE NOT NULL, cliente_id INTEGER NOT NULL REFERENCES clienti(id), data_ordine TEXT NOT NULL, data_consegna_richiesta TEXT NOT NULL, stato TEXT NOT NULL);
CREATE TABLE righe_ordine_cliente (id INTEGER PRIMARY KEY, ordine_id INTEGER NOT NULL REFERENCES ordini_cliente(id), riga INTEGER NOT NULL, articolo_id INTEGER NOT NULL REFERENCES articoli(id), quantita REAL NOT NULL, prezzo_unitario REAL NOT NULL);
CREATE TABLE ordini_produzione (id INTEGER PRIMARY KEY, numero TEXT UNIQUE NOT NULL, articolo_id INTEGER NOT NULL REFERENCES articoli(id), riga_ordine_cliente_id INTEGER REFERENCES righe_ordine_cliente(id), quantita REAL NOT NULL, data_rilascio TEXT NOT NULL, data_consegna_prevista TEXT NOT NULL, data_chiusura TEXT, stato TEXT NOT NULL CHECK (stato IN ('PIANIFICATO','RILASCIATO','IN_LAVORAZIONE','CHIUSO')));
CREATE TABLE causali_fermo (codice TEXT PRIMARY KEY, descrizione TEXT NOT NULL, categoria TEXT NOT NULL, pianificato INTEGER NOT NULL);
CREATE TABLE causali_scarto (codice TEXT PRIMARY KEY, descrizione TEXT NOT NULL, categoria TEXT NOT NULL);
CREATE TABLE dichiarazioni_produzione (id INTEGER PRIMARY KEY, odp_id INTEGER NOT NULL REFERENCES ordini_produzione(id), fase INTEGER NOT NULL, macchina_id INTEGER NOT NULL REFERENCES macchine(id), dipendente_id INTEGER NOT NULL REFERENCES dipendenti(id), turno_id INTEGER NOT NULL REFERENCES turni(id), data_turno TEXT NOT NULL, inizio TEXT NOT NULL, fine TEXT NOT NULL, minuti_lavorazione REAL NOT NULL, quantita_buona REAL NOT NULL, quantita_scarto REAL NOT NULL);
CREATE TABLE dettaglio_scarti (id INTEGER PRIMARY KEY, dichiarazione_id INTEGER NOT NULL REFERENCES dichiarazioni_produzione(id), causale_scarto TEXT NOT NULL REFERENCES causali_scarto(codice), quantita REAL NOT NULL);
CREATE TABLE fermi_macchina (id INTEGER PRIMARY KEY, macchina_id INTEGER NOT NULL REFERENCES macchine(id), causale_fermo TEXT NOT NULL REFERENCES causali_fermo(codice), dipendente_id INTEGER REFERENCES dipendenti(id), turno_id INTEGER NOT NULL REFERENCES turni(id), data_turno TEXT NOT NULL, inizio TEXT NOT NULL, fine TEXT NOT NULL, durata_min REAL NOT NULL, note TEXT);
CREATE TABLE timbrature (id INTEGER PRIMARY KEY, dipendente_id INTEGER NOT NULL REFERENCES dipendenti(id), data TEXT NOT NULL, turno_id INTEGER REFERENCES turni(id), tipo TEXT NOT NULL CHECK (tipo IN ('PRESENZA','FERIE','MALATTIA','PERMESSO')), entrata TEXT, uscita TEXT, ore_ordinarie REAL NOT NULL DEFAULT 0, ore_straordinario REAL NOT NULL DEFAULT 0);
CREATE TABLE movimenti_magazzino (id INTEGER PRIMARY KEY, data TEXT NOT NULL, articolo_id INTEGER NOT NULL REFERENCES articoli(id), magazzino_id INTEGER NOT NULL REFERENCES magazzini(id), causale TEXT NOT NULL, quantita REAL NOT NULL, riferimento TEXT);
CREATE TABLE giacenze (articolo_id INTEGER NOT NULL REFERENCES articoli(id), magazzino_id INTEGER NOT NULL REFERENCES magazzini(id), quantita REAL NOT NULL, aggiornato_il TEXT NOT NULL, PRIMARY KEY (articolo_id, magazzino_id));
CREATE TABLE ordini_acquisto (id INTEGER PRIMARY KEY, numero TEXT UNIQUE NOT NULL, fornitore_id INTEGER NOT NULL REFERENCES fornitori(id), data_ordine TEXT NOT NULL, data_consegna_prevista TEXT NOT NULL, stato TEXT NOT NULL);
CREATE TABLE righe_ordine_acquisto (id INTEGER PRIMARY KEY, ordine_id INTEGER NOT NULL REFERENCES ordini_acquisto(id), riga INTEGER NOT NULL, articolo_id INTEGER NOT NULL REFERENCES articoli(id), quantita REAL NOT NULL, prezzo_unitario REAL NOT NULL);
CREATE TABLE controlli_qualita (id INTEGER PRIMARY KEY, odp_id INTEGER NOT NULL REFERENCES ordini_produzione(id), data TEXT NOT NULL, dipendente_id INTEGER REFERENCES dipendenti(id), pezzi_controllati INTEGER NOT NULL, esito TEXT NOT NULL CHECK (esito IN ('CONFORME','CONFORME_CON_RISERVA','NON_CONFORME')), note TEXT);
CREATE INDEX ix_dich_data ON dichiarazioni_produzione(data_turno);
CREATE INDEX ix_fermi_data ON fermi_macchina(data_turno);
CREATE INDEX ix_mov_art ON movimenti_magazzino(articolo_id);
`);

const ids = {};
function insertAll(table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`);
  const tx = db.transaction((rs) => { for (const r of rs) stmt.run(r); });
  tx(rows);
}

const id = (map, key) => map.get(key);
const mapOf = (list, key = "codice") => new Map(list.map((x, i) => [x[key], i + 1]));
ids.reparti = mapOf(reparti); ids.centri = mapOf(centri); ids.macchine = mapOf(macchine);
ids.turni = mapOf(turni); ids.dip = mapOf(dipendenti, "matricola"); ids.clienti = mapOf(clienti);
ids.fornitori = mapOf(fornitori); ids.articoli = mapOf(articoli);

insertAll("reparti", reparti.map((r, i) => ({ id: i + 1, codice: r.codice, descrizione: r.descrizione })));
insertAll("centri_lavoro", centri.map((c, i) => ({ id: i + 1, codice: c.codice, descrizione: c.descrizione, reparto_id: id(ids.reparti, c.reparto), costo_orario: c.costo_orario })));
insertAll("macchine", macchine.map((m, i) => ({ id: i + 1, codice: m.codice, descrizione: m.descrizione, centro_lavoro_id: id(ids.centri, m.centro), marca: m.marca, modello: m.modello, anno_installazione: m.anno, stato: "ATTIVA" })));
insertAll("turni", turni.map((t, i) => ({ id: i + 1, codice: t.codice, descrizione: t.descrizione, ora_inizio: t.ora_inizio, ora_fine: t.ora_fine })));
insertAll("dipendenti", dipendenti.map((d, i) => ({
  id: i + 1, matricola: d.matricola, nome: d.nome, cognome: d.cognome, reparto_id: id(ids.reparti, d.reparto), mansione: d.mansione,
  turno_abituale_id: d.turno === "J" ? id(ids.turni, "M") : id(ids.turni, d.turno),
  data_assunzione: `${randInt(1998, 2024)}-${pad(randInt(1, 12))}-${pad(randInt(1, 28))}`, attivo: 1,
})));
insertAll("clienti", clienti.map((c, i) => ({ id: i + 1, codice: c.codice, ragione_sociale: c.ragione_sociale, partita_iva: c.partita_iva, citta: c.citta, provincia: c.provincia, nazione: c.nazione, settore: c.settore })));
insertAll("fornitori", fornitori.map((f, i) => ({ id: i + 1, codice: f.codice, ragione_sociale: f.ragione_sociale, partita_iva: f.partita_iva, citta: f.citta, nazione: f.nazione, categoria: f.categoria })));
insertAll("unita_misura", [{ codice: "PZ", descrizione: "Pezzi" }, { codice: "KG", descrizione: "Chilogrammi" }]);
insertAll("magazzini", [
  { id: 1, codice: "MAG-MP", descrizione: "Magazzino materie prime" },
  { id: 2, codice: "MAG-PF", descrizione: "Magazzino prodotti finiti e semilavorati" },
]);
insertAll("articoli", articoli.map((a, i) => ({
  id: i + 1, codice: a.codice, descrizione: a.descrizione, tipo: a.tipo, um: a.um, costo_standard: a.costo,
  prezzo_listino: a.prezzo ?? null, fornitore_abituale_id: a.fornitore ? id(ids.fornitori, a.fornitore) : null,
})));
insertAll("causali_fermo", causaliFermo);
insertAll("causali_scarto", causaliScarto);

// ---------- domanda: ordini cliente -> ordini di produzione ----------
const producibili = articoli.filter((a) => a.ciclo);
const ordiniCliente = []; const righeOC = []; const odps = [];
let ocNum = 1, odpNum = 1;
const ORDER_START = addDays(START, -21);
const ORDER_END = addDays(TODAY, 10); // qualche ordine futuro, ancora PIANIFICATO
for (let d = ORDER_START; d <= ORDER_END; d = addDays(d, 1)) {
  if (!isWorkday(d)) continue;
  const nOrdini = randInt(1, 3);
  for (let k = 0; k < nOrdini; k++) {
    const cliente = pickWeighted(clienti.map((c) => ({ ...c, w: c.peso })));
    const oc = { id: ordiniCliente.length + 1, numero: `OC-${d.getUTCFullYear()}-${String(ocNum++).padStart(5, "0")}`, cliente_id: id(ids.clienti, cliente.codice), data_ordine: ymd(d), consegna: addWorkdays(d, chance(0.18) ? randInt(5, 8) : randInt(12, 24)) }; // ~18% ordini urgenti
    ordiniCliente.push(oc);
    const nRighe = randInt(1, 3);
    const usati = new Set();
    for (let r = 1; r <= nRighe; r++) {
      const art = pickWeighted(producibili.filter((a) => !usati.has(a.codice)).map((a) => ({ ...a, w: a.domanda })));
      usati.add(art.codice);
      const qty = rand(art.qty[0], art.qty[1]);
      const riga = { id: righeOC.length + 1, ordine_id: oc.id, riga: r * 10, articolo: art, quantita: qty, prezzo_unitario: art.prezzo ? +(art.prezzo * rand(0.92, 1.05)).toFixed(2) : +(art.costo * 1.8).toFixed(2) };
      righeOC.push(riga);
      const rilascio = addWorkdays(d, randInt(1, 3));
      odps.push({ riga, articolo: art, quantitaRaw: qty, rilascio, consegna: addWorkdays(oc.consegna, -randInt(1, 3)), oc });
    }
  }
}

// Calibrazione: scala le quantita' perche' il centro piu' carico lavori al ~95% della capacita' effettiva
const giorniLav = []; for (let d = START; d <= TODAY; d = addDays(d, 1)) if (isWorkday(d)) giorniLav.push(d);
const capacita = {}; const carico = {};
for (const c of centri) {
  const nMacc = macchine.filter((m) => m.centro === c.codice).length;
  capacita[c.codice] = nMacc * c.turni.length * MIN_TURNO * 0.8 * giorniLav.length;
  carico[c.codice] = 0;
}
const winStart = addDays(START, -5);
for (const o of odps) {
  if (o.rilascio < winStart || o.rilascio > TODAY) continue;
  for (const [centro, sec] of o.articolo.ciclo) carico[centro] += (o.quantitaRaw * sec) / 60;
}
const TARGET = 0.9;
const fattore = Math.min(...centri.map((c) => (capacita[c.codice] * TARGET) / carico[c.codice]));
for (const o of odps) {
  const q = Math.max(10, Math.round((o.quantitaRaw * fattore) / 10) * 10);
  o.quantita = q; o.riga.quantita = q;
}
// i centri meno carichi ricevono tempi ciclo piu' lunghi, cosi' tutti i reparti lavorano a regime simile
for (const c of centri) {
  const k = Math.min(2.5, Math.max(1, (capacita[c.codice] * TARGET * rand(0.85, 0.95)) / (carico[c.codice] * fattore)));
  for (const a of articoli) for (const fase of a.ciclo ?? []) if (fase[0] === c.codice) fase[1] = Math.round(fase[1] * k);
}
const bomRows = []; const cicloRows = [];
for (const a of articoli) {
  for (const [figlio, q] of a.bom ?? []) bomRows.push({ articolo_padre_id: id(ids.articoli, a.codice), articolo_figlio_id: id(ids.articoli, figlio), quantita: q });
  (a.ciclo ?? []).forEach(([centro, sec, setup], k) => cicloRows.push({
    articolo_id: id(ids.articoli, a.codice), fase: (k + 1) * 10, descrizione_fase: centri.find((c) => c.codice === centro).descrizione.replace("Centro ", ""),
    centro_lavoro_id: id(ids.centri, centro), tempo_ciclo_sec: sec, tempo_attrezzaggio_min: setup,
  }));
}
insertAll("distinta_base", bomRows);
insertAll("cicli_lavoro", cicloRows);

// ---------- simulazione produzione ----------
const dich = []; const dettScarti = []; const fermi = []; const timbr = []; const movimenti = []; const controlli = [];
const odpState = odps.map((o, i) => ({
  ...o, idx: i, id: i + 1, numero: `ODP-${o.rilascio.getUTCFullYear()}-${String(odpNum++).padStart(5, "0")}`,
  prodotto: o.articolo.ciclo.map(() => 0), // pezzi buoni per fase
  stato: "PIANIFICATO", chiusura: null, scartoTot: 0,
}));
const macState = macchine.map(() => ({ ultimoOdp: null, prossimaManut: randInt(5, 18) }));

// assenze: ferie a blocchi + malattie sporadiche
const assenze = new Map(); // `${matricola}|${ymd}` -> tipo
for (const d of dipendenti) {
  if (chance(0.55)) {
    const inizio = randInt(0, GIORNI_STORICO - 8);
    for (let k = 0; k < randInt(3, 7); k++) assenze.set(`${d.matricola}|${ymd(addDays(START, inizio + k))}`, "FERIE");
  }
  for (const g of giorniLav) {
    const key = `${d.matricola}|${ymd(g)}`;
    if (!assenze.has(key) && chance(0.025)) assenze.set(key, chance(0.7) ? "MALATTIA" : "PERMESSO");
  }
}

const centroDi = Object.fromEntries(macchine.map((m) => [m.codice, m.centro]));
const repartoDi = Object.fromEntries(centri.map((c) => [c.codice, c.reparto]));
const isOttobre = (d) => d.getUTCMonth() === 9;

for (const d of giorniLav) {
  const ds = ymd(d);
  // ordini rilasciati
  for (const o of odpState) if (o.stato === "PIANIFICATO" && o.rilascio <= d) o.stato = "RILASCIATO";

  const presentiOggi = new Set();
  const jollyUsati = new Set();
  for (const turno of ["M", "P", "N"]) {
    const t = TURNO[turno];
    // turno non ancora terminato oggi -> non ci sono dati
    if (ds === ymd(TODAY) && t.startMin + 480 > NOW_MIN) continue;

    for (const c of centri) {
      if (!c.turni.includes(turno)) continue;
      const maccCentro = macchine.filter((m) => m.centro === c.codice).sort(() => rnd() - 0.5);
      // operatori disponibili
      const ops = dipendenti.filter((p) => p.reparto === c.reparto && p.turno === turno && !assenze.has(`${p.matricola}|${ds}`));
      const jolly = dipendenti.filter((p) => p.reparto === c.reparto && p.turno === "J" && !assenze.has(`${p.matricola}|${ds}`) && !jollyUsati.has(p.matricola));
      while (ops.length < maccCentro.length && jolly.length) { const j = jolly.shift(); jollyUsati.add(j.matricola); ops.push(j); }

      maccCentro.forEach((m, mi) => {
        const op = ops[mi];
        if (!op) return; // macchina non presidiata
        presentiOggi.add(`${op.matricola}|${turno}`);
        const mIdx = ids.macchine.get(m.codice) - 1;
        const ms = macState[mIdx];
        const turnoId = ids.turni.get(turno);
        const dipId = ids.dip.get(op.matricola);
        const shiftStart = t.startMin;

        // fermi casuali (posizionati dopo, sulla linea del tempo)
        const stops = [];
        let guastoP = m.guasto;
        if (m.problemaMandrino && isOttobre(d)) guastoP = 0.28; // FRESA-03: problema al mandrino a ottobre
        if (m.problemaMandrino && d.getUTCMonth() >= 10) guastoP = 0.03; // sistemato dopo la revisione
        if (turno === "N") guastoP *= 1.2;
        if (chance(guastoP)) stops.push({ causale: chance(0.65) ? "GUASTO_MECC" : "GUASTO_ELET", dur: randInt(20, m.problemaMandrino && isOttobre(d) ? 240 : 150), note: m.problemaMandrino && isOttobre(d) ? "Vibrazioni mandrino, intervento manutenzione" : null });
        const nMicro = randInt(0, 3);
        for (let k = 0; k < nMicro; k++) stops.push({ causale: "MICRO", dur: randInt(3, 15) });
        if (chance(0.06)) stops.push({ causale: "MANC_MAT", dur: randInt(15, 90), note: "In attesa di materiale dal magazzino" });
        if (chance(0.04)) stops.push({ causale: "ATT_QUAL", dur: randInt(10, 45) });
        if (["CL-TOR", "CL-FRE"].includes(m.centro) && chance(0.25)) stops.push({ causale: "CAMBIO_UT", dur: randInt(5, 20) });
        if (turno === "M") {
          ms.prossimaManut--;
          if (ms.prossimaManut <= 0) { stops.push({ causale: "MAN_PROG", dur: randInt(60, 150), note: "Manutenzione preventiva periodica" }); ms.prossimaManut = randInt(12, 20); }
        }
        let budget = MIN_TURNO - stops.reduce((s, x) => s + x.dur, 0);
        if (budget < 30) { stops.length = 0; budget = MIN_TURNO; }

        // lavorazioni (Earliest Due Date sulle fasi disponibili del centro)
        const jobs = []; let prodPos = 0;
        const setupStops = [];
        while (budget - prodPos > 5) {
          const candidati = odpState.filter((o) => {
            if (o.stato === "PIANIFICATO" || o.stato === "CHIUSO") return false;
            const fIdx = o.articolo.ciclo.findIndex(([cc]) => cc === m.centro);
            if (fIdx < 0) return false;
            const disponibili = (fIdx === 0 ? o.quantita : o.prodotto[fIdx - 1]) - o.prodotto[fIdx];
            if (disponibili < 1) return false;
            if (o.inLavorazioneDa && o.inLavorazioneDa !== `${m.codice}|${ds}|${turno}` && o.inLavorazioneTurno === `${ds}|${turno}`) return false;
            return true;
          });
          if (!candidati.length) break;
          candidati.sort((a, b) => (ms.ultimoOdp === b.id) - (ms.ultimoOdp === a.id) || a.consegna - b.consegna || a.id - b.id);
          const o = candidati[0];
          const fIdx = o.articolo.ciclo.findIndex(([cc]) => cc === m.centro);
          const [, cicloSec, setupMin] = o.articolo.ciclo[fIdx];
          if (ms.ultimoOdp !== o.id) {
            const s = Math.min(setupMin * rand(0.8, 1.4), budget - prodPos);
            setupStops.push({ causale: "ATTREZZ", dur: Math.round(s), at: prodPos, note: `Attrezzaggio per ${o.numero}` });
            budget -= Math.round(s);
            ms.ultimoOdp = o.id;
            if (budget - prodPos <= 5) break;
          }
          o.inLavorazioneDa = `${m.codice}|${ds}|${turno}`; o.inLavorazioneTurno = `${ds}|${turno}`;
          const disponibili = (fIdx === 0 ? o.quantita : o.prodotto[fIdx - 1]) - o.prodotto[fIdx];
          let perf = Math.min(1, op.perf * m.perf * rand(0.88, 1.02));
          let sr = m.scarto * op.scarto * (turno === "N" ? 1.45 : 1) * rand(0.5, 1.6);
          if (m.problemaMandrino && isOttobre(d)) sr *= 2.2;
          const minuti = budget - prodPos;
          const pezziPossibili = Math.floor((minuti * 60 * perf) / cicloSec);
          let buoni, scarto, minUsati;
          const servono = Math.ceil(disponibili * (1 + sr));
          if (pezziPossibili >= servono && fIdx > 0) {
            // fase successiva: lavora i pezzi arrivati, una parte puo' essere scartata
            scarto = Math.round(disponibili * sr); buoni = disponibili - scarto;
            minUsati = Math.ceil((disponibili * cicloSec) / 60 / perf);
          } else if (pezziPossibili >= servono) {
            buoni = disponibili; scarto = Math.round(disponibili * sr);
            minUsati = Math.ceil(((buoni + scarto) * cicloSec) / 60 / perf);
          } else {
            const tot = pezziPossibili;
            scarto = Math.round(tot * sr / (1 + sr));
            buoni = fIdx > 0 ? Math.min(disponibili - scarto, tot - scarto) : tot - scarto;
            minUsati = minuti;
          }
          if (buoni + scarto < 1) break;
          minUsati = Math.min(minUsati, minuti);
          jobs.push({ o, fIdx, buoni, scarto, from: prodPos, to: prodPos + minUsati });
          prodPos += minUsati;
          o.prodotto[fIdx] += buoni;
          if (fIdx > 0) o.prodotto[fIdx] = Math.min(o.prodotto[fIdx], o.prodotto[fIdx - 1]);
          o.scartoTot += scarto;
          if (o.stato === "RILASCIATO") o.stato = "IN_LAVORAZIONE";
          if (o.prodotto[o.prodotto.length - 1] >= o.quantita) { o.stato = "CHIUSO"; o.chiusura = ds; }
        }
        // tempo residuo senza lavoro
        const residuo = budget - prodPos;
        const randomStops = stops.map((s) => ({ ...s, at: Math.round(rand(0, prodPos)) }));
        if (residuo >= 5) randomStops.push({ causale: "MANC_LAV", dur: Math.round(residuo), at: prodPos, note: "Nessun ordine lavorabile sul centro" });
        const allStops = [...setupStops, ...randomStops].sort((a, b) => a.at - b.at || (a.causale === "ATTREZZ" ? -1 : 1));
        const wall = (pos, incl) => pos + allStops.filter((s) => (incl ? s.at <= pos : s.at < pos)).reduce((acc, s) => acc + s.dur, 0);
        let cum = 0;
        for (const s of allStops) {
          const startW = s.at + cum; cum += s.dur;
          if (s.dur < 1) continue;
          fermi.push({
            macchina_id: mIdx + 1, causale_fermo: s.causale, dipendente_id: dipId, turno_id: turnoId, data_turno: ds,
            inizio: stamp(d, shiftStart + startW), fine: stamp(d, shiftStart + startW + s.dur), durata_min: s.dur, note: s.note ?? null,
          });
        }
        for (const j of jobs) {
          const dId = dich.length + 1;
          dich.push({
            id: dId, odp_id: j.o.id, fase: (j.fIdx + 1) * 10, macchina_id: mIdx + 1, dipendente_id: dipId, turno_id: turnoId, data_turno: ds,
            inizio: stamp(d, shiftStart + wall(j.from, true)), fine: stamp(d, shiftStart + wall(j.to, false)),
            minuti_lavorazione: j.to - j.from, quantita_buona: j.buoni, quantita_scarto: j.scarto,
          });
          // dettaglio scarti per causale
          let rest = j.scarto;
          while (rest > 0) {
            const c = pickWeighted(SCARTO_PER_CENTRO[m.centro]).c;
            const q = rest <= 2 ? rest : randInt(1, rest);
            dettScarti.push({ dichiarazione_id: dId, causale_scarto: c, quantita: q });
            rest -= q;
          }
          // movimenti di magazzino
          const art = j.o.articolo;
          if (j.fIdx === 0) for (const [mp, q] of art.bom) movimenti.push({ data: ds, articolo_id: ids.articoli.get(mp), magazzino_id: ART[mp].tipo === "MP" ? 1 : 2, causale: "SCARICO_PRODUZIONE", quantita: -+(q * (j.buoni + j.scarto)).toFixed(2), riferimento: j.o.numero });
          if (j.fIdx === art.ciclo.length - 1) movimenti.push({ data: ds, articolo_id: ids.articoli.get(art.codice), magazzino_id: 2, causale: "CARICO_PRODUZIONE", quantita: j.buoni, riferimento: j.o.numero });
        }
      });
    }
  }
  // controlli qualita' sugli ODP chiusi oggi
  for (const o of odpState) if (o.chiusura === ds && !o.controllato) {
    o.controllato = true;
    const r = rnd();
    controlli.push({
      odp_id: o.id, data: ds, dipendente_id: ids.dip.get(chance(0.5) ? "M1035" : "M1036"), pezzi_controllati: Math.max(5, Math.round(o.quantita * 0.05)),
      esito: r < 0.9 ? "CONFORME" : r < 0.97 ? "CONFORME_CON_RISERVA" : "NON_CONFORME",
      note: r < 0.9 ? null : r < 0.97 ? "Lievi segni estetici, accettato" : "Quote fuori tolleranza, avviata NC",
    });
  }
  // timbrature
  for (const p of dipendenti) {
    const key = `${p.matricola}|${ds}`;
    if (assenze.has(key)) { timbr.push({ dipendente_id: ids.dip.get(p.matricola), data: ds, turno_id: null, tipo: assenze.get(key), entrata: null, uscita: null, ore_ordinarie: 0, ore_straordinario: 0 }); continue; }
    let turno = p.turno === "J" ? null : p.turno;
    if (p.turno === "J") for (const t of ["M", "P", "N"]) if (presentiOggi.has(`${p.matricola}|${t}`)) turno = t;
    if (!turno) turno = "M";
    const t = TURNO[turno];
    if (ds === ymd(TODAY) && t.startMin + 480 > NOW_MIN) continue;
    const straord = chance(0.07) ? randInt(1, 2) : 0;
    timbr.push({
      dipendente_id: ids.dip.get(p.matricola), data: ds, turno_id: ids.turni.get(turno), tipo: "PRESENZA",
      entrata: stamp(d, t.startMin - randInt(2, 12)), uscita: stamp(d, t.startMin + 480 + straord * 60 + randInt(0, 10)),
      ore_ordinarie: 8, ore_straordinario: straord,
    });
  }
}

// ---------- scrittura ----------
insertAll("ordini_cliente", ordiniCliente.map((oc) => {
  const mie = odpState.filter((o) => o.oc.id === oc.id);
  const stato = mie.every((o) => o.stato === "CHIUSO") ? "EVASO" : mie.some((o) => o.stato !== "PIANIFICATO") ? "IN_CORSO" : "CONFERMATO";
  return { id: oc.id, numero: oc.numero, cliente_id: oc.cliente_id, data_ordine: oc.data_ordine, data_consegna_richiesta: ymd(oc.consegna), stato };
}));
insertAll("righe_ordine_cliente", righeOC.map((r) => ({ id: r.id, ordine_id: r.ordine_id, riga: r.riga, articolo_id: ids.articoli.get(r.articolo.codice), quantita: r.quantita, prezzo_unitario: r.prezzo_unitario })));
insertAll("ordini_produzione", odpState.map((o) => ({
  id: o.id, numero: o.numero, articolo_id: ids.articoli.get(o.articolo.codice), riga_ordine_cliente_id: o.riga.id, quantita: o.quantita,
  data_rilascio: ymd(o.rilascio), data_consegna_prevista: ymd(o.consegna), data_chiusura: o.chiusura, stato: o.stato,
})));
insertAll("dichiarazioni_produzione", dich);
insertAll("dettaglio_scarti", dettScarti);
insertAll("fermi_macchina", fermi);
insertAll("timbrature", timbr);
insertAll("controlli_qualita", controlli);

// ordini di acquisto + carichi: inventario iniziale e riordini settimanali
const oa = []; const righeOA = [];
const mps = articoli.filter((a) => a.tipo === "MP");
// riordini settimanali dimensionati sul consumo medio
const consumoSett = {};
for (const mv of movimenti) if (mv.causale === "SCARICO_PRODUZIONE") consumoSett[mv.articolo_id] = (consumoSett[mv.articolo_id] ?? 0) - mv.quantita / (GIORNI_STORICO / 7);
let oaNum = 1;
for (let d = START; d <= addDays(TODAY, 7); d = addDays(d, 7)) {
  for (const f of fornitori.filter((x) => mps.some((a) => a.fornitore === x.codice))) {
    if (!chance(0.8)) continue;
    const consegna = addWorkdays(d, randInt(3, 8));
    const o = { id: oa.length + 1, numero: `OA-${d.getUTCFullYear()}-${String(oaNum++).padStart(4, "0")}`, fornitore_id: ids.fornitori.get(f.codice), data_ordine: ymd(d), data_consegna_prevista: ymd(consegna), stato: consegna <= TODAY ? "RICEVUTO" : "CONFERMATO" };
    oa.push(o);
    mps.filter((a) => a.fornitore === f.codice).forEach((a, k) => {
      const base = consumoSett[ids.articoli.get(a.codice)] ?? 100;
      const q = Math.max(100, Math.round((base * rand(1.0, 1.5)) / 100) * 100);
      righeOA.push({ ordine_id: o.id, riga: (k + 1) * 10, articolo_id: ids.articoli.get(a.codice), quantita: q, prezzo_unitario: +(a.costo * rand(0.95, 1.05)).toFixed(3) });
      if (o.stato === "RICEVUTO") movimenti.push({ data: ymd(consegna), articolo_id: ids.articoli.get(a.codice), magazzino_id: 1, causale: "CARICO_ACQUISTO", quantita: q, riferimento: o.numero });
    });
  }
}
// spedizioni ai clienti degli ODP chiusi
for (const o of odpState) if (o.chiusura && o.articolo.tipo === "PF") movimenti.push({ data: o.chiusura, articolo_id: ids.articoli.get(o.articolo.codice), magazzino_id: 2, causale: "SCARICO_VENDITA", quantita: -o.quantita, riferimento: o.oc.numero });
insertAll("ordini_acquisto", oa);
insertAll("righe_ordine_acquisto", righeOA);
movimenti.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
// inventario iniziale: quanto basta perche' la giacenza non vada mai sotto zero, piu' una scorta
const saldo = {}; const minimo = {};
for (const mv of movimenti) {
  const k = `${mv.articolo_id}|${mv.magazzino_id}`;
  saldo[k] = (saldo[k] ?? 0) + mv.quantita; minimo[k] = Math.min(minimo[k] ?? 0, saldo[k]);
}
for (const a of articoli) {
  const mag = a.tipo === "MP" ? 1 : 2;
  const k = `${ids.articoli.get(a.codice)}|${mag}`;
  const scorta = a.um === "KG" ? randInt(5, 20) * 100 : randInt(1, 6) * 50;
  movimenti.unshift({ data: ymd(addDays(START, -1)), articolo_id: ids.articoli.get(a.codice), magazzino_id: mag, causale: "INVENTARIO_INIZIALE", quantita: Math.ceil(-(minimo[k] ?? 0)) + scorta, riferimento: "INV" });
}
insertAll("movimenti_magazzino", movimenti);
db.exec(`INSERT INTO giacenze (articolo_id, magazzino_id, quantita, aggiornato_il)
         SELECT articolo_id, magazzino_id, ROUND(SUM(quantita), 2), datetime('now','localtime') FROM movimenti_magazzino GROUP BY articolo_id, magazzino_id`);

const counts = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all()
  .map(({ name }) => `${name.padEnd(28)} ${db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n}`);
console.log(`ERP creato in ${ERP_PATH}\nPeriodo: ${ymd(START)} -> ${ymd(TODAY)}  (fattore quantita' ${fattore.toFixed(2)})\n` + counts.join("\n"));
db.close();
