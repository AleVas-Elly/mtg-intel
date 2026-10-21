// Price history: CardTrader's cheapest fitting copy per check and Cardmarket's trend, one euro
// axis, crosshair with both values. Hand-drawn SVG (no chart library to download).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { day, eur, time } from "../format";

export interface Point { t: number; v: number; source?: string }

const RANGES = [
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "1M", days: 30 },
  { id: "90d", label: "3M", days: 92 },
  { id: "all", label: "All", days: 0 },
] as const;

const H = 190;
const PAD = { l: 4, r: 46, t: 10, b: 22 };

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || hi || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

export function PriceChart({ ct, cm, finishLabel }: { ct: Point[]; cm: Point[]; finishLabel: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("90d");
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const hasData = ct.length + cm.length > 0;
  useEffect(() => {
    if (!box.current) return;
    setWidth(Math.max(240, box.current.clientWidth));
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [hasData]);

  const view = useMemo(() => {
    const now = Date.now();
    const days = RANGES.find((r) => r.id === range)!.days;
    const from = days ? now - days * 864e5 : Math.min(...[...ct, ...cm].map((p) => p.t), now - 864e5);
    const a = ct.filter((p) => p.t >= from);
    const b = cm.filter((p) => p.t >= from);
    const values = [...a, ...b].map((p) => p.v);
    if (!values.length) return null;
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const padV = (hi - lo) * 0.12 || hi * 0.1 || 1;
    lo = Math.max(0, lo - padV);
    hi += padV;
    const ticks = niceTicks(lo, hi);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const x = (t: number) => PAD.l + ((t - from) / (now - from)) * (width - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    return { from, now, a, b, ticks, x, y };
  }, [ct, cm, range, width]);

  if (!view) {
    return (
      <div class="chart">
        <div class="chart-empty">No price history yet for this version.</div>
      </div>
    );
  }
  const { a, b, ticks, x, y, from, now } = view;
  // CardTrader is a step line (the price holds until the next check); gaps over 3 h break it.
  const ctPath = a.map((p, i) => {
    const prev = a[i - 1];
    if (!prev || p.t - prev.t > 3 * 36e5) return `M${x(p.t)},${y(p.v)}`;
    return `H${x(p.t)}V${y(p.v)}`;
  }).join("");
  const cmPath = b.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join("");
  const area = (pts: Point[]) => pts.length > 1 ? `M${x(pts[0].t)},${H - PAD.b}` + pts.map((p) => `L${x(p.t)},${y(p.v)}`).join("") + `L${x(pts[pts.length - 1].t)},${H - PAD.b}Z` : "";
  const switchAt = b.findIndex((p, i) => i > 0 && p.source !== b[i - 1].source);
  const near = (pts: Point[], t: number) => {
    let best: Point | null = null;
    for (const p of pts) if (p.t <= t + 864e5 / 2 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    return best;
  };
  const days = (now - from) / 864e5;
  const xTicks = [0, 0.33, 0.66, 1].map((f) => from + f * (now - from));

  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = from + ((px - PAD.l) / (width - PAD.l - PAD.r)) * (now - from);
    setHover(Math.min(now, Math.max(from, t)));
  };
  const hc = hover != null ? near(a, hover) : null;
  const hm = hover != null ? near(b, hover) : null;
  const ht = hover != null ? (hc && hm ? (Math.abs(hc.t - hover) < Math.abs(hm.t - hover) ? hc.t : hm.t) : (hc ?? hm)?.t ?? hover) : null;

  return (
    <div class="chart">
      <div class="chart-top">
        <div class="legend">
          <span><i />CardTrader</span>
          <span><i class="cm" />Cardmarket {finishLabel}</span>
        </div>
        <div class="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button type="button" aria-pressed={r.id === range} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
      </div>
      <div ref={box} style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Price history: CardTrader ${a.length} points, Cardmarket ${b.length} points`}
        >
          {ticks.map((v) => (
            <g>
              <line class="grid" x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} />
              <text class="axis" x={width - PAD.r + 8} y={y(v) + 4}>€{Number.isInteger(v) ? v : v.toFixed(2)}</text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text class="axis" x={x(t)} y={H - 4} text-anchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>
              {days <= 2 ? time(new Date(t).toISOString()) : day(new Date(t).toISOString())}
            </text>
          ))}
          {switchAt > 0 && <line class="source-mark" x1={x(b[switchAt].t)} x2={x(b[switchAt].t)} y1={PAD.t} y2={H - PAD.b} />}
          <path class="a-cm" d={area(b)} />
          <path class="l-cm" d={cmPath} fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <path class="l-ct" d={ctPath} fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          {b.length > 0 && <circle class="dot-cm" cx={x(b[b.length - 1].t)} cy={y(b[b.length - 1].v)} r="4" />}
          {a.length > 0 && <circle class="dot-ct" cx={x(a[a.length - 1].t)} cy={y(a[a.length - 1].v)} r="4" />}
          {ht != null && <line class="hair" x1={x(ht)} x2={x(ht)} y1={PAD.t} y2={H - PAD.b} />}
          {ht != null && hm && <circle class="dot-cm" cx={x(hm.t)} cy={y(hm.v)} r="4" />}
          {ht != null && hc && <circle class="dot-ct" cx={x(hc.t)} cy={y(hc.v)} r="4" />}
        </svg>
        {ht != null && (hc || hm) && (
          <div class="tip" style={{ left: `${Math.min(Math.max(x(ht), 80), width - 80)}px`, top: "-6px" }}>
            <div style={{ color: "var(--ink-2)" }}>{day(new Date(ht).toISOString())}{hc && days <= 31 ? `, ${time(new Date(hc.t).toISOString())}` : ""}</div>
            {hc && <div class="t-row"><i /><b>{eur(hc.v)}</b><span>CardTrader</span></div>}
            {hm && <div class="t-row"><i class="cm" /><b>{eur(hm.v)}</b><span>Cardmarket{hm.source === "mtgjson" ? " (MTGJSON)" : ""}</span></div>}
          </div>
        )}
      </div>
      {switchAt > 0 && (
        <p class="hint">Before {day(new Date(b[switchAt].t).toISOString())} the Cardmarket line comes from MTGJSON; after it, from Cardmarket's own daily price guide.</p>
      )}
    </div>
  );
}
