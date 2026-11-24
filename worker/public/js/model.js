// 用电模型：从逐小时余量学习工作日、休息日与每周重复的用电规律，推算余量耗尽时刻。
// Worker（入库时增量学习、判定预警）与前端（统计、图表）共用本文件，无外部依赖。
//
// 关键约定：
// - 时间一律为 Unix 秒；按北京时间（UTC+8，无夏令时）划分日期与小时。
// - 学校后台每小时刷新一次读数，且有几分钟延迟。读数时刻 t 对应的「计量小时」为
//   floor((t - lag) / 3600) * 3600：例如 lag=10min 时，21:01 读到的仍是 20:00 的状态。
// - 两个相邻计量小时之间的余量差，就是这一小时的用电；中间缺采样时按画像形状分摊。
//
// 闭环：每 3 小时记一次「未来 6h / 24h / 72h 预计用电」快照，到期后与实际用电对比，
// 得到每个寝室（以及全校）的预测误差分布，用来校准「最早 / 最晚停电」的区间宽度。

export const HOUR = 3600;
export const DAY = 86400;
export const HORIZONS = [6, 24, 72]; // 精度追踪的预测跨度（小时）；72h 用来校准多天后的误差带
const TZ = 8 * HOUR;
const HL_PROFILE = 14 * DAY; // 画像半衰期：两周前的作息权重减半
const HL_RECENT = 72 * HOUR; // 近期水平半衰期：用于识别「这几天开了空调/暖气」（实测 48h 偏短，多天预测更差）
const SHRINK = 3; // 分桶向上一级均值收缩的强度（等效小时数）
const WEEK_HOURS = 5 * 24; // 普通周一至周五，周末共用实测休息日画像
const WEEK_NOISE = 0.1; // 同一周几、钟点的累计偏差先扣除一个常见计量步长（度）
const WEEK_LIMIT = 0.25; // 每个小时相对工作日画像的最大修正幅度
const K_LEVEL = 6; // 寝室整体水平向全校均值收缩的强度（等效小时数）
const EPS = 0.05; // 读数抖动容差（度），超过视为充值
const MAX_GAP = 48; // 超过该间隔（小时）的读数对不参与学习
const HORIZON = 60 * 24; // 最多向后模拟 60 天
const SNAP_EVERY = 3 * HOUR;
const MAX_SNAP = (Math.max(...HORIZONS) * HOUR) / SNAP_EVERY + 1; // 最长跨度到期前快照都要留着
const ACC_DECAY = 0.97; // 误差统计按评估次数衰减（约 23 次，即 3 天左右半衰）
const Z80 = 1.2816; // 80% 区间
const LONG_RATIO = 0.85; // 没有 72h 统计时，多天误差带取 24h 对数宽度的比例（实测 sd 0.28 -> 0.24）

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

// 0、1 分别是工作日和休息日。启用每周画像时，2..6 是普通周一到周五。
function profileDay(t, cal, weekly) {
  if (cal && (cal.off.size || cal.work.size)) {
    const di = dayIndex(t);
    let v = cal.cache && cal.cache.get(di);
    if (v === undefined) {
      const d = ymd(t);
      v = cal.work.has(d) ? false : cal.off.has(d) ? true : null;
      if (cal.cache) cal.cache.set(di, v);
    }
    if (v !== null) return v ? 1 : 0;
  }
  const w = weekday(t);
  if (w === 0 || w === 6) return 1;
  return weekly ? w + 1 : 0;
}
export const isRest = (t, cal) => profileDay(t, cal, false) === 1;
/** 0..23 = 工作日该小时，24..47 = 休息日该小时 */
export const bucket = (t, cal) => profileDay(t, cal, false) * 24 + hourOfDay(t);
export const meterHour = (t, lag = 600) => Math.floor((t - lag) / HOUR) * HOUR;

const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export const validReading = (t, b) => Number.isSafeInteger(t) && t > 0 &&
  Number.isFinite(b) && b >= -1000 && b <= 1e5;

/** 无效值不转成 0；同一时间戳只保留首条，保证重试不会改变已经接受的读数。 */
export function normalizeReadings(readings) {
  const seen = new Set();
  return readings.filter((p) => {
    if (!Array.isArray(p) || !validReading(p[0], p[1]) || seen.has(p[0])) return false;
    seen.add(p[0]);
    return true;
  }).sort((a, b) => a[0] - b[0]);
}

// ---------- 增量模型（存于 rooms.model） ----------

export function newModel() {
  return { v: 2, T: 0, B: null, at: 0, w: Array(48).fill(0), s: Array(48).fill(0), week: null, act: 0, exp: 0, snap: [], acc: {} };
}

export function pack(m) {
  return JSON.stringify({
    ...m, w: m.w.map(r4), s: m.s.map(r4), act: r4(m.act), exp: r4(m.exp),
    week: m.week ? { at: m.week.at, w: m.week.w.map(r4), s: m.week.s.map(r4) } : null,
    snap: m.snap.map((x) => ({ ...x, B: r4(x.B), p: x.p.map(r4) })),
    acc: Object.fromEntries(Object.entries(m.acc).map(([k, a]) => [k, { n: r4(a.n), s1: r4(a.s1), s2: r4(a.s2), sa: r4(a.sa) }])),
  });
}
export function unpack(s) {
  if (!s) return newModel();
  try {
    const m = JSON.parse(s);
    if (!m || ![1, 2].includes(m.v) || ![m.w, m.s].every((a) =>
      Array.isArray(a) && a.length === 48 && a.every((x) => Number.isFinite(x) && x >= 0)) ||
      ![m.T, m.at, m.act, m.exp].every((x) => Number.isFinite(x) && x >= 0) ||
      (m.B !== null && !validReading(m.T, m.B))) return newModel();
    const week = m.week;
    if (!week || !Number.isSafeInteger(week.at) || week.at <= 0 || week.at > m.T ||
        ![week.w, week.s].every((a) => Array.isArray(a) && a.length === WEEK_HOURS &&
          a.every((x) => Number.isFinite(x) && x >= 0))) m.week = null;
    if (m.v === 1) return { ...m, v: 2, snap: [], acc: {} };
    const full = (1 << HORIZONS.length) - 1;
    m.snap = (Array.isArray(m.snap) ? m.snap : []).filter((x) => x && validReading(x.T, x.B) &&
      x.T <= m.T && Number.isInteger(x.d) && x.d >= 0 && x.d < full &&
      Array.isArray(x.p) && x.p.length >= 1 && x.p.length <= HORIZONS.length && x.p.every((p) => Number.isFinite(p) && p >= 0))
      // 旧快照少了新加的跨度：补 0 并标记为已结算，原有跨度照常到期评估。
      .map((x) => x.p.length === HORIZONS.length ? x
        : { ...x, p: HORIZONS.map((_, j) => x.p[j] ?? 0), d: x.d | (full & ~((1 << x.p.length) - 1)) })
      .slice(-MAX_SNAP);
    m.acc = Object.fromEntries(Object.entries(m.acc || {}).filter(([h, a]) => HORIZONS.includes(+h) && a &&
      [a.n, a.s1, a.s2, a.sa].every(Number.isFinite) && a.n > 0 && a.s2 >= 0 && a.sa >= 0));
    return m;
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
  if (!(Array.isArray(prior) && prior.length === 48 && prior.every((x) => Number.isFinite(x) && x >= 0) && sum(prior) > 0) &&
      !(Number.isFinite(prior) && prior > 0)) prior = DEFAULT_PROFILE;
  const pv = Array.isArray(prior) ? prior : null;
  const pMean = pv ? sum(pv) / 48 : prior;
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

// 只在两个相邻计量小时之间学习周几差异。充值、漏采分摊、周末与显式调休日不提供样本。
function learnWeek(m, from, used, cal) {
  const day = profileDay(from, cal, true);
  if (day < 2) return;
  const week = m.week ??= { at: m.T, w: Array(WEEK_HOURS).fill(0), s: Array(WEEK_HOURS).fill(0) };
  const decay = Math.pow(0.5, (m.T - week.at) / HL_PROFILE);
  for (let i = 0; i < WEEK_HOURS; i++) { week.w[i] *= decay; week.s[i] *= decay; }
  const i = (day - 2) * 24 + hourOfDay(from);
  week.w[i]++; week.s[i] += used; week.at = m.T;
}

function forecastProfile(m, prior) {
  const base = profile(m, prior), week = m.week;
  if (!week) return base;
  const decay = Math.pow(0.5, (m.T - week.at) / HL_PROFILE);
  let rates = base;
  for (let i = 0; i < WEEK_HOURS; i++) {
    const weight = week.w[i] * decay;
    if (weight <= 1) continue;
    const normal = base[i % 24], excess = week.s[i] * decay - weight * normal;
    if (Math.abs(excess) <= WEEK_NOISE) continue;
    // 单次读数的台阶不触发修正。多周累积的同向偏差才逐渐影响预测。
    const delta = Math.sign(excess) * (Math.abs(excess) - WEEK_NOISE) *
      Math.min(1, weight - 1) / (weight + SHRINK);
    if (rates === base) {
      const work = base.slice(0, 24);
      rates = base.concat(work, work, work, work, work);
    }
    rates[48 + i] = normal + clamp(delta, -WEEK_LIMIT * normal, WEEK_LIMIT * normal);
  }
  return rates;
}

/** 从 T 开始，按画像 × 近期倍率累计 hours 小时的预计用电 */
function cumulative(prof, scale, T, hours, cal) {
  let c = 0;
  for (let i = 0, h = T; i < hours; i++, h += HOUR) {
    c += prof[profileDay(h, cal, prof.length > 48) * 24 + hourOfDay(h)] * scale;
  }
  return c;
}

/**
 * 喂入一条读数，原地更新模型。
 * 返回 {kind: 'init'|'same'|'recharge'|'gap'|'use'|'invalid', evals: [{h, r, t}]}。
 * evals 为本次到期的精度评估，t 是到期的计量小时，r = ln(实际/预测)。
 */
export function update(m, t, b, cal, lag = 600, prior) {
  if (!validReading(t, b)) return { kind: "invalid", evals: [] };
  const T = meterHour(t, lag);
  if (m.B == null) { Object.assign(m, { T, B: b, at: T }); return { kind: "init", evals: [] }; }
  // 必须先挡住旧小时；否则迟到的高余量会被误识别成充值，覆盖最新基准。
  if (T < m.T) return { kind: "same", evals: [] };
  if (b > m.B + EPS) {
    // 充值：这段时间的真实用电未知，不学习，只重置基准；进行中的快照作废
    const prof = forecastProfile(m, prior);
    const gap = (T - m.T) / HOUR;
    const gapUse = gap > 0 && gap <= MAX_GAP ? cumulative(prof, scaleOf(m), m.T, gap, cal) : 0;
    const amount = b - m.B + gapUse;
    m.T = Math.max(T, m.T); m.B = b; m.snap = [];
    return { kind: "recharge", amount, evals: [] };
  }
  // 同一计量小时的重复读数：不动基准，差值会在下一小时一起计入
  if (T <= m.T) return { kind: "same", evals: [] };

  const gap = (T - m.T) / HOUR;
  const used = Math.max(0, m.B - b);
  const from = m.T;
  // 容差内的上抖不抬高基准，否则下一次回落会被凭空计成用电。
  m.T = T; m.B = Math.min(m.B, b);
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
  const wt = 1 / gap; // 一个余量差只提供一个观测，漏采 48 小时不能凭空增加 24 个样本
  for (const k of ks) {
    const x = expected > 0 ? (used * prof[k]) / expected : used / gap;
    m.w[k] += wt; m.s[k] += wt * x;
  }
  m.act += used; m.exp += expected;
  if (gap === 1) learnWeek(m, from, used, cal);

  // 精度闭环：评估到期快照
  // 只在正好到期的那条读数上结算；T 跳过 due（漏采）时宁可不记，也不用近似值污染这一档——
  // 「6h/24h」的语义靠「窗口正好是 H 小时」维持。实测轮询很少漏采，代价可忽略。
  const evals = [];
  for (const s of m.snap) {
    HORIZONS.forEach((H, j) => {
      if (s.d & (1 << j)) return;
      const due = s.T + H * HOUR;
      if (T === due) {
        const r = Math.log((Math.max(0, s.B - b) + 0.1) / (s.p[j] + 0.1));
        const a = m.acc[H] || (m.acc[H] = { n: 0, s1: 0, s2: 0, sa: 0 });
        a.n = a.n * ACC_DECAY + 1; a.s1 = a.s1 * ACC_DECAY + r; a.s2 = a.s2 * ACC_DECAY + r * r; a.sa = a.sa * ACC_DECAY + Math.abs(r);
        evals.push({ h: H, r, t: T });
      }
      if (T >= due) s.d |= 1 << j;
    });
  }
  m.snap = m.snap.filter((s) => s.d !== (1 << HORIZONS.length) - 1);
  // 新快照：用更新后的画像预测未来各跨度的用电
  if (T % SNAP_EVERY === 0 && sum(m.w) >= 3) {
    const p2 = forecastProfile(m, prior), sc = scaleOf(m);
    m.snap.push({ T, B: m.B, d: 0, p: HORIZONS.map((H) => cumulative(p2, sc, T, H, cal)) });
    if (m.snap.length > MAX_SNAP) m.snap.shift();
  }
  return { kind: "use", used, hours: gap, evals };
}

/** 置信度：prior（仅全校平均粗估）/ low / mid / high */
export function confidence(m) {
  const n = sum(m.w);
  return n < 3 ? "prior" : n < 24 ? "low" : n < 24 * 7 ? "mid" : "high";
}

/** 误差统计 -> {sd, mape}；样本不足返回 null */
function spread(a, nMin) {
  if (!a || !(a.n >= nMin) || ![a.n, a.s1, a.s2, a.sa].every(Number.isFinite)) return null;
  const mu = a.s1 / a.n;
  return { sd: Math.sqrt(Math.max(0, a.s2 / a.n - mu * mu)), mape: a.sa / a.n };
}
const okCalib = (c) => c && c.n >= 30 && [c.sd, c.mape].every(Number.isFinite) && c.sd >= 0 && c.mape >= 0;

/**
 * 误差带：用预测误差分布（对数比 ln(实际/预测)）算 80% 区间。
 * hi/lo 适用于 24 小时以内，hiL/loL 适用于 72 小时以后，中间按对数线性过渡（见 factorAt）。
 * 本寝室评估次数够用本寝室的，否则用全校的 calib，再不行用经验值；72h 档缺数据时按 LONG_RATIO 从 24h 推。
 *
 * - 区间以 1 为中心，**不做中位偏差修正**（mid 恒为 1，字段保留做兼容）：每寝室统计约 3 天半衰、
 *   24h 窗口每 3 小时一个互相重叠，有效样本只有几天，偏差修正是在追噪声。实测去掉后 6h~168h 误差全部下降。
 * - 24 小时以内只用 24h 这一档是**有意的**：6h 的误差也照常记（m.acc[6]、accuracy 表、后台曲线），
 *   但「最早」决定预警是否触发（alertDecision）。24h 外推误差更大 → 区间更宽 → 预警更早，这是安全侧。
 *   72h 档只让剩余好几天时的区间收窄（多天的日间波动部分抵消），不影响 24 小时预警。
 *   想调预警灵敏度请改 THRESHOLD_HOURS，不要改这里。
 */
export function band(m, calib) {
  const acc = (m && m.acc) || {};
  let s = spread(acc[24], 8), src = "room";
  if (!s && okCalib(calib)) { s = { sd: calib.sd, mape: calib.mape }; src = "school"; }
  const sd = s ? s.sd : Math.log(1.25) / Z80;
  let sdL = (spread(acc[72], 8) || (calib && calib.long && calib.long.n >= 30 && Number.isFinite(calib.long.sd) &&
    calib.long.sd >= 0 ? calib.long : null) || { sd: sd * LONG_RATIO }).sd;
  sdL = Math.min(sd, sdL); // 多天累计不会比单日更不确定；样本噪声导致的反常一律按 24h 算
  const hi = (x) => r4(clamp(Math.exp(Z80 * x), 1.05, 2.5)), lo = (x) => r4(clamp(Math.exp(-Z80 * x), 0.4, 0.95));
  return {
    src: s ? src : "default", mape: s ? r4(Math.exp(s.mape) - 1) : null, mid: 1,
    hi: hi(sd), lo: lo(sd), hiL: hi(sdL), loL: lo(sdL),
  };
}

/** 预测起点之后 e 小时的误差倍率：≤24h 用 a，≥72h 用 b，中间对数线性过渡 */
function factorAt(a, b, e) {
  if (!(b > 0)) return a; // 旧格式的 band 没有长跨度字段
  return e <= 24 ? a : e >= 72 ? b : a * Math.pow(b / a, (e - 24) / 48);
}

/**
 * 推算停电时刻。balance 为最新余量，from 为它对应的计量小时。
 * 返回 mid（最可能）、early（用电偏多、80% 区间上沿）、late（偏少），均为 Unix 秒；60 天内不会停电则为 null。
 */
export function forecast(m, balance, cal, { from, cutoff = 0, prior, calib } = {}) {
  if (!m || m.B == null || !Number.isFinite(balance) || !Number.isFinite(cutoff)) return null;
  const learned = sum(m.w);
  const prof = forecastProfile(m, prior);
  const scale = learned < 3 ? 1 : scaleOf(m);
  const bd = band(m, calib);
  const start = from ?? m.T;
  if (!Number.isSafeInteger(start) || start <= 0) return null;
  const left = balance - cutoff;
  // 一次遍历同时求三个交点：累计用电 × 系数 ≥ 剩余电量。系数随预测跨度变化（见 band）：
  // early 的阈值随时间单调升、late 的单调降，三者始终 early < mid < late。
  const target = {
    early: (e) => left / factorAt(bd.hi, bd.hiL, e),
    mid: () => left / bd.mid,
    late: (e) => left / factorAt(bd.lo, bd.loL, e),
  };
  const out = { early: null, mid: null, late: null };
  if (left <= 0) { out.early = out.mid = out.late = start; }
  else {
    const stop = start + HORIZON * HOUR;
    const dayUse = [];
    for (let i = 0; i < prof.length; i += 24) dayUse.push(sum(prof.slice(i, i + 24)) * scale);
    let c = 0, h = start;
    while (h < stop && out.late == null) {
      const e = (h - start) / HOUR;
      // 下一交点不在今天时，整天跳过；仍逐日判断节假日与调休，交点所在日精确到小时。
      // 阈值在一天内单调，取两端较小者判断，保证不会跳过交点。
      if (h === dayStart(h) && h + DAY <= stop) {
        const k = out.early == null ? "early" : out.mid == null ? "mid" : "late";
        const u = dayUse[profileDay(h, cal, prof.length > 48)];
        if (c + u < Math.min(target[k](e), target[k](e + 24))) { c += u; h += DAY; continue; }
      }
      const end = Math.min((Math.floor(h / HOUR) + 1) * HOUR, stop);
      const duration = end - h;
      const u = prof[profileDay(h, cal, prof.length > 48) * 24 + hourOfDay(h)] * scale * duration / HOUR;
      for (const k of ["early", "mid", "late"]) {
        const tg = target[k](e);
        if (out[k] == null && u > 0 && c + u >= tg) out[k] = Math.round(h + (duration * Math.max(0, tg - c)) / u);
      }
      c += u;
      h = end;
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
    rest: prof.slice(24, 48).map(r4),
    ...(prof.length > 48 ? { week: prof.slice(48).map(r4) } : {}),
  };
}

/** 未来某小时的预计用电（含近期修正），供前端画 7 天格子 */
export function expectedAt(fc, t, cal) {
  if (!fc || !fc.ready) return null;
  const day = profileDay(t, cal, fc.week?.length === WEEK_HOURS), h = hourOfDay(t);
  const rate = day < 2 ? (day === 0 ? fc.work : fc.rest)[h] : fc.week[(day - 2) * 24 + h];
  return rate * fc.scale * ((fc.band && fc.band.mid) || 1);
}

// ---------- 读数紧凑编码（D1 中每寝室每天一行） ----------

/** [[t, b], ...] -> "m0,c0,dm1,dc1,..."：分钟（相对当天 0 点）与 0.01 度，首项绝对、其余差分 */
export function encodeDay(day, pts) {
  const out = [];
  let pm = 0, pc = 0;
  pts.forEach(([t, b], i) => {
    // 向下取整，避免 :09:59 变成 :10、23:59:59 串到次日，改变计量小时或归档日期。
    const mi = Math.floor((t - day) / 60), c = Math.round(b * 100);
    out.push(i ? mi - pm : mi, i ? c - pc : c);
    pm = mi; pc = c;
  });
  return out.join(",");
}
export function decodeDay(day, v) {
  if (!Number.isSafeInteger(day) || typeof v !== "string" || !v) return [];
  const parts = v.split(",");
  if (parts.length % 2 || parts.some((x) => !/^-?\d+$/.test(x))) return [];
  const a = parts.map(Number);
  if (!a.every(Number.isSafeInteger)) return [];
  const pts = [];
  let mi = 0, c = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    mi = i ? mi + a[i] : a[i]; c = i ? c + a[i + 1] : a[i + 1];
    // 旧编码曾把 23:59:xx 四舍五入为第 1440 分钟，仍允许解码以便保留历史。
    if (mi < 0 || mi > 1440 || (i && a[i] < 0) || !validReading(day + mi * 60, c / 100)) return [];
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
  const hours = [], recharges = [];
  let prev = null;
  for (const [t, b1] of normalizeReadings(readings)) {
    const t1 = meterHour(t, lag);
    if (!prev) { prev = [t1, b1]; continue; }
    const [t0, b0] = prev;
    const gap = (t1 - t0) / HOUR;
    if (b1 > b0 + EPS) { recharges.push({ t: t1, amount: b1 - b0 }); prev = [t1, b1]; continue; }
    if (gap <= 0) continue;
    prev = [t1, Math.min(b0, b1)];
    if (gap > MAX_GAP) continue;
    const u = Math.max(0, b0 - b1) / gap;
    for (let h = t0; h < t1; h += HOUR) hours.push({ t: h, kwh: u, est: gap > 1 });
  }
  return { hours, recharges };
}

/** 按天汇总实际覆盖的用电（不足 20 个有效小时标记 partial，不把缺失小时当成 0）。 */
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
  hours = hours.filter((h) => Number.isFinite(h.t) && h.t + HOUR <= now && Number.isFinite(h.kwh) && h.kwh >= 0);
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
