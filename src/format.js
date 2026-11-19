export const fmtNum = (v, dec = 0) =>
  typeof v === "number" ? v.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: dec }) : v ?? "—";

export const fmtCompact = (v) =>
  typeof v === "number" && Math.abs(v) >= 10000
    ? v.toLocaleString("it-IT", { notation: "compact", maximumFractionDigits: 1 })
    : fmtNum(v, 1);

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v) => typeof v === "string" && isoDate.test(v);
export const fmtDayShort = (v) => (isDate(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}` : v);
export const fmtDayLong = (v) =>
  isDate(v)
    ? new Date(`${v}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })
    : v;

export const fmtCell = (v) => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return fmtNum(v, 2);
  if (isDate(v)) return fmtDayShort(v) + "/" + v.slice(0, 4);
  return String(v);
};

export const humanize = (col) => col.replace(/_pct$/, " %").replace(/_eur$/, " €").replace(/_/g, " ");
