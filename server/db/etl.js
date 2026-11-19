// ETL: legge l'ERP (data/erp.db) e ricostruisce data/staging.db con 6 tabelle di staging
// denormalizzate sulla produzione. La dashboard e l'AI interrogano SOLO lo staging,
// cosi' l'ERP (gia' sotto carico) non riceve nessuna query analitica.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, "../../data");
const ERP_PATH = path.join(DATA_DIR, "erp.db");
const STG_PATH = path.join(DATA_DIR, "staging.db");
const TMP_PATH = STG_PATH + ".tmp";

if (!fs.existsSync(ERP_PATH)) {
  console.error("data/erp.db non trovato: esegui prima `npm run db:erp`");
  process.exit(1);
}

// Si costruisce in un file temporaneo e poi si sostituisce, cosi' il server non legge mai uno staging a meta'.
if (fs.existsSync(TMP_PATH)) fs.rmSync(TMP_PATH);
const db = new Database(TMP_PATH);
db.prepare("ATTACH DATABASE ? AS erp").run(ERP_PATH);

const TURNO = `CASE t.codice WHEN 'M' THEN 'Mattino' WHEN 'P' THEN 'Pomeriggio' ELSE 'Notte' END`;
const GIORNO = (col) => `CASE strftime('%w', ${col}) WHEN '0' THEN 'domenica' WHEN '1' THEN 'lunedi' WHEN '2' THEN 'martedi' WHEN '3' THEN 'mercoledi' WHEN '4' THEN 'giovedi' WHEN '5' THEN 'venerdi' ELSE 'sabato' END`;

const steps = [
  // 1. Avanzamento produzione: una riga per dichiarazione di produzione
  `CREATE TABLE stg_produzione AS
   SELECT d.id                                  AS id_dichiarazione,
          d.data_turno                          AS data,
          strftime('%Y-%m', d.data_turno)       AS anno_mese,
          ${GIORNO("d.data_turno")}             AS giorno_settimana,
          ${TURNO}                              AS turno,
          dp.matricola                          AS matricola,
          dp.nome || ' ' || dp.cognome          AS operatore,
          dp.nome                               AS operatore_nome,
          dp.cognome                            AS operatore_cognome,
          r.descrizione                         AS reparto,
          cl.codice                             AS centro_lavoro,
          m.codice                              AS macchina,
          m.descrizione                         AS macchina_descrizione,
          o.numero                              AS numero_odp,
          a.codice                              AS articolo_codice,
          a.descrizione                         AS articolo_descrizione,
          d.fase                                AS fase,
          ci.descrizione_fase                   AS fase_descrizione,
          CASE WHEN d.fase = (SELECT MAX(fase) FROM erp.cicli_lavoro x WHERE x.articolo_id = o.articolo_id) THEN 1 ELSE 0 END AS fase_finale,
          c.ragione_sociale                     AS cliente,
          d.quantita_buona                      AS pezzi_buoni,
          d.quantita_scarto                     AS pezzi_scarto,
          d.quantita_buona + d.quantita_scarto  AS pezzi_totali,
          d.minuti_lavorazione                  AS minuti_lavorazione,
          ci.tempo_ciclo_sec                    AS tempo_ciclo_std_sec,
          d.inizio                              AS ora_inizio,
          d.fine                                AS ora_fine
   FROM erp.dichiarazioni_produzione d
   JOIN erp.dipendenti dp           ON dp.id = d.dipendente_id
   JOIN erp.macchine m              ON m.id = d.macchina_id
   JOIN erp.centri_lavoro cl        ON cl.id = m.centro_lavoro_id
   JOIN erp.reparti r               ON r.id = cl.reparto_id
   JOIN erp.turni t                 ON t.id = d.turno_id
   JOIN erp.ordini_produzione o     ON o.id = d.odp_id
   JOIN erp.articoli a              ON a.id = o.articolo_id
   JOIN erp.cicli_lavoro ci         ON ci.articolo_id = o.articolo_id AND ci.fase = d.fase
   LEFT JOIN erp.righe_ordine_cliente roc ON roc.id = o.riga_ordine_cliente_id
   LEFT JOIN erp.ordini_cliente oc  ON oc.id = roc.ordine_id
   LEFT JOIN erp.clienti c          ON c.id = oc.cliente_id`,

  // 2. Ordini di produzione con avanzamento e ritardo
  `CREATE TABLE stg_ordini_produzione AS
   WITH prod AS (
     SELECT d.odp_id,
            SUM(d.quantita_scarto) AS scarti,
            SUM(CASE WHEN d.fase = (SELECT MAX(fase) FROM erp.cicli_lavoro x JOIN erp.ordini_produzione oo ON oo.articolo_id = x.articolo_id WHERE oo.id = d.odp_id)
                     THEN d.quantita_buona ELSE 0 END) AS prodotti,
            MIN(d.data_turno) AS inizio_lavorazione
     FROM erp.dichiarazioni_produzione d GROUP BY d.odp_id)
   SELECT o.numero                         AS numero_odp,
          a.codice                         AS articolo_codice,
          a.descrizione                    AS articolo_descrizione,
          CASE a.tipo WHEN 'PF' THEN 'Prodotto finito' WHEN 'SL' THEN 'Semilavorato' ELSE 'Materia prima' END AS tipo_articolo,
          c.ragione_sociale                AS cliente,
          c.nazione                        AS nazione_cliente,
          oc.numero                        AS ordine_cliente,
          o.quantita                       AS quantita_pianificata,
          COALESCE(p.prodotti, 0)          AS quantita_prodotta,
          COALESCE(p.scarti, 0)            AS pezzi_scartati,
          ROUND(100.0 * MIN(COALESCE(p.prodotti, 0), o.quantita) / o.quantita, 1) AS percentuale_completamento,
          o.stato                          AS stato,
          o.data_rilascio                  AS data_rilascio,
          p.inizio_lavorazione             AS data_inizio_lavorazione,
          o.data_consegna_prevista         AS data_consegna_prevista,
          o.data_chiusura                  AS data_chiusura,
          CAST(MAX(0, CASE WHEN o.data_chiusura IS NOT NULL THEN julianday(o.data_chiusura) - julianday(o.data_consegna_prevista)
                           ELSE julianday(date('now','localtime')) - julianday(o.data_consegna_prevista) END) AS INTEGER) AS giorni_ritardo,
          CASE WHEN (o.data_chiusura IS NOT NULL AND o.data_chiusura > o.data_consegna_prevista)
                 OR (o.data_chiusura IS NULL AND o.data_consegna_prevista < date('now','localtime')) THEN 1 ELSE 0 END AS in_ritardo,
          ROUND(o.quantita * roc.prezzo_unitario, 2) AS valore_ordine_eur
   FROM erp.ordini_produzione o
   JOIN erp.articoli a ON a.id = o.articolo_id
   LEFT JOIN prod p ON p.odp_id = o.id
   LEFT JOIN erp.righe_ordine_cliente roc ON roc.id = o.riga_ordine_cliente_id
   LEFT JOIN erp.ordini_cliente oc ON oc.id = roc.ordine_id
   LEFT JOIN erp.clienti c ON c.id = oc.cliente_id`,

  // 3. Fermi macchina
  `CREATE TABLE stg_fermi_macchina AS
   SELECT f.id                         AS id_fermo,
          f.data_turno                 AS data,
          strftime('%Y-%m', f.data_turno) AS anno_mese,
          ${TURNO}                     AS turno,
          m.codice                     AS macchina,
          m.descrizione                AS macchina_descrizione,
          cl.codice                    AS centro_lavoro,
          r.descrizione                AS reparto,
          cf.codice                    AS causale_codice,
          cf.descrizione               AS causale,
          cf.categoria                 AS categoria,
          cf.pianificato               AS pianificato,
          f.inizio                     AS ora_inizio,
          f.fine                       AS ora_fine,
          f.durata_min                 AS durata_minuti,
          dp.nome || ' ' || dp.cognome AS operatore,
          f.note                       AS note
   FROM erp.fermi_macchina f
   JOIN erp.macchine m       ON m.id = f.macchina_id
   JOIN erp.centri_lavoro cl ON cl.id = m.centro_lavoro_id
   JOIN erp.reparti r        ON r.id = cl.reparto_id
   JOIN erp.turni t          ON t.id = f.turno_id
   JOIN erp.causali_fermo cf ON cf.codice = f.causale_fermo
   LEFT JOIN erp.dipendenti dp ON dp.id = f.dipendente_id`,

  // 4. Scarti per causale
  `CREATE TABLE stg_scarti AS
   SELECT s.id                         AS id_scarto,
          d.data_turno                 AS data,
          strftime('%Y-%m', d.data_turno) AS anno_mese,
          ${TURNO}                     AS turno,
          m.codice                     AS macchina,
          cl.codice                    AS centro_lavoro,
          r.descrizione                AS reparto,
          dp.matricola                 AS matricola,
          dp.nome || ' ' || dp.cognome AS operatore,
          o.numero                     AS numero_odp,
          a.codice                     AS articolo_codice,
          a.descrizione                AS articolo_descrizione,
          d.fase                       AS fase,
          cs.codice                    AS causale_codice,
          cs.descrizione               AS causale,
          cs.categoria                 AS categoria_scarto,
          s.quantita                   AS quantita,
          ROUND(s.quantita * a.costo_standard, 2) AS costo_stimato_eur
   FROM erp.dettaglio_scarti s
   JOIN erp.dichiarazioni_produzione d ON d.id = s.dichiarazione_id
   JOIN erp.causali_scarto cs ON cs.codice = s.causale_scarto
   JOIN erp.macchine m        ON m.id = d.macchina_id
   JOIN erp.centri_lavoro cl  ON cl.id = m.centro_lavoro_id
   JOIN erp.reparti r         ON r.id = cl.reparto_id
   JOIN erp.turni t           ON t.id = d.turno_id
   JOIN erp.dipendenti dp     ON dp.id = d.dipendente_id
   JOIN erp.ordini_produzione o ON o.id = d.odp_id
   JOIN erp.articoli a        ON a.id = o.articolo_id`,

  // 5. Presenze del personale
  `CREATE TABLE stg_presenze AS
   SELECT tb.data                      AS data,
          strftime('%Y-%m', tb.data)   AS anno_mese,
          dp.matricola                 AS matricola,
          dp.nome || ' ' || dp.cognome AS operatore,
          r.descrizione                AS reparto,
          dp.mansione                  AS mansione,
          CASE t.codice WHEN 'M' THEN 'Mattino' WHEN 'P' THEN 'Pomeriggio' WHEN 'N' THEN 'Notte' END AS turno,
          tb.tipo                      AS tipo_giornata,
          tb.entrata                   AS entrata,
          tb.uscita                    AS uscita,
          tb.ore_ordinarie             AS ore_ordinarie,
          tb.ore_straordinario         AS ore_straordinario
   FROM erp.timbrature tb
   JOIN erp.dipendenti dp ON dp.id = tb.dipendente_id
   JOIN erp.reparti r     ON r.id = dp.reparto_id
   LEFT JOIN erp.turni t  ON t.id = tb.turno_id`,

  // 6. KPI giornalieri per macchina (OEE = disponibilita' x performance x qualita')
  `CREATE TABLE stg_kpi_macchina_giorno AS
   WITH turni AS (
     SELECT macchina_id, data_turno, turno_id FROM erp.dichiarazioni_produzione
     UNION SELECT macchina_id, data_turno, turno_id FROM erp.fermi_macchina),
   tg AS (SELECT macchina_id, data_turno, COUNT(*) AS turni FROM turni GROUP BY 1, 2),
   fe AS (SELECT f.macchina_id, f.data_turno,
                 SUM(CASE WHEN c.pianificato = 1 THEN f.durata_min ELSE 0 END) AS pian,
                 SUM(CASE WHEN c.pianificato = 0 THEN f.durata_min ELSE 0 END) AS non_pian
          FROM erp.fermi_macchina f JOIN erp.causali_fermo c ON c.codice = f.causale_fermo GROUP BY 1, 2),
   pr AS (SELECT d.macchina_id, d.data_turno, SUM(d.quantita_buona) AS buoni, SUM(d.quantita_scarto) AS scarto,
                 SUM((d.quantita_buona + d.quantita_scarto) * ci.tempo_ciclo_sec / 60.0) AS teorico
          FROM erp.dichiarazioni_produzione d
          JOIN erp.ordini_produzione o ON o.id = d.odp_id
          JOIN erp.cicli_lavoro ci ON ci.articolo_id = o.articolo_id AND ci.fase = d.fase
          GROUP BY 1, 2),
   base AS (
     SELECT tg.data_turno AS data, m.codice AS macchina, m.descrizione AS macchina_descrizione, cl.codice AS centro_lavoro, r.descrizione AS reparto,
            tg.turni AS turni_lavorati,
            tg.turni * 450 AS tempo_disponibile_min,
            COALESCE(fe.pian, 0) AS fermi_pianificati_min,
            COALESCE(fe.non_pian, 0) AS fermi_non_pianificati_min,
            COALESCE(pr.buoni, 0) AS pezzi_buoni, COALESCE(pr.scarto, 0) AS pezzi_scarto,
            COALESCE(pr.teorico, 0) AS teorico
     FROM tg
     JOIN erp.macchine m ON m.id = tg.macchina_id
     JOIN erp.centri_lavoro cl ON cl.id = m.centro_lavoro_id
     JOIN erp.reparti r ON r.id = cl.reparto_id
     LEFT JOIN fe ON fe.macchina_id = tg.macchina_id AND fe.data_turno = tg.data_turno
     LEFT JOIN pr ON pr.macchina_id = tg.macchina_id AND pr.data_turno = tg.data_turno)
   SELECT data, strftime('%Y-%m', data) AS anno_mese, macchina, macchina_descrizione, centro_lavoro, reparto, turni_lavorati,
          tempo_disponibile_min,
          fermi_pianificati_min,
          tempo_disponibile_min - fermi_pianificati_min AS tempo_pianificato_min,
          fermi_non_pianificati_min,
          tempo_disponibile_min - fermi_pianificati_min - fermi_non_pianificati_min AS tempo_operativo_min,
          pezzi_buoni, pezzi_scarto,
          ROUND(teorico, 1) AS tempo_teorico_min,
          ROUND(1.0 * (tempo_disponibile_min - fermi_pianificati_min - fermi_non_pianificati_min) / NULLIF(tempo_disponibile_min - fermi_pianificati_min, 0), 4) AS disponibilita,
          ROUND(MIN(1.0, teorico / NULLIF(tempo_disponibile_min - fermi_pianificati_min - fermi_non_pianificati_min, 0)), 4) AS performance,
          ROUND(1.0 * pezzi_buoni / NULLIF(pezzi_buoni + pezzi_scarto, 0), 4) AS qualita,
          ROUND(
            (1.0 * (tempo_disponibile_min - fermi_pianificati_min - fermi_non_pianificati_min) / NULLIF(tempo_disponibile_min - fermi_pianificati_min, 0))
            * MIN(1.0, teorico / NULLIF(tempo_disponibile_min - fermi_pianificati_min - fermi_non_pianificati_min, 0))
            * (1.0 * pezzi_buoni / NULLIF(pezzi_buoni + pezzi_scarto, 0)), 4) AS oee
   FROM base`,

  `CREATE INDEX ix_prod_data ON stg_produzione(data)`,
  `CREATE INDEX ix_prod_op ON stg_produzione(operatore)`,
  `CREATE INDEX ix_fermi_data ON stg_fermi_macchina(data)`,
  `CREATE INDEX ix_scarti_data ON stg_scarti(data)`,
  `CREATE INDEX ix_pres_data ON stg_presenze(data)`,
  `CREATE INDEX ix_kpi_data ON stg_kpi_macchina_giorno(data)`,
];

const t0 = Date.now();
db.transaction(() => { for (const s of steps) db.exec(s); })();

const TABLES = ["stg_produzione", "stg_ordini_produzione", "stg_fermi_macchina", "stg_scarti", "stg_presenze", "stg_kpi_macchina_giorno"];
const counts = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
db.exec(`CREATE TABLE _etl_info (eseguito_il TEXT, durata_ms INTEGER, righe TEXT)`);
db.prepare(`INSERT INTO _etl_info VALUES (datetime('now','localtime'), ?, ?)`).run(Date.now() - t0, JSON.stringify(counts));
db.exec("DETACH DATABASE erp");
db.close();

for (const f of [STG_PATH + "-wal", STG_PATH + "-shm"]) if (fs.existsSync(f)) fs.rmSync(f);
fs.renameSync(TMP_PATH, STG_PATH);
console.log(`Staging aggiornato in ${Date.now() - t0} ms -> ${STG_PATH}`);
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n}`);
