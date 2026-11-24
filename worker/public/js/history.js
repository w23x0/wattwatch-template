// 看板上的「余量」「用电」：
//   三张图共用同一个 7 天窗口：第 0 页是「今天前 4 天 + 今天 + 未来 2 天」（今天落在第 5 列），
//   滑动哪一张，另外两张都会跟到同一周；往回翻是整周一页。
//   余量：曲线，纵轴刻度全程固定；今天之后是预测，一直画到停电。
//   用电：参照 iOS「电池」——周竖线图（浅=全天、深=截至此刻、虚线=预测），
//        下接「屏幕使用时间」式的 24 小时竖线（今天剩余小时与未来两天同样是预测）。
// 数据由 app.js 给；往前翻到头时通过 env.loadOlder() 按需再取更早的读数。
import { HOUR, DAY, hourly, dayStart, hourOfDay, expectedAt } from "./model.js";
import { el, text, niceTicks, chart, showTip, hideTip, css, fmtDate, fmtHM, fmtMD, reduced, ease, lerp, C_LIGHT, C_GRAY, C_INK } from "./charts.js";

const WD = "日一二三四五六";
const SPAN = 7 * DAY;
const FUTURE = 2;            // 窗口里给今天之后留 2 天（放预测），今天落在第 5 列：5 天含今天 + 2 天
const PAST = 6 - FUTURE;
const fx = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * hosts: { bal, rng, use, wk, hr }  余量图容器、日期范围文字、用电区块、周图容器、24 小时图容器
 * env:   { now, cal, lag, cutoff, fc, balance, readings, loadOlder(spanDays?) -> {readings, done} }
 */
export function mountHistory(hosts, env) {
  const D = { readings: [], hours: [], recharges: [], byDay: new Map(), first: 0, today: dayStart(env.now), upto: 0 };
  const listeners = [];
  const more = { loading: false, done: false };

  function rebuild(readings) {
    D.readings = readings;
    const { hours, recharges } = hourly(readings, env.lag);
    D.hours = hours; D.recharges = recharges;
    const byDay = new Map();
    for (const h of hours) {
      const d = dayStart(h.t);
      let o = byDay.get(d);
      if (!o) byDay.set(d, (o = { t: d, h: Array(24).fill(null), n: 0 }));
      o.h[hourOfDay(h.t)] = h.kwh; o.n++;
    }
    // 读数是每小时的整点快照，各寝室在 :10~:58 之间被读到，所以「今天已知的用电」不一定到当前钟点——
    // 对比时所有天都只算到同一个小时（今天已有数据的最后一小时），不然会把「今天还缺一小时」误判成用得少
    const td = byDay.get(D.today);
    D.upto = td ? 1 + td.h.reduce((m, v, i) => (v == null ? m : i), -1) : 0;
    for (const o of byDay.values()) {
      o.total = o.h.reduce((a, v) => a + (v || 0), 0);
      o.sofar = o.h.slice(0, D.upto).reduce((a, v) => a + (v || 0), 0);
      o.full = o.n >= 20;
    }
    D.byDay = byDay;
    D.first = byDay.size ? Math.min(...byDay.keys()) : D.today;
  }

  /** 往前再取一段更早的读数；取完/失败后不再重试。返回是否有新数据 */
  async function older(span) {
    if (more.loading || more.done) return false;
    more.loading = true;
    try {
      const r = await env.loadOlder(span);
      more.done = r.done;
      const before = D.readings.length;
      rebuild(r.readings);
      if (D.readings.length === before) return false;
      listeners.forEach((fn) => fn());
      return true;
    } catch { more.done = true; return false; } finally { more.loading = false; }
  }

  rebuild(env.readings);

  const fc = env.fc && env.fc.ready ? env.fc : null;
  const proj = fc && env.balance != null ? projectionOf(env, env.now + 17 * DAY) : [];
  const predAt = (t) => (fc ? expectedAt(fc, t, env.cal) : null);

  // 三张图共用的窗口：P.page = 0 是 [今天-4, 今天+2]，每翻一页整体后移 7 天
  const P = { page: 0, sel: D.today };
  const W = {
    P,
    refDay: (p = P.page) => D.today - p * SPAN,
    days: (p = P.page) => { const r = W.refDay(p); return Array.from({ length: 7 }, (_, i) => r - (PAST - i) * DAY); },
    pageOf: (d) => Math.ceil((D.today - d - PAST * DAY) / SPAN),
    // 窗口的最后一天还挨着最早的数据，就还能再往前翻一页
    canPage: (dir) => (dir > 0 ? W.refDay(P.page + 1) + FUTURE * DAY >= D.first : P.page > 0),
    setPage(p) { P.page = p; P.sel = W.refDay(p); },
    onPageChange() {},
  };

  const bal = balanceView(hosts, env, D, proj, older, listeners, W);
  const usage = usageView(hosts, env, D, older, listeners, W, bal, predAt);
  W.onPageChange = () => usage.redraw();
  // 余量图的最高刻度取「全部历史的最大值」：等入场动画播完，再趁空闲把完整历史一次取回来
  setTimeout(() => older(365), 1700);
}

function projectionOf(env, until) {
  const { fc, cal, cutoff } = env;
  const pts = [[fc.from, env.balance]];
  let r = env.balance;
  for (let h = fc.from; h < until; h += HOUR) {
    const u = expectedAt(fc, h, cal);
    if (u >= r - cutoff) { pts.push([Math.round(h + (HOUR * (r - cutoff)) / u), cutoff]); return pts; }
    r -= u;
    pts.push([h + HOUR, r]);
  }
  return pts;
}

const empty = (host, msg) => {
  host.classList.remove("chart");
  host.innerHTML = `<div class="chart-empty">${msg}</div>`;
  return { redraw() {}, goPage() {} };
};

/** 翻页过渡：整页滑出 → swap() 换内容 → 从另一侧滑回。dir>0：看更早（向右滑），dir<0：往后 */
function slide(wrap, W, dir, swap) {
  const t = reduced() ? 0 : 180;
  wrap.style.transition = `transform ${t}ms ease-out`;
  wrap.style.transform = `translateX(${dir * W}px)`;
  setTimeout(() => {
    swap();
    wrap.style.transition = "none";
    wrap.style.transform = `translateX(${-dir * W * 0.35}px)`;
    requestAnimationFrame(() => { wrap.style.transition = `transform ${t}ms ease-out`; wrap.style.transform = ""; });
  }, t);
}

/**
 * 图表手势：先判断方向，只有横向位移明显大于纵向时才接管；纵向直接放手，把滚动还给页面。
 * 接管后 touchmove 会 preventDefault，手指在拖动中上下漂也不会带着页面一起滚。
 * o: { start?(e), move(dx, dy, e), end({dx, dy, vx, canceled, e}), tap?(e), hover?(e), leave?() }
 */
function gesture(svg, o) {
  let g = null;
  const release = (id) => { try { svg.releasePointerCapture(id); } catch { /* 已经释放 */ } };
  const finish = (e, canceled) => {
    if (!g || e.pointerId !== g.id) return;
    const was = g;
    g = null;
    release(e.pointerId);
    if (!was.moved) { if (!canceled) o.tap?.(e); return; }
    const [t0, x0] = was.s[0], [t1, x1] = was.s[was.s.length - 1];
    const vx = t1 > t0 && performance.now() - t1 < 120 ? (x1 - x0) / (t1 - t0) : 0;
    o.end?.({ dx: was.dx, dy: was.dy, vx, canceled, e });
  };
  svg.addEventListener("pointerdown", (e) => {
    if (g || (e.pointerType === "mouse" ? e.button !== 0 : !e.isPrimary)) return;
    const t = performance.now();
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false, s: [[t, e.clientX]] };
    try { svg.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) {
      if (!g && o.hover && e.pointerType === "mouse" && !e.buttons) o.hover(e);
      return;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
      // 斜着划时宁可当成页面滚动，也别让图表跟着抖
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) { g = null; release(e.pointerId); return; }
      g.moved = true;
      o.start?.(e);
    }
    g.dx = dx; g.dy = dy;
    const t = performance.now();
    g.s.push([t, e.clientX]); if (g.s.length > 6) g.s.shift();
    o.move?.(dx, dy, e);
  });
  svg.addEventListener("pointerup", (e) => finish(e, false));
  svg.addEventListener("pointercancel", (e) => finish(e, true));
  svg.addEventListener("pointerleave", (e) => { if (!g && o.leave && e.pointerType === "mouse") o.leave(); });
  svg.addEventListener("touchmove", (e) => { if (g?.moved && e.cancelable) e.preventDefault(); }, { passive: false });
}

/** 「一周一页」：拖动时整页跟手，松手后超过 20% 宽度或快甩就翻页，否则回弹；到头有阻尼。 */
function pager(svg, wrap, o) {
  const settle = () => {
    wrap.style.transition = reduced() ? "none" : "transform .35s cubic-bezier(.2,1.1,.4,1)";
    wrap.style.transform = "";
  };
  gesture(svg, {
    move: (dx) => {
      const lim = (dx > 0 && !o.canGo(1)) || (dx < 0 && !o.canGo(-1));
      wrap.style.transition = "none";
      wrap.style.transform = `translateX(${lim ? dx * 0.25 : dx}px)`;
    },
    end: ({ dx, vx, canceled }) => {
      if (canceled) return settle();
      const dir = dx > 0 ? 1 : -1;
      if ((Math.abs(dx) > o.W() * 0.2 || (Math.abs(dx) > 28 && Math.abs(vx) > 0.5)) && o.canGo(dir)) o.go(dir);
      else settle();
    },
    tap: (e) => o.tap(e),
    hover: o.hover,
    leave: o.leave,
  });
}

// ---------------------------------------------------------------------------
// 余量曲线：手指拖动时连续跟手，松手后吸附到整周（与下面两张图同一周）。
// 纵轴刻度全程固定（按已加载数据的最大值定，只增不减），所以拖动时线段连续、刻度不会跳。

function balanceView(hosts, env, D, proj, older, listeners, W) {
  const host = hosts.bal, { now } = env;
  if (D.readings.length < 2) return empty(host, "还没有足够的读数");
  const { P } = W;
  const last = proj[proj.length - 1];
  const cut = proj.length > 1 && last[1] === env.cutoff ? last : null;
  const Rof = (p) => W.refDay(p) + (FUTURE + 1) * DAY;   // 第 p 页窗口的右端
  const lastPage = () => { let k = 0; while (W.refDay(k + 1) + FUTURE * DAY >= D.first) k++; return k; };
  const view = { R: Rof(0) };
  const H = 230, m = { l: 8, r: 44, t: 16, b: 26 };
  const ink = css("--ink"), accent = css("--accent"), bad = css("--bad"), ok = css("--ok");
  let hoverT = null, intro = !reduced(), yHi = 0;

  /** 固定纵轴：最高刻度 = 已加载历史的最大值（打开后不久会补全全部历史），只增不减 */
  const axis = () => {
    const mx = Math.max(1, ...D.readings.map((p) => p[1]), ...proj.map((p) => p[1]));
    const y = niceTicks(Math.min(0, env.cutoff), mx, 4);
    if (y.hi < yHi) return niceTicks(y.lo, yHi, 4);
    yHi = y.hi;
    return y;
  };
  let y = axis();
  const nearestPage = () => Math.max(0, Math.min(lastPage(), Math.round((Rof(0) - view.R) / SPAN)));

  const c = chart(host, H, (svg, width, tip) => {
    const readings = D.readings;
    const R = view.R, from = R - SPAN;
    const pts = readings.filter(([t]) => t >= from - 2 * HOUR && t <= R + 2 * HOUR);
    const pr = proj.filter(([t]) => t >= from - 2 * HOUR && t <= R + 2 * HOUR);
    const X = (t) => m.l + ((t - from) / SPAN) * (width - m.l - m.r);
    const Y = (v) => H - m.b - ((v - y.lo) / (y.hi - y.lo)) * (H - m.t - m.b);
    const clipId = "clip" + Math.random().toString(36).slice(2, 7);
    const clip = el("clipPath", { id: clipId }, el("defs", {}, svg));
    el("rect", { x: m.l, y: 0, width: width - m.l - m.r, height: H }, clip);
    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (const v of y.ticks) {
      el("line", { x1: m.l, x2: width - m.r, y1: Y(v), y2: Y(v) }, g);
      text(ax, width - 2, Y(v) + 4, String(+v.toFixed(1)), { "text-anchor": "end" });
    }
    // 横轴与下面两张图同一套列宽：7 天各一个日期，落在周柱的中线上
    const band = (width - m.l - m.r) / 7;
    // 手机上一列不到 44px，「10/22」会挨在一起：窄屏只写日
    const narrow = band < 44;
    W.days(nearestPage()).forEach((d, i) => text(ax, m.l + band * (i + 0.5), H - 6,
      narrow ? String(new Date((d + 8 * HOUR) * 1000).getUTCDate()) : fmtMD(d), { "text-anchor": "middle" }));
    const body = el("g", { "clip-path": `url(#${clipId})` }, svg);
    // 「今」之后是未来：浅色底
    if (now < R) {
      const x0 = Math.max(m.l, X(now));
      el("rect", { class: "future", x: x0, y: m.t, width: Math.max(0, width - m.r - x0), height: H - m.t - m.b }, body);
      if (now >= from) {
        el("line", { class: "nowline", x1: X(now), x2: X(now), y1: m.t, y2: H - m.b }, body);
        text(body, X(now) + 4, m.t + 10, "今", { class: "lbl" });
      }
    }
    el("line", { class: "base", x1: m.l, x2: width - m.r, y1: Y(y.lo), y2: Y(y.lo) }, svg);
    // 读数间隔超过 3 小时就断线
    let d = "", seg = [];
    const flush = () => { if (seg.length > 1) d += seg.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(""); seg = []; };
    pts.forEach((p, i) => { if (i && p[0] - pts[i - 1][0] > 3 * HOUR) flush(); seg.push(p); });
    flush();
    const mainLine = el("path", { class: "line", d, stroke: ink }, body);
    const projLine = pr.length > 1 ? el("path", { class: "proj", stroke: accent, d: pr.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("") }, body) : null;
    if (intro) {
      // 首次出现：实线从左向右画出来，预测线随后淡入
      intro = false;
      const L = Math.ceil(mainLine.getTotalLength());
      mainLine.style.strokeDasharray = L; mainLine.style.strokeDashoffset = L;
      if (projLine) projLine.style.opacity = 0;
      mainLine.getBoundingClientRect();
      requestAnimationFrame(() => {
        mainLine.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.22,.61,.36,1)"; mainLine.style.strokeDashoffset = 0;
        if (projLine) { projLine.style.transition = "opacity .5s ease .8s"; projLine.style.opacity = 1; }
      });
    }
    for (const r of D.recharges.filter((r) => r.t >= from && r.t <= R)) {
      const p = readings.find(([t]) => t >= r.t) || readings[readings.length - 1];
      el("circle", { class: "dot", cx: X(p[0]), cy: Y(p[1]), r: 4.5, fill: ok }, body);
      text(body, X(p[0]) + 7, Y(p[1]) - 6, `+${r.amount.toFixed(0)}`, { class: "lbl" });
    }
    const end = readings[readings.length - 1];
    if (end[0] >= from && end[0] <= R) el("circle", { class: "dot", cx: X(end[0]), cy: Y(end[1]), r: 4.5, fill: ink }, body);
    if (cut && cut[0] >= from && cut[0] <= R) {
      const cx = X(cut[0]), right = cx > width - 100;
      el("circle", { class: "dot", cx, cy: Y(cut[1]), r: 5, fill: bad }, body);
      text(body, cx + (right ? -9 : 9), Y(cut[1]) - 9, `${fmtMD(cut[0])} ${fmtHM(cut[0])}`, { class: "lbl strong", "text-anchor": right ? "end" : "start" });
    }
    // 十字线 + 提示（轻点或鼠标悬停；拖动时隐藏）
    if (hoverT != null && hoverT >= from && hoverT <= R) {
      const all = pts.map((p) => ({ t: p[0], v: p[1], proj: false })).concat(pr.slice(1).map((p) => ({ t: p[0], v: p[1], proj: true })));
      let best = all[0];
      for (const p of all) if (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
      if (best) {
        const cx = X(best.t), cy = Y(best.v);
        el("line", { class: "cross", x1: cx, x2: cx, y1: m.t, y2: H - m.b }, svg);
        el("circle", { class: "dot", cx, cy, r: 4.5, fill: best.proj ? accent : ink }, svg);
        showTip(host, tip, cx, cy, fmtDate(best.t), [{ color: best.proj ? accent : ink, dash: best.proj, value: `${best.v.toFixed(2)} 度`, label: best.proj ? "预计余量" : "余量" }]);
      }
    } else hideTip(tip);
    const days = W.days(nearestPage());
    hosts.rng.textContent = `${fmtMD(days[0])} – ${fmtMD(days[6])}`;
  });
  listeners.push(() => { y = axis(); c.redraw(); });

  const svg = c.svg;
  const plotW = () => c.W - m.l - m.r;
  const tAt = (clientX) => (view.R - SPAN) + ((clientX - svg.getBoundingClientRect().left - m.l) / plotW()) * SPAN;
  const prefetch = () => { if (view.R - 2 * SPAN < D.readings[0][0]) older(); };
  /** 超出可滑动范围时带阻尼 */
  const soft = (R) => { const lo = Rof(lastPage()), hi = Rof(0); return R < lo ? lo - (lo - R) * 0.25 : R > hi ? hi + (R - hi) * 0.25 : R; };
  let dragR0 = 0, anim = 0, raf = 0;
  const redrawSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; c.redraw(); }); };

  /** 吸附到某一页：ease-out 动画，每帧重画（线段全程连续） */
  function animateTo(target) {
    const from = view.R, t0 = performance.now(), dur = reduced() ? 0 : Math.min(420, 160 + Math.abs(target - from) / SPAN * 260);
    cancelAnimationFrame(anim);
    const step = (now) => {
      if (!svg.isConnected) return;
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      view.R = lerp(from, target, ease(k));
      c.redraw();
      if (k < 1) anim = requestAnimationFrame(step); else prefetch();
    };
    anim = requestAnimationFrame(step);
  }
  /** 主动翻到第 p 页（周图/日图发起时只做动画，不改选中日——那边已经改好了） */
  const goPage = (p) => animateTo(Rof(Math.max(0, Math.min(lastPage(), p))));

  svg.style.cursor = "grab";
  gesture(svg, {
    start: () => {
      cancelAnimationFrame(anim);
      dragR0 = view.R;
      hoverT = null;
      svg.style.cursor = "grabbing";
    },
    move: (dx) => {
      view.R = soft(dragR0 - (dx / plotW()) * SPAN);
      prefetch();
      redrawSoon();
    },
    end: ({ vx, canceled }) => {
      svg.style.cursor = "grab";
      // 被页面滚动打断：退回原来那一周，别把三张图留在半路上
      if (canceled) return animateTo(Rof(P.page));
      // 松手：按甩动速度估计会停在哪，再吸附到最近的整周；吸附时另外两张图一起换页
      const lo = Rof(lastPage()), hi = Rof(0);
      const guess = Math.max(lo, Math.min(hi, view.R - vx * (SPAN / plotW()) * 220));
      const p = Math.max(0, Math.min(lastPage(), Math.round((Rof(0) - guess) / SPAN)));
      if (p !== P.page) { W.setPage(p); W.onPageChange(); }
      animateTo(Rof(p));
    },
    tap: (e) => { hoverT = tAt(e.clientX); c.redraw(); },
    hover: (e) => { hoverT = tAt(e.clientX); c.redraw(); },
    leave: () => { hoverT = null; c.redraw(); },
  });
  prefetch();
  return { goPage };
}

// ---------------------------------------------------------------------------
// 用电：周竖线图 + 当日 24 小时

/** 还没有「逐小时用电」（新寝室只有 0~1 条读数）时的用电视图：按画像（全校平均或兜底作息）
 *  画一条估算的 24 小时曲线，让刚注册的人也能看到东西，而不是一块空白。 */
function estimateView(root, env) {
  const fc = env.fc;
  if (!fc || !fc.ready) return empty(root, "正在读取电表，拿到首个读数后给出用电估算");
  const sc = (fc.scale || 1) * ((fc.band && fc.band.mid) || 1);
  const w = fc.work.map((v) => v * sc), r = fc.rest.map((v) => v * sc);
  const day = (a) => a.reduce((x, y) => x + y, 0);
  // 还没攒到全校先验时，工作日/休息日用的是同一个内置兜底画像：只画一条，别摆两根一模一样的柱
  const same = w.every((v, i) => Math.abs(v - r[i]) < 1e-9);
  const by = fc.confidence === "prior" ? "全校平均" : "本寝室已有读数";
  const cWork = css("--ink-2"), cRest = css("--muted");
  const dot = (c) => `<i class="sw" style="background:${c};opacity:.55"></i>`;
  root.innerHTML = `
    <p class="u-title">还没有逐小时数据，先按${by}估算：${same ? `每天约 ${fx(day(w))} 度` : `工作日约 ${fx(day(w))} 度/天，休息日约 ${fx(day(r))} 度/天`}</p>
    <div class="wk-clip"><div id="hr"></div></div>
    <div class="u-key">${same ? `<span class="k">${dot(cWork)}每小时估算</span>` : `<span class="k">${dot(cWork)}工作日</span><span class="k">${dot(cRest)}休息日</span>`}</div>`;
  const H = 236, d2 = { l: 8, r: 44, t: 30, b: 30 };
  chart(root.querySelector("#hr"), H, (svg, width) => {
    const y = niceTicks(0, Math.max(0.3, ...w, ...r), 3);
    const band = (width - d2.l - d2.r) / 24, bw = band * 0.34;
    const X = (h) => d2.l + band * h, Y = (v) => H - d2.b - (v / y.hi) * (H - d2.t - d2.b);
    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (const v of y.ticks) { el("line", { x1: d2.l, x2: width - d2.r, y1: Y(v), y2: Y(v) }, g); text(ax, width - 2, Y(v) + 4, v === 0 ? "0" : `${v}`, { "text-anchor": "end" }); }
    for (const h of [0, 6, 12, 18, 24]) { el("line", { x1: X(h), x2: X(h), y1: d2.t - 8, y2: H - d2.b + 8, stroke: "#e2e2df", "stroke-dasharray": "3 3" }, svg); if (h < 24) text(ax, X(h) + 4, H - 8, `${h}时`, {}); }
    for (let h = 0; h < 24; h++) {
      if (same) {
        const bw1 = band * 0.62;
        el("rect", { x: X(h) + (band - bw1) / 2, y: Y(w[h]), width: bw1, height: Math.max(0, Y(0) - Y(w[h])), rx: 2, fill: cWork, opacity: 0.55 }, svg);
      } else {
        const c0 = X(h) + (band - bw * 2 - 2) / 2;
        el("rect", { x: c0, y: Y(w[h]), width: bw, height: Math.max(0, Y(0) - Y(w[h])), rx: 2, fill: cWork, opacity: 0.55 }, svg);
        el("rect", { x: c0 + bw + 2, y: Y(r[h]), width: bw, height: Math.max(0, Y(0) - Y(r[h])), rx: 2, fill: cRest, opacity: 0.5 }, svg);
      }
    }
    el("line", { class: "base", x1: d2.l, x2: width - d2.r, y1: Y(0), y2: Y(0) }, svg);
  });
  return { redraw() {} };
}

function usageView(hosts, env, D, older, listeners, W, bal, predAt) {
  // 还没有「逐小时用电」（新寝室只有 0~1 条读数）：先按画像给一版估算，别让这里空着
  if (!D.byDay.size) return estimateView(hosts.use, env);
  const { P } = W;
  const root = hosts.use;
  const ink = css("--ink"), ok = css("--ok");

  /** 未来某天的逐小时预测（只给今天之后；今天的剩余小时单独算） */
  const predHours = (d) => {
    if (d < D.today) return null;
    const out = new Array(24).fill(null);
    for (let h = d === D.today ? D.upto : 0; h < 24; h++) out[h] = predAt(d + h * HOUR);
    return out;
  };
  const predTotal = (d) => {
    const a = predHours(d), xs = a ? a.filter((v) => v != null) : [];
    return xs.length ? sum(xs) : null;      // 还没有预测（模型未就绪）就不画
  };

  // ---- 周图 ----
  const H1 = 252, w = { l: 8, r: 44, t: 74, b: 38 };
  const week = chart(hosts.wk, H1, (svg, width, _tip, api) => {
    const days = W.days();
    const rows = days.map((d) => D.byDay.get(d));
    const preds = days.map((d) => (d > D.today ? predTotal(d) : null));
    const y = niceTicks(0, Math.max(1, ...rows.map((o) => (o ? o.total : 0)), ...preds.map((v) => v || 0)), 3);
    const Y = (v) => H1 - w.b - (v / y.hi) * (H1 - w.t - w.b);
    const band = (width - w.l - w.r) / 7, bw = Math.min(band * 0.58, 24);  // 苹果约 58%；宽屏封顶，免得电脑上变胖
    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (const v of y.ticks) {
      el("line", { x1: w.l, x2: width - w.r, y1: Y(v), y2: Y(v) }, g);
      text(ax, width - 2, Y(v) + 4, v === 0 ? "0" : `${v}`, { "text-anchor": "end" });
    }
    const bar = (i, cx, kind, top, fill, op = 1) => api.bar(svg, `${i}:${kind}`, { x0: cx - bw / 2, bw, base: Y(0), top, fill, op, delay: i * 35 });
    const cmp = P.sel === D.today;   // 只有选中「今天」才做「截至此刻」的同时刻对比；选过去某天，所有柱子都回到全天
    days.forEach((d, i) => {
      const cx = w.l + band * (i + 0.5), o = rows[i], sel = d === P.sel, isToday = d === D.today;
      const wd = WD[new Date((d + 8 * 3600) * 1000).getUTCDay()];
      const t1 = text(ax, cx, H1 - 20, wd, { "text-anchor": "middle" });
      t1.style.fill = sel ? ink : ""; t1.style.fontWeight = sel ? 600 : 400; t1.style.fontSize = "12px";
      if (sel) { const t2 = text(ax, cx, H1 - 5, fmtMD(d), { "text-anchor": "middle" }); t2.style.fill = ink; }
      // 未来两天：只画预测（虚线框），没有实际读数
      if (d > D.today) {
        if (preds[i] != null) api.bar(svg, `${i}:p`, { x0: cx - bw / 2, bw, base: Y(0), top: Y(preds[i]), ghost: true, delay: i * 35 });
        return;
      }
      if (!o) return;
      // 今天：只画「截至此刻」的部分；数据不完整的历史天（入驻首日/中途断采）不画整根柱，
      // 否则半天数据会被读成「这天用得很少」。它们的已覆盖时段仍可在下面的 24 小时图里点开看。
      if (isToday) { bar(i, cx, "p", Y(o.sofar), sel ? C_INK : C_GRAY); return; }
      if (!o.full) return;
      if (sel) bar(i, cx, "l", Y(o.total), C_INK);
      else if (cmp) { bar(i, cx, "l", Y(o.total), C_LIGHT); if (o.sofar > 0) bar(i, cx, "p", Y(o.sofar), C_GRAY); }
      else bar(i, cx, "l", Y(o.total), C_GRAY);
    });
    el("line", { class: "base", x1: w.l, x2: width - w.r, y1: Y(0), y2: Y(0) }, svg);
    // 选中日：竖线 + 大数字（电池样式）。换选中日时整组滑过去，数字滚动
    const si = days.indexOf(P.sel), so = rows[si];
    const pv = si >= 0 && P.sel > D.today ? preds[si] : null;
    const v = so ? (P.sel === D.today ? so.sofar : so.total) : pv;
    if (si >= 0 && v != null) {
      const cx = w.l + band * (si + 0.5), yTop = Y(v) - 2;
      const from = api.state || { cx, v: 0, y: Y(0) };
      api.state = { cx, v, y: yTop };
      const grp = el("g", {}, svg);
      const line = el("line", { x1: cx, x2: cx, y1: 8, y2: yTop, stroke: ink, "stroke-width": 1 }, grp);
      const right = cx > width * 0.45, tx = right ? cx - 8 : cx + 8, anchor = right ? "end" : "start";
      const big = text(grp, tx, 36, fx(v), { "text-anchor": anchor });
      big.style.cssText = "font-size:32px;font-weight:300;fill:var(--ink);font-variant-numeric:tabular-nums";
      const u = el("tspan", { dx: 4 }, big); u.textContent = "度"; u.style.cssText = "font-size:14px;fill:var(--muted)";
      const label = fmtDate(P.sel, false) + (P.sel === D.today ? " · 今天" : pv != null ? " · 预测" : "");
      const dt = text(grp, tx, 56, label, { "text-anchor": anchor });
      dt.style.cssText = "font-size:12.5px;fill:var(--muted)";
      api.tween((k) => {
        const e = ease(k);
        grp.setAttribute("transform", `translate(${lerp(from.cx - cx, 0, e)},0)`);
        line.setAttribute("y2", lerp(from.y, yTop, e));
        big.firstChild.nodeValue = fx(lerp(from.v, v, e));
        big.style.opacity = dt.style.opacity = Math.min(1, 0.35 + e * 1.2);
      });
    } else api.state = null;
  });

  // ---- 当日图 ----
  const H2 = 236, d2 = { l: 8, r: 44, t: 30, b: 30 };
  const day = chart(hosts.hr, H2, (svg, width, _tip, api) => {
    const d = P.sel, o = D.byDay.get(d), future = d > D.today;
    const arr = o ? o.h : Array(24).fill(null);
    const pred = predHours(d);
    // 刻度按「这一周里最大的一小时」定死（含未来两天的预测），切换哪一天刻度都不变，柱子高低才能直接比
    const weekMax = Math.max(0.3, ...W.days().flatMap((dd) => {
      const oo = D.byDay.get(dd);
      return oo ? oo.h.filter((v) => v != null) : [];
    }), ...W.days().filter((dd) => dd > D.today).flatMap((dd) => predHours(dd) || []));
    const y = niceTicks(0, weekMax, 3);
    const band = (width - d2.l - d2.r) / 24, bw = band * 0.72;
    const X = (h) => d2.l + band * h, Y = (v) => H2 - d2.b - (v / y.hi) * (H2 - d2.t - d2.b);
    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (const v of y.ticks) { el("line", { x1: d2.l, x2: width - d2.r, y1: Y(v), y2: Y(v) }, g); text(ax, width - 2, Y(v) + 4, v === 0 ? "0" : `${v}`, { "text-anchor": "end" }); }
    for (const h of [0, 6, 12, 18, 24]) {
      el("line", { x1: X(h), x2: X(h), y1: d2.t - 8, y2: H2 - d2.b + 8, stroke: "#e2e2df", "stroke-dasharray": "3 3" }, svg);
      if (h < 24) text(ax, X(h) + 4, H2 - 8, `${h}时`, {});
    }
    // 充值：绿色高亮一整列 + 闪电（电池样式）
    for (const r of D.recharges.filter((r) => dayStart(r.t) === d)) {
      const hh = hourOfDay(r.t);
      const cg = el("g", { class: "fadein" }, svg);
      el("rect", { x: X(hh), y: d2.t - 8, width: band, height: H2 - d2.b - d2.t + 8, fill: ok, opacity: 0.13 }, cg);
      el("line", { x1: X(hh), x2: X(hh) + band, y1: d2.t - 8, y2: d2.t - 8, stroke: ok, "stroke-width": 2 }, cg);
      const bolt = el("path", { d: "M7 0 0 8h4.5L3.5 15 11 6H6.5Z", fill: ok, transform: `translate(${X(hh) + band / 2 - 5.5},${d2.t - 25})` }, cg);
      bolt.setAttribute("aria-label", `充值 ${r.amount.toFixed(0)} 度`);
      text(cg, X(hh) + band + 4, d2.t - 12, `+${r.amount.toFixed(0)}`, { class: "lbl strong" });
    }
    const nowCut = future ? 0 : d === D.today ? D.upto : 24;
    arr.forEach((v, h) => {
      if (v == null || h >= nowCut) return;
      api.bar(svg, `h${h}`, { x0: X(h) + (band - bw) / 2, bw, base: Y(0), top: Y(v), fill: C_GRAY, r: 3, delay: h * 14 });
    });
    // 今天剩余的小时 / 未来的整天：用同一套虚线框画预测，和已经发生的柱子接在一起
    (pred || []).forEach((v, h) => {
      if (v == null) return;
      api.bar(svg, `h${h}p`, { x0: X(h) + (band - bw) / 2, bw, base: Y(0), top: Y(v), ghost: true, delay: h * 14 });
    });
    el("line", { class: "base", x1: d2.l, x2: width - d2.r, y1: Y(0), y2: Y(0) }, svg);
  });

  const dayCanGo = (dir) => (dir > 0 ? P.sel - DAY >= D.first : P.sel + DAY <= D.today + FUTURE * DAY);
  /** 选中某天：必要时把三张图一起挪到那一周（点周图不换页，滑过去的换页会重画柱子） */
  function selectDay(d) {
    const p = W.pageOf(d);
    if (p !== P.page) { W.setPage(p); week.prev.clear(); week.state = null; bal.goPage(p); }
    P.sel = d;
    day.prev.clear();
    all();
  }
  // 翻到快没数据的那一周时，提前把更早的取回来
  const prefetch = () => { if (W.days()[0] - SPAN < D.first) older(); };
  const all = () => { week.redraw(); day.redraw(); prefetch(); };
  all();
  listeners.push(all);

  // ---- 周图：点选某天；左右拖动翻周（余量图跟着走到同一周） ----
  const wk = hosts.wk, svg = week.svg;
  pager(svg, wk, {
    W: () => week.W,
    canGo: (dir) => W.canPage(dir),
    go: (dir) => slide(wk, week.W, dir, () => {
      const p = P.page + dir;
      W.setPage(p);
      week.prev.clear(); week.state = null; day.prev.clear();
      bal.goPage(p);
      all();
    }),
    tap: (e) => {
      const band = (week.W - w.l - w.r) / 7, i = Math.floor((e.clientX - svg.getBoundingClientRect().left - w.l) / band);
      const d = W.days()[i];
      // 没有数据、也不是未来的那一列不响应点选：选中了也只剩一块空白
      if (d != null && i >= 0 && i < 7 && (D.byDay.has(d) || d > D.today)) selectDay(d);
    },
  });

  // ---- 当日图：左右滑动换天（向右 = 前一天），上面的周图跟着转到那一天 ----
  const hr = hosts.hr;
  const goDay = (dir) => slide(hr, day.W, dir, () => {
    const d = P.sel - dir * DAY;
    const p = W.pageOf(d);
    if (p !== P.page) { W.setPage(p); week.prev.clear(); week.state = null; bal.goPage(p); }
    P.sel = d;
    day.prev.clear();
    all();
  });
  pager(day.svg, hr, { W: () => day.W, canGo: dayCanGo, go: goDay, tap: () => {} });

  return { redraw: all };
}
