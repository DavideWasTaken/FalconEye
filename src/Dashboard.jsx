import { useState } from "react";
import { Bars, Lines, DataTable } from "./Charts.jsx";
import { fmtNum, fmtDayLong } from "./format.js";

function Delta({ cur, prev, upIsGood, unit = "%", digits = 1, absolute = false }) {
  if (cur == null || prev == null || prev === 0) return null;
  const diff = absolute ? cur - prev : ((cur - prev) / prev) * 100;
  if (Math.abs(diff) < 0.05) return <span className="delta">= stabile <span className="vs">vs 7 gg prima</span></span>;
  const up = diff > 0;
  const good = up === upIsGood;
  return (
    <span className={`delta ${good ? "good" : "bad"}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d={up ? "M5 1 L9 7 L1 7 Z" : "M5 9 L9 3 L1 3 Z"} fill="currentColor" />
      </svg>
      {up ? "+" : "−"}{fmtNum(Math.abs(diff), digits)}{absolute ? ` ${unit}` : "%"}
      <span className="vs">vs 7 gg prima</span>
    </span>
  );
}

function Kpi({ label, value, suffix, children }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}{suffix && <small>{suffix}</small>}</div>
      {children}
    </div>
  );
}

function ChartCard({ title, sub, wide, table, children }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className={`card ${wide ? "wide" : ""}`}>
      <div className="card-head">
        <h2>{title}</h2>
        {sub && <span className="sub">{sub}</span>}
        <span className="spacer" />
        <button className="linkbtn" onClick={() => setAsTable((v) => !v)}>{asTable ? "Grafico" : "Tabella"}</button>
      </div>
      {asTable ? table : children}
    </div>
  );
}

export default function Dashboard({ data, loading }) {
  if (!data) return <div className="card">Caricamento dati…</div>;
  const { corrente: c, precedente: p, ordini } = data.kpi;
  return (
    <div className={`col ${loading ? "dim" : ""}`}>
      <div className="kpis">
        <Kpi label="Prodotti finiti · 7 gg" value={fmtNum(c.prodotti_finiti)} suffix=" pz">
          <Delta cur={c.prodotti_finiti} prev={p.prodotti_finiti} upIsGood />
        </Kpi>
        <Kpi label="OEE medio" value={fmtNum(c.oee_pct, 1)} suffix="%">
          <Delta cur={c.oee_pct} prev={p.oee_pct} upIsGood absolute unit="pt" />
        </Kpi>
        <Kpi label="Tasso di scarto" value={fmtNum(c.scarto_pct, 2)} suffix="%">
          <Delta cur={c.scarto_pct} prev={p.scarto_pct} upIsGood={false} absolute unit="pt" digits={2} />
        </Kpi>
        <Kpi label="Ore di fermo" value={fmtNum(c.ore_fermo_guasti, 1)} suffix=" h">
          <Delta cur={c.ore_fermo_guasti} prev={p.ore_fermo_guasti} upIsGood={false} />
        </Kpi>
        <Kpi label="Puntualita' · 30 gg" value={fmtNum(ordini.puntualita_30gg_pct, 1)} suffix="%">
          <span className="delta">{ordini.aperti} ODP aperti · {ordini.aperti_in_ritardo} in ritardo</span>
        </Kpi>
      </div>

      <div className="charts">
        <ChartCard wide title="Prodotti finiti al giorno" sub={`ultimi 30 giorni · dati fino a ${fmtDayLong(data.ref)}`}
          table={<DataTable columns={["data", "prodotti_finiti", "oee_pct"]} rows={data.giornaliero} />}>
          <Bars data={data.giornaliero} x="data" y="prodotti_finiti" height={210} unit=" pz" valueFmt={(v) => fmtNum(v)} />
        </ChartCard>
        <ChartCard title="OEE per macchina" sub="ultimi 30 giorni, %"
          table={<DataTable columns={["macchina", "oee_pct"]} rows={data.oeeMacchine} />}>
          <Bars data={data.oeeMacchine} x="macchina" y="oee_pct" horizontal unit="%" domain={[0, 100]} />
        </ChartCard>
        <ChartCard title="Fermi non pianificati" sub="ore per categoria, 30 giorni"
          table={<DataTable columns={["categoria", "ore"]} rows={data.fermiCategorie} />}>
          <Bars data={data.fermiCategorie} x="categoria" y="ore" horizontal unit=" h" />
        </ChartCard>
        <ChartCard wide title="Andamento OEE" sub="media pesata di stabilimento, %"
          table={<DataTable columns={["data", "oee_pct"]} rows={data.giornaliero} />}>
          <Lines data={data.giornaliero} x="data" y="oee_pct" height={180} unit="%" />
        </ChartCard>
        {data.ritardi.length > 0 && (
          <div className="card wide">
            <div className="card-head"><h2>Ordini di produzione aperti in ritardo</h2></div>
            <DataTable
              columns={["numero_odp", "cliente", "articolo_descrizione", "data_consegna_prevista", "giorni_ritardo", "percentuale_completamento"]}
              rows={data.ritardi}
              render={{ giorni_ritardo: (v) => <span className="late">{v} gg</span>, percentuale_completamento: (v) => `${fmtNum(v, 1)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
