// 通用工具：响应、错误、随机数、哈希、限流、meta 存取。

export const now = () => Math.floor(Date.now() / 1000);

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS, ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

/** 读 JSON 请求体，限制大小 */
export async function body(req, maxBytes = 16 * 1024) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) fail(415, "需要 JSON");
  const len = +(req.headers.get("content-length") || 0);
  if (len > maxBytes) fail(413, "请求体过大");
  const text = await req.text();
  if (text.length > maxBytes) fail(413, "请求体过大");
  try { return JSON.parse(text || "{}"); } catch { fail(400, "JSON 格式错误"); }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export function randToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 从字母表无偏抽样 n 个字符 */
export function randCode(n, alphabet = "0123456789") {
  const out = [];
  const lim = 256 - (256 % alphabet.length);
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < lim && out.length < n) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}

/** 常量时间比较（用于 Bearer token） */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length || !x.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export function maskEmail(e) {
  const [u, d] = String(e).split("@");
  if (!d) return "***";
  const keep = u.length <= 4 ? 1 : 2;
  return `${u.slice(0, keep)}${"*".repeat(Math.max(2, u.length - keep * 2))}${u.slice(-keep)}@${d}`;
}

/**
 * 固定窗口计数限流。返回当前计数；超过 limit 抛 429。
 * 一条语句完成「过期重置 + 自增」，并发安全。
 */
export async function limit(env, key, max, windowSec, message = "操作太频繁，请稍后再试") {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO ratelimit (k, n, reset) VALUES (?1, 1, ?2 + ?3)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN reset <= ?2 THEN 1 ELSE n + 1 END,
       reset = CASE WHEN reset <= ?2 THEN ?2 + ?3 ELSE reset END
     RETURNING n, reset`,
  ).bind(key, t, windowSec).first();
  if (row.n > max) fail(429, message, { retryAfter: row.reset - t });
  return row.n;
}

/** 退还一次限流计数：发信失败时用，避免把当天配额烧在没发出去的邮件上。窗口已过期的键不动。 */
export function refund(env, ...keys) {
  const t = now();
  return env.DB.batch(keys.map((k) =>
    env.DB.prepare("UPDATE ratelimit SET n = n - 1 WHERE k = ?1 AND reset > ?2 AND n > 0").bind(k, t)));
}

export async function getMeta(env, k, dflt = null) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first();
  if (!r) return dflt;
  try { return JSON.parse(r.v); } catch { return dflt; }
}
export const setMeta = (env, k, v) =>
  env.DB.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(k, JSON.stringify(v));

/** 提醒冷却：同一寝室 12 小时内不再发同级或更低级的提醒——防读数抖动、预测波动造成的重复/高频邮件 */
export const ALERT_COOLDOWN = 12 * 3600;
export const alertCooling = (last, level, t) => !!last && last.level >= level && t - last.at < ALERT_COOLDOWN;

/** 轮询失败邮件里该怀疑什么：只有明确的 token 错误才提示重抓 token */
export function pollerFailHint(msg = "") {
  return /TOKEN ERROR|code\s*=\s*300/i.test(String(msg))
    ? "校园卡 token 可能已过期（code=300），请重新抓取并更新本机 token 文件。"
    : "这不是 token 过期。请检查本机网络出口能否直连 api.etslink.net（开了全局代理/TUN 时尤其注意），以及学校接口是否可用。";
}

/** 轮询失败邮件正文：保留原始错误与成功/失败间数，避免把网络问题误报成 token 过期 */
export function pollerFailText(st = {}, t = st.at) {
  const msg = st.msg || "无错误信息";
  return `${fmtTime(t)}\n${msg}\n本轮成功 ${+st.polled || 0} 间，失败 ${+st.failed || 0} 间。\n\n`
    + `${pollerFailHint(msg)}\n在此期间网站会按模型继续推算并发送预警。`;
}

export const num = (v, d) => (v == null || v === "" || isNaN(+v) ? d : +v);

/** 北京时间格式化：10月12日 周一 03:00 */
export function fmtTime(t) {
  const d = new Date((t + 8 * 3600) * 1000);
  const wd = "日一二三四五六"[d.getUTCDay()];
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${wd} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
