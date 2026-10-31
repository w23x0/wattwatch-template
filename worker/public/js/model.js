// 用电模型：余量读数 -> 逐小时用电 -> 「工作日/休息日 × 24 小时」画像 -> 推算停电时刻。
// Worker（入库时增量学习、判定预警）与前端（统计、图表）共用本文件，无外部依赖。
//
// 关键约定：
// - 时间一律为 Unix 秒；按北京时间（UTC+8，无夏令时）划分日期与小时。
// - 学校后台每小时刷新一次读数，且有几分钟延迟。读数时刻 t 对应的「计量小时」为
//   floor((t - lag) / 3600) * 3600：例如 lag=10min 时，21:01 读到的仍是 20:00 的状态。
// - 两个相邻计量小时之间的余量差，就是这一小时的用电；中间缺采样时按画像形状分摊。
//
// 闭环：每 3 小时记一次「未来 6h / 24h 预计用电」快照，到期后与实际用电对比，
// 得到每个寝室（以及全校）的预测误差分布，用来校准「最早 / 最晚停电」的区间宽度。

export const HOUR = 3600;
export const DAY = 86400;
export const HORIZONS = [6, 24]; // 精度追踪的预测跨度（小时）
const TZ = 8 * HOUR;
const HL_PROFILE = 14 * DAY; // 画像半衰期：两周前的作息权重减半
const HL_RECENT = 48 * HOUR; // 近期水平半衰期：用于识别「这两天开了空调/暖气」
const SHRINK = 3; // 分桶向上一级均值收缩的强度（等效小时数）
const K_LEVEL = 6; // 寝室整体水平向全校均值收缩的强度（等效小时数）
const EPS = 0.05; // 读数抖动容差（度），超过视为充值
const MAX_GAP = 48; // 超过该间隔（小时）的读数对不参与学习
const HORIZON = 60 * 24; // 最多向后模拟 60 天
const SNAP_EVERY = 3 * HOUR;
const ACC_DECAY = 0.97; // 误差统计按评估次数衰减（约 23 次，即 3 天左右半衰）
const Z80 = 1.2816; // 80% 区间

// ---------- 日历 ----------

/** holidays/workdays: "2026-10-01,2026-10-02" 形式；用于法定节假日与调休。 */
export function calendar(holidays = "", workdays = "") {
  const p = (s) => new Set(String(s || "").split(/[,\s]+/).filter(Boolean));
  return { off: p(holidays), work: p(workdays), cache: new Map() };
}
const dayIndex = (t) => Math.floor((t + TZ) / DAY);
export const ymd = (t) => new Date((t + TZ) * 1000).toISOString().slice(0, 10);
export const hourOfDay = (t) => Math.floor((((t + TZ) % DAY) + DAY) % DAY / HOUR);
export const weekday = (t) => (((dayIndex(t) + 4) % 7) + 7) % 7; // 0=周日；1970-01-01 是周四
export const dayStart = (t) => dayIndex(t) * DAY - TZ;
export const weekStart = (t) => dayStart(t) - ((weekday(t) + 6) % 7) * DAY; // 周一 00:00
export const isNight = (t) => { const h = hourOfDay(t); return h >= 23 || h < 7; };

export function isRest(t, cal) {
  if (cal && (cal.off.size || cal.work.size)) {
    const di = dayIndex(t);
    let v = cal.cache && cal.cache.get(di);
    if (v === undefined) {
      const d = ymd(t);
      v = cal.work.has(d) ? false : cal.off.has(d) ? true : null;
      if (cal.cache) cal.cache.set(di, v);
    }
    if (v !== null) return v;
  }
  const w = weekday(t);
  return w === 0 || w === 6;
}
/** 0..23 = 工作日该小时，24..47 = 休息日该小时 */
export const bucket = (t, cal) => (isRest(t, cal) ? 24 : 0) + hourOfDay(t);
export const meterHour = (t, lag = 600) => Math.floor((t - lag) / HOUR) * HOUR;

const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------- 增量模型（存于 rooms.model） ----------

export function newModel() {
  return { v: 2, T: 0, B: null, at: 0, w: Array(48).fill(0), s: Array(48).fill(0), act: 0, exp: 0, snap: [], acc: {} };
}

export function pack(m) {
  return JSON.stringify({
    ...m, w: m.w.map(r4), s: m.s.map(r4), act: r4(m.act), exp: r4(m.exp),
    snap: m.snap.map((x) => ({ ...x, B: r4(x.B), p: x.p.map(r4) })),
    acc: Object.fromEntries(Object.entries(m.acc).map(([k, a]) => [k, { n: r4(a.n), s1: r4(a.s1), s2: r4(a.s2), sa: r4(a.sa) }])),
  });
}
export function unpack(s) {
  if (!s) return newModel();
  try {
    const m = JSON.parse(s);
    if (m && m.v === 1) return { ...m, v: 2, snap: [], acc: {} };
    return m && m.v === 2 ? m : newModel();
  } catch { return newModel(); }
}
export const learnedHours = (m) => sum(m.w);

// 全校先验还没攒够（样本寝室不够、或都还没学满一周）时的兜底作息形状。相对值，均值归一到
// DEFAULT_DAILY_KWH 度/天；工作日与休息日暂用同一形状。有了它，新寝室拿到第一条读数就能给出「粗估」，
// 而不是等全校先验攒够（旧实现要 ≥5 个寝室 × 7 天，小规模部署可能永远凑不齐）。
const DEFAULT_SHAPE = [0.7, 0.35, 0.35, 0.35, 0.35, 0.35, 0.4, 0.6, 0.5, 0.5, 0.5, 0.55, 0.85, 0.7, 0.5, 0.5, 0.55, 0.7, 0.9, 1.35, 1.45, 1.4, 1.3, 1.0];
const DEFAULT_DAILY_KWH = 6; // 兜底日用电量（度）：学生寝室的大致量级
const _dmean = sum(DEFAULT_SHAPE) / 24;
/** 内置 48 分桶兜底先验（度/时），可直接当 prior 传给 profile/forecast */
export const DEFAULT_PROFILE = [...DEFAULT_SHAPE, ...DEFAULT_SHAPE].map((x) => r4((x / _dmean) * (DEFAULT_DAILY_KWH / 24)));

/**
 * 画像：每个分桶的期望小时用电（度/时）。
 * prior：全校平均画像（48 个值）或一个标量（度/时）。**不传时用内置的兜底作息形状**，
 *   而不是一个平坦的常数——这样还没攒够全校先验的新部署也能给出有作息节奏的粗估。
 * 分层收缩：分桶 -> 「同一小时均值 × 该日类型倍率 × 全校的交互形状」-> 寝室整体水平 -> 全校均值。
 * 没有数据时等于全校平均；数据越多越贴合本寝室；休息日样本少也不会被工作日拉平。
 */
export function profile(m, prior = DEFAULT_PROFILE) {
  const pv = Array.isArray(prior) && prior.length === 48 ? prior : null;
  const pMean = pv ? sum(pv) / 48 : +prior || 0.25;
  const shape = (k) => (pv ? pv[k] / pMean : 1);
  const shapeType = [0, 24].map((o) => (pv ? sum(pv.slice(o, o + 24)) / 24 / pMean : 1));
  const level = (sum(m.s) + K_LEVEL * pMean) / (sum(m.w) + K_LEVEL);
  const typeMean = [0, 24].map((o, i) =>
    (sum(m.s.slice(o, o + 24)) + SHRINK * level * shapeType[i]) / (sum(m.w.slice(o, o + 24)) + SHRINK));
  const out = new Array(48);
  for (let h = 0; h < 24; h++) {
    const hourShape = (shape(h) + shape(h + 24)) / 2;
    const pooled = (m.s[h] + m.s[h + 24] + SHRINK * level * hourShape) / (m.w[h] + m.w[h + 24] + SHRINK);
    for (const [i, o] of [[0, 0], [1, 24]]) {
      const inter = shape(h + o) / (hourShape * shapeType[i] || 1);
      const base = ((pooled * typeMean[i]) / level) * inter;
      out[h + o] = (m.s[h + o] + SHRINK * base) / (m.w[h + o] + SHRINK);
    }
  }
  return out;
}

const scaleOf = (m) => clamp((m.act + 0.5) / (m.exp + 0.5), 0.5, 2);

/** 从 T 开始，按画像 × 近期倍率累计 hours 小时的预计用电 */
function cumulative(prof, scale, T, hours, cal) {
  let c = 0;
  for (let i = 0, h = T; i < hours; i++, h += HOUR) c += prof[bucket(h, cal)] * scale;
  return c;
}

/**
 * 喂入一条读数，原地更新模型。
 * 返回 {kind: 'init'|'same'|'recharge'|'gap'|'use', evals: [{h, r}]}，evals 为本次到期的精度评估（r = ln(实际/预测)）。
 */
export function update(m, t, b, cal, lag = 600, prior) {
  const T = meterHour(t, lag);
  if (m.B == null) { Object.assign(m, { T, B: b, at: T }); return { kind: "init", evals: [] }; }
  if (b > m.B + EPS) {
    // 充值：这段时间的真实用电未知，不学习，只重置基准；进行中的快照作废
    const prof = profile(m, prior);
    const gapUse = T > m.T ? cumulative(prof, scaleOf(m), m.T, (T - m.T) / HOUR, cal) : 0;
    const amount = b - m.B + gapUse;
    m.T = Math.max(T, m.T); m.B = b; m.snap = [];
    return { kind: "recharge", amount, evals: [] };
  }
  // 同一计量小时的重复读数：不动基准，差值会在下一小时一起计入
  if (T <= m.T) return { kind: "same", evals: [] };

  const gap = (T - m.T) / HOUR;
  const used = Math.max(0, m.B - b);
  const from = m.T;
  m.T = T; m.B = b;
  if (gap > MAX_GAP) { m.snap = []; return { kind: "gap", hours: gap, evals: [] }; }

  const prof = profile(m, prior);
  const dP = Math.pow(0.5, (T - m.at) / HL_PROFILE);
  const dR = Math.pow(0.5, (T - m.at) / HL_RECENT);
  m.at = T;
  for (let i = 0; i < 48; i++) { m.w[i] *= dP; m.s[i] *= dP; }
  m.act *= dR; m.exp *= dR;

  const ks = [];
  let expected = 0;
  for (let h = from; h < T; h += HOUR) { const k = bucket(h, cal); ks.push(k); expected += prof[k]; }
  const wt = gap === 1 ? 1 : 0.5; // 分摊出来的值没那么可信
  for (const k of ks) {
    const x = expected > 0 ? (used * prof[k]) / expected : used / gap;
    m.w[k] += wt; m.s[k] += wt * x;
  }
  m.act += used; m.exp += expected;

  // 精度闭环：评估到期快照
  // 只在正好到期的那条读数上结算；T 跳过 due（漏采）时宁可不记，也不用近似值污染这一档——
  // 「6h/24h」的语义靠「窗口正好是 H 小时」维持。实测轮询很少漏采，代价可忽略。
  const evals = [];
  for (const s of m.snap) {
    HORIZONS.forEach((H, j) => {
      if (s.d & (1 << j)) return;
      const due = s.T + H * HOUR;
      if (T === due) {
        const r = Math.log((s.B - b + 0.1) / (s.p[j] + 0.1));
        const a = m.acc[H] || (m.acc[H] = { n: 0, s1: 0, s2: 0, sa: 0 });
        a.n = a.n * ACC_DECAY + 1; a.s1 = a.s1 * ACC_DECAY + r; a.s2 = a.s2 * ACC_DECAY + r * r; a.sa = a.sa * ACC_DECAY + Math.abs(r);
        evals.push({ h: H, r });
      }
      if (T >= due) s.d |= 1 << j;
    });
  }
  m.snap = m.snap.filter((s) => s.d !== (1 << HORIZONS.length) - 1);
  // 新快照：用更新后的画像预测未来各跨度的用电
  if (T % SNAP_EVERY === 0 && sum(m.w) >= 3) {
    const p2 = profile(m, prior), sc = scaleOf(m);
    m.snap.push({ T, B: b, d: 0, p: HORIZONS.map((H) => cumulative(p2, sc, T, H, cal)) });
    if (m.snap.length > 12) m.snap.shift();
  }
  return { kind: "use", used, hours: gap, evals };
}

/** 置信度：prior（仅全校平均粗估）/ low / mid / high */
export function confidence(m) {
  const n = sum(m.w);
  return n < 3 ? "prior" : n < 24 ? "low" : n < 24 * 7 ? "mid" : "high";
}

/**
 * 误差带：用 24h 跨度的预测误差分布（对数比）算 80% 区间。
 * 本寝室评估次数够用本寝室的，否则用全校的 calib，再不行用经验值。
 *
 * ⚠️ 只用 24h 这一档是**有意的，不是遗漏**：6h 的误差也照常记（m.acc[6]、accuracy 表、后台曲线），
 * 但 hi/lo 只喂给 forecast 的「最早/最晚」，而「最早」同时决定预警是否触发（alertDecision）。
 * 24h 外推误差更大 → 区间更宽 → 预警更早，这是安全侧；换成 6h 只会让预警变晚、变少。
 * 想调预警灵敏度请改 THRESHOLD_HOURS，不要改这里。
 */
export function band(m, calib) {
  const a = m && m.acc && m.acc[24];
  let mu, sd, src, mape;
  if (a && a.n >= 8) {
    mu = a.s1 / a.n; sd = Math.sqrt(Math.max(0, a.s2 / a.n - mu * mu)); mape = a.sa / a.n; src = "room";
  } else if (calib && calib.n >= 30) {
    ({ mu, sd, mape } = calib); src = "school";
  } else {
    return { src: "default", mid: 1, hi: 1.25, lo: 0.8, mape: null };
  }
  return {
    src, mape: r4(Math.exp(mape) - 1),
    mid: r4(clamp(Math.exp(mu), 0.8, 1.25)),
    hi: r4(clamp(Math.exp(mu + Z80 * sd), 1.05, 2.5)),
    lo: r4(clamp(Math.exp(mu - Z80 * sd), 0.4, 0.95)),
  };
}

/**
 * 推算停电时刻。balance 为最新余量，from 为它对应的计量小时。
 * 返回 mid（最可能）、early（用电偏多、80% 区间上沿）、late（偏少），均为 Unix 秒；60 天内不会停电则为 null。
 */
export function forecast(m, balance, cal, { from, cutoff = 0, prior, calib } = {}) {
  if (!m || m.B == null || balance == null) return null;
  const learned = sum(m.w);
  const prof = profile(m, prior);   // 没传全校先验时，profile 内部用内置的兜底作息形状
  const scale = learned < 3 ? 1 : scaleOf(m);
  const bd = band(m, calib);
  const start = from ?? m.T;
  const left = balance - cutoff;
  // 一次遍历同时求三个交点：累计用电 × 系数 ≥ 剩余电量
  const targets = { early: left / bd.hi, mid: left / bd.mid, late: left / bd.lo };
  const out = { early: null, mid: null, late: null };
  if (left <= 0) { out.early = out.mid = out.late = start; }
  else {
    let c = 0;
    for (let i = 0, h = start; i < HORIZON && out.late == null; i++, h += HOUR) {
      const u = prof[bucket(h, cal)] * scale;
      for (const k of ["early", "mid", "late"]) {
        if (out[k] == null && c + u >= targets[k]) out[k] = Math.round(h + (HOUR * (targets[k] - c)) / u);
      }
      c += u;
    }
  }
  return {
    ready: true,
    learned: Math.round(learned),
    confidence: confidence(m),
    scale: r4(scale),
    band: bd,
    from: start,
    ...out,
    work: prof.slice(0, 24).map(r4),
    rest: prof.slice(24).map(r4),
  };
}

/** 未来某小时的预计用电（含近期修正与偏差校正），供前端画 7 天格子 */
export function expectedAt(fc, t, cal) {
  if (!fc || !fc.ready) return null;
  const k = bucket(t, cal);
  return (k < 24 ? fc.work[k] : fc.rest[k - 24]) * fc.scale * ((fc.band && fc.band.mid) || 1);
}

// ---------- 读数紧凑编码（D1 中每寝室每天一行） ----------

/** [[t, b], ...] -> "m0,c0,dm1,dc1,..."：分钟（相对当天 0 点）与 0.01 度，首项绝对、其余差分 */
export function encodeDay(day, pts) {
  const out = [];
  let pm = 0, pc = 0;
  pts.forEach(([t, b], i) => {
    const mi = Math.round((t - day) / 60), c = Math.round(b * 100);
    out.push(i ? mi - pm : mi, i ? c - pc : c);
    pm = mi; pc = c;
  });
  return out.join(",");
}
export function decodeDay(day, v) {
  if (!v) return [];
  const a = v.split(",").map(Number);
  const pts = [];
  let mi = 0, c = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    mi = i ? mi + a[i] : a[i]; c = i ? c + a[i + 1] : a[i + 1];
    pts.push([day + mi * 60, c / 100]);
  }
  return pts;
}

// ---------- 历史统计（前端用） ----------

/**
 * readings: [[t, balance], ...] 升序。
 * 返回逐小时用电 hours: [{t, kwh, est}]（est=由多小时间隔均摊）与充值事件 recharges: [{t, amount}]。
 */
export function hourly(readings, lag = 600) {
  const pts = [];
  for (const [t, b] of readings) {
    const T = meterHour(t, lag);
    if (pts.length && pts[pts.length - 1][0] === T) pts[pts.length - 1][1] = b;
    else pts.push([T, b]);
  }
  const hours = [], recharges = [];
  for (let i = 1; i < pts.length; i++) {
    const [t0, b0] = pts[i - 1], [t1, b1] = pts[i];
    const gap = (t1 - t0) / HOUR;
    if (b1 > b0 + EPS) { recharges.push({ t: t1, amount: b1 - b0 }); continue; }
    if (gap > MAX_GAP) continue;
    const u = Math.max(0, b0 - b1) / gap;
    for (let h = t0; h < t1; h += HOUR) hours.push({ t: h, kwh: u, est: gap > 1 });
  }
  return { hours, recharges };
}

/** 按天汇总（不足 20 个有效小时的天按比例折算，标记 partial） */
export function daily(hours, cal) {
  const map = new Map();
  for (const { t, kwh } of hours) {
    const d = dayStart(t);
    let o = map.get(d);
    if (!o) map.set(d, (o = { t: d, kwh: 0, n: 0, rest: isRest(d, cal) }));
    o.kwh += kwh; o.n++;
  }
  return [...map.values()].sort((a, b) => a.t - b.t).map((o) => ({ ...o, partial: o.n < 20 }));
}

const mean = (a) => (a.length ? sum(a) / a.length : null);

/** 看板上的习惯统计 */
export function stats(hours, cal, now) {
  const today = dayStart(now);
  const days = daily(hours, cal);
  const full = days.filter((d) => d.t < today && !d.partial);
  const norm = (d) => (d.kwh * 24) / d.n;
  const in7 = full.filter((d) => d.t >= today - 7 * DAY);
  const in28 = full.filter((d) => d.t >= today - 28 * DAY);

  // 周：周一为起点；覆盖不足 85% 的周不计入均值
  const weeks = new Map();
  for (const { t, kwh } of hours) {
    const w = weekStart(t);
    const o = weeks.get(w) || { t: w, kwh: 0, n: 0 };
    o.kwh += kwh; o.n++; weeks.set(w, o);
  }
  const thisWeek = weekStart(now);
  const fullWeeks = [...weeks.values()].filter((w) => w.t < thisWeek && w.n >= 168 * 0.85 && w.t >= thisWeek - 28 * DAY);

  const recent = hours.filter((h) => h.t >= now - 7 * DAY);
  const recentSum = sum(recent.map((h) => h.kwh));
  const night = sum(recent.filter((h) => isNight(h.t)).map((h) => h.kwh));

  // 经验画像：近 28 天每个小时的平均用电
  const acc = { work: Array.from({ length: 24 }, () => []), rest: Array.from({ length: 24 }, () => []) };
  for (const h of hours) if (h.t >= today - 28 * DAY && !h.est) acc[isRest(h.t, cal) ? "rest" : "work"][hourOfDay(h.t)].push(h.kwh);

  // 本月（自然月）用电
  const d = new Date((now + TZ) * 1000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - TZ;
  const month = hours.filter((h) => h.t >= monthStart);

  return {
    today: sum(hours.filter((h) => h.t >= today).map((h) => h.kwh)),
    todayHours: hours.filter((h) => h.t >= today).length,
    avg7: mean(in7.map(norm)), days7: in7.length,
    weekAvg: mean(fullWeeks.map((w) => (w.kwh * 168) / w.n)), weeks: fullWeeks.length,
    workAvg: mean(in28.filter((x) => !x.rest).map(norm)),
    restAvg: mean(in28.filter((x) => x.rest).map(norm)),
    nightShare: recentSum > 0 ? night / recentSum : null,
    hourWork: acc.work.map(mean), hourRest: acc.rest.map(mean),
    month: sum(month.map((h) => h.kwh)), monthHours: month.length, monthStart,
    days,
  };
}
