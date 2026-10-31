// 手写 SVG 图表的公共部分：容器与补间（chart）、坐标刻度、tooltip，以及管理页的预测误差曲线。
// 看板上的余量曲线与用电柱状图在 history.js。
// 不依赖任何第三方库；所有文字通过 textContent 写入。
import { HOUR, DAY, hourOfDay } from "./model.js";

const NS = "http://www.w3.org/2000/svg";
const TZ = 8 * HOUR;
const WD = "日一二三四五六";
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
export function text(parent, x, y, str, attrs = {}) {
  const t = el("text", { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}
const pad2 = (n) => String(n).padStart(2, "0");
export function fmtDate(t, withTime = true) {
  const d = new Date((t + TZ) * 1000);
  const base = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${WD[d.getUTCDay()]}`;
  return withTime ? `${base} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : base;
}
export const fmtMD = (t) => { const d = new Date((t + TZ) * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export const fmtHM = (t) => { const d = new Date((t + TZ) * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
export const fmtK = (v, d = 2) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));

export function niceTicks(lo, hi, n = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step) * step; v <= end + step * 1e-6; v += step) out.push(+v.toFixed(6));
  return { ticks: out, lo: out[0], hi: out[out.length - 1] };
}

export function timeTicks(a, b, width) {
  const steps = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const max = Math.max(2, Math.floor(width / 50));
  const step = steps.find((s) => (b - a) / s <= max) || 30 * DAY;
  const out = [];
  const first = Math.ceil((a + TZ) / step) * step - TZ;
  for (let t = first; t <= b; t += step) out.push(t);
  const fmt = (t) => (step >= DAY || hourOfDay(t) === 0 ? fmtMD(t) : fmtHM(t));
  return out.map((t) => ({ t, label: fmt(t) }));
}

// ---------- 图表容器 + 补间 ----------
export const ease = (k) => 1 - Math.pow(1 - k, 3);
export const lerp = (a, b, k) => a + (b - a) * k;
const rgb = (c) => { c = c.trim(); if (c[0] === "#") { if (c.length === 4) c = "#" + [...c.slice(1)].map((x) => x + x).join(""); return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); } return c.match(/\d+/g).slice(0, 3).map(Number); };
const mix = (a, b, k) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((v, i) => Math.round(lerp(v, y[i], k))).join(",")})`; };
const DUR = 420;
// 柱子配色取自 iOS 电池图：浅色=全天（平），深灰=自上而下由深变浅（略偏冷），选中=黑。每项是 [顶部色, 底部色]
export const C_LIGHT = ["#e2e2e4", "#e2e2e4"], C_GRAY = ["#b2b1b6", "#cdccd1"], C_INK = ["#111", "#111"];
let gid = 0;

/**
 * 可重画、带补间的图表容器。draw(svg, W, tip, api) 里：
 *   api.bar(parent, key, {x0, bw, base, top, fill, r, op, delay})  画一根柱子（fill 取上面的 C_*）
 *   api.tween(fn)                                                  注册其它动画，fn(k) 的 k 从 0 到 1
 * 每次重画后自动播放：同一个 key 的柱子从旧高度/颜色变形到新的，新出现的从基线长出来（按 delay 错峰）。
 * 宽度变化（旋转屏幕等）时不播放；api.prev.clear() 可强制「全部重新长出来」。
 */
export function chart(host, H, draw) {
  host.classList.add("chart");
  host.replaceChildren();
  const svg = el("svg", { height: H, role: "img" }, host);
  const tip = document.createElement("div");
  tip.className = "tip";
  host.appendChild(tip);
  let W = 0, cur = [], tw = [], skip = false, defs = null;
  const api = { svg, tip, host, prev: new Map(), state: null, raf: 0, get W() { return W; } };
  const shape = (s, top, fill) => {
    const h = Math.max(0, s.base - top), r = Math.min(s.r, s.bw / 2, h), x0 = s.x0, x1 = s.x0 + s.bw;
    s.el.setAttribute("d", `M${x0},${s.base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${s.base}Z`);
    if (s.stops) { s.stops[0].setAttribute("stop-color", fill[0]); s.stops[1].setAttribute("stop-color", fill[1]); }
  };
  api.bar = (parent, key, s) => {
    s = { r: 5, delay: 0, op: 1, ...s, key };
    s.stops = null;
    let fill = "none";
    if (!s.ghost) {
      const id = `bg${++gid}`;
      const lg = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      s.stops = [el("stop", { offset: 0 }, lg), el("stop", { offset: 1 }, lg)];
      fill = `url(#${id})`;
    }
    // ghost：预测用的空心虚线柱，和实心柱一眼分得开
    s.el = el("path", { opacity: s.op, fill, ...(s.ghost ? { stroke: css("--muted"), "stroke-width": 1, "stroke-dasharray": "3 3" } : {}) }, parent);
    cur.push(s);
    return s.el;
  };
  api.tween = (fn) => tw.push(fn);
  const play = () => {
    cancelAnimationFrame(api.raf);
    const prev = api.prev, next = new Map(cur.map((s) => [s.key, { top: s.top, fill: s.fill }]));
    api.prev = next;
    const dur = reduced() || skip ? 0 : DUR;
    skip = false;
    const maxDelay = Math.max(0, ...cur.map((s) => s.delay));
    const frame = (t) => {
      for (const s of cur) {
        const p0 = prev.get(s.key);
        const k = dur ? Math.min(1, Math.max(0, (t - (p0 ? 0 : s.delay)) / dur)) : 1, e = ease(k);
        const c = p0 && p0.fill && s.fill ? [mix(p0.fill[0], s.fill[0], e), mix(p0.fill[1], s.fill[1], e)] : s.fill;
        shape(s, lerp(p0 ? p0.top : s.base, s.top, e), c);
      }
      const k = dur ? Math.min(1, t / dur) : 1;
      for (const fn of tw) fn(k);
    };
    frame(0);
    if (!dur) return;
    const t0 = performance.now();
    const loop = (now) => { const t = now - t0; frame(t); if (t < dur + maxDelay) api.raf = requestAnimationFrame(loop); else frame(dur + maxDelay); };
    api.raf = requestAnimationFrame(loop);
  };
  api.redraw = () => {
    const nw = host.clientWidth;
    if (!nw) return;
    if (W && nw !== W) skip = true;
    W = nw;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    defs = el("defs", {}, svg);
    cur = []; tw = [];
    draw(svg, W, tip, api);
    play();
  };
  if (host._ro) host._ro.disconnect();
  host._ro = new ResizeObserver(() => { if (host.clientWidth !== W) api.redraw(); });
  host._ro.observe(host);
  api.redraw();
  return api;
}

/** 只要 tooltip + 尺寸监听的简单版（管理页的误差图用） */
export function frame(host, height, draw) {
  const c = chart(host, height, (svg, W, tip) => draw(svg, W, height, tip));
  return { svg: c.svg, tip: c.tip };
}

export function showTip(host, tip, x, y, title, rows) {
  tip.replaceChildren();
  const t = document.createElement("div");
  t.className = "t"; t.textContent = title; tip.appendChild(t);
  for (const r of rows) {
    const d = document.createElement("div"); d.className = "r";
    if (r.color) { const i = document.createElement("i"); i.style.background = r.color; if (r.dash) i.style.background = `repeating-linear-gradient(90deg, ${r.color} 0 3px, transparent 3px 5px)`; d.appendChild(i); }
    const b = document.createElement("b"); b.textContent = r.value; d.appendChild(b);
    if (r.label) { const s = document.createElement("span"); s.textContent = r.label; d.appendChild(s); }
    tip.appendChild(d);
  }
  tip.classList.add("on");
  const W = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > W) left = x - tw - 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, y - th / 2)}px`;
}
export const hideTip = (tip) => tip.classList.remove("on");
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * 全校预测误差随时间变化：rows [{day, h, n, mape}]，按跨度画线（6h 实线、24h 虚线），y 为平均绝对误差 %。
 */
export function accuracyChart(host, rows) {
  const H = 170, M = { l: 40, r: 12, t: 12, b: 26 };
  const series = [6, 24].map((h, i) => ({ h, name: `${h} 小时`, color: css(i ? "--rest" : "--work"),
    // 门槛放到 n>=3（原来 10）：部署初期每寝室每天只产出几张快照，n>=10 会让曲线空好几天。
    // 样本少的时候曲线会跳，所以 tooltip 里带上「N 次」让人自己判断。
    pts: rows.filter((r) => r.h === h && r.n >= 3).map((r) => [r.day, r.mape * 100, r.n]) }));
  const all = series.flatMap((s) => s.pts);
  if (!all.length) {
    host.classList.remove("chart");
    host.innerHTML = `<div class="chart-empty" style="height:100px">积累评估数据后显示</div>`;
    return;
  }
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0])) || x0 + DAY;
  const y = niceTicks(0, Math.max(...all.map((p) => p[1]), 5), 3);
  frame(host, H, (svg, W, _h, tip) => {
    const X = (t) => M.l + ((t - x0) / Math.max(DAY, x1 - x0)) * (W - M.l - M.r);
    const Y = (v) => H - M.b - (v / y.hi) * (H - M.t - M.b);
    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (const v of y.ticks) { el("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v) }, g); text(ax, M.l - 8, Y(v) + 4, `${v}%`, { "text-anchor": "end" }); }
    for (const { t, label } of timeTicks(x0, x1, W - M.l - M.r)) text(ax, X(t), H - 6, label, { "text-anchor": "middle" });
    for (const s of series) {
      if (s.pts.length > 1) el("path", { class: s.h === 24 ? "line dash" : "line", stroke: s.color, d: s.pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("") }, svg);
      for (const [t, v] of s.pts) el("circle", { class: "dot", cx: X(t), cy: Y(v), r: 4, fill: s.color }, svg);
    }
    const days = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    const hit = el("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const t = x0 + ((ev.clientX - r.left - M.l) / (W - M.l - M.r)) * Math.max(DAY, x1 - x0);
      const d = days.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
      showTip(host, tip, X(d), M.t + 20, fmtDate(d, false), series.map((s) => {
        const p = s.pts.find((q) => q[0] === d);
        return { color: s.color, dash: s.h === 24, value: p ? `±${p[1].toFixed(1)}%` : "—", label: p ? `${s.name} · ${Math.round(p[2])} 次` : s.name };
      }));
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => hideTip(tip));
  });
}
