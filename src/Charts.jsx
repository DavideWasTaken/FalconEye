import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { fmtCompact, fmtNum, fmtDayShort, fmtDayLong, isDate, humanize, fmtCell } from "./format.js";

// slot categoriali in ordine fisso (mai ciclati)
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

const tick = { fill: "var(--text-muted)", fontSize: 11 };
const axisLine = { stroke: "var(--axis)" };

function ChartTooltip({ active, payload, label, valueFmt = (v) => fmtNum(v, 1), unit = "" }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <div className="tt-title">{isDate(label) ? fmtDayLong(label) : label}</div>
      {payload.map((p) => (
        <div className="tt-row" key={p.dataKey}>
          <span className="key" style={{ background: p.color || p.fill }} />
          <span>{humanize(String(p.name ?? p.dataKey))}</span>
          <b>{valueFmt(p.value)}{unit}</b>
        </div>
      ))}
    </div>
  );
}

export function Legend({ keys }) {
  if (keys.length < 2) return null;
  return (
    <div className="legend">
      {keys.map((k, i) => (
        <span key={k}><i className="key" style={{ background: SERIES[i] }} />{humanize(k)}</span>
      ))}
    </div>
  );
}

// Colonne (categorie sull'asse X) o barre orizzontali (categorie sull'asse Y)
export function Bars({ data, x, y, horizontal = false, height, unit = "", valueFmt, domain }) {
  const keys = Array.isArray(y) ? y : [y];
  const vf = valueFmt ?? ((v) => fmtNum(v, 1));
  if (horizontal) {
    const longest = Math.max(...data.map((d) => String(d[x]).length));
    const h = height ?? Math.max(120, data.length * (keys.length > 1 ? 40 : 28) + 36);
    return (
      <>
        <Legend keys={keys} />
        <ResponsiveContainer width="100%" height={h}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid horizontal={false} stroke="var(--grid)" />
            <XAxis type="number" tick={tick} axisLine={axisLine} tickLine={false} tickFormatter={fmtCompact} domain={domain} />
            <YAxis type="category" dataKey={x} tick={{ ...tick, fill: "var(--text-secondary)" }} axisLine={axisLine} tickLine={false} width={Math.min(170, longest * 7 + 12)} interval={0} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip valueFmt={vf} unit={unit} />} />
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} fill={SERIES[i]} radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </>
    );
  }
  return (
    <>
      <Legend keys={keys} />
      <ResponsiveContainer width="100%" height={height ?? 220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={x} tick={tick} axisLine={axisLine} tickLine={false} tickFormatter={fmtDayShort} minTickGap={12} />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmtCompact} width={44} domain={domain} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip valueFmt={vf} unit={unit} />} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

export function Lines({ data, x, y, height = 220, unit = "", valueFmt, domain }) {
  const keys = Array.isArray(y) ? y : [y];
  const vf = valueFmt ?? ((v) => fmtNum(v, 1));
  return (
    <>
      <Legend keys={keys} />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={x} tick={tick} axisLine={axisLine} tickLine={false} tickFormatter={fmtDayShort} minTickGap={16} />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmtCompact} width={44} domain={domain ?? ["auto", "auto"]} />
          <Tooltip cursor={{ stroke: "var(--axis)" }} content={<ChartTooltip valueFmt={vf} unit={unit} />} />
          {keys.map((k, i) => (
            <Line key={k} dataKey={k} stroke={SERIES[i]} strokeWidth={2} dot={false} isAnimationActive={false}
              activeDot={{ r: 4.5, fill: SERIES[i], stroke: "var(--surface-1)", strokeWidth: 2 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

export function DataTable({ columns, rows, max = 200, render = {} }) {
  const shown = rows.slice(0, max);
  const numeric = new Set(columns.filter((c) => rows.some((r) => typeof r[c] === "number")));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c} className={numeric.has(c) ? "num" : ""}>{humanize(c)}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className={numeric.has(c) ? "num" : ""}>{render[c] ? render[c](r[c], r) : fmtCell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Grafico scelto dall'AI per il risultato di una domanda
export function ResultChart({ grafico, columns, rows }) {
  if (!grafico || grafico.tipo === "nessuno" || rows.length < 2) return null;
  const x = columns.includes(grafico.x) ? grafico.x : columns[0];
  const y = (grafico.y ?? []).filter((c) => columns.includes(c) && c !== x && rows.some((r) => typeof r[c] === "number")).slice(0, 8);
  if (!y.length) return null;
  const data = rows.slice(0, 60);
  const timeSeries = isDate(data[0][x]) || /^\d{4}-\d{2}$/.test(String(data[0][x]));
  if (grafico.tipo === "linee" || (timeSeries && data.length > 12)) {
    return <div className="result-chart"><Lines data={data} x={x} y={y} height={200} /></div>;
  }
  const longLabels = data.some((d) => String(d[x]).length > 9);
  const horizontal = !timeSeries && (longLabels || data.length > 8);
  return <div className="result-chart"><Bars data={data} x={x} y={y} horizontal={horizontal} height={horizontal ? undefined : 200} /></div>;
}
