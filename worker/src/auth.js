// 登录：QQ 邮箱 + 6 位验证码。会话为随机 token，数据库只存其哈希。
import { now, fail, sha256, randToken, randCode, limit, refund } from "./util.js";
import { sendMail, otpMail } from "./mail.js";

const EMAIL_RE = /^[a-z0-9][a-z0-9._-]{0,63}@(qq\.com|vip\.qq\.com|foxmail\.com)$/;
const OTP_TTL = 600;
const OTP_TRIES = 5;
// 一次登录长期有效：1 年（浏览器对 cookie 的上限是 400 天）。
// session() 里会用滑动续期，只要半年内来过就自动延到满 1 年，实际等于一直不用重登。
const SESSION_TTL = 365 * 86400;
const COOKIE = "__Host-ww";

export function normEmail(raw, env) {
  let e = String(raw || "").trim().toLowerCase();
  if (/^\d{5,12}$/.test(e)) e += "@qq.com"; // 只填 QQ 号
  // 普通用户只能用 QQ 邮箱；管理员邮箱（ADMIN_EMAILS）例外，便于登录看运行状态
  if (!EMAIL_RE.test(e) && !(env && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && isAdmin(env, e))) fail(400, "请填写 QQ 邮箱（如 12345678@qq.com）");
  return e;
}

const clientIp = (req) => req.headers.get("cf-connecting-ip") || "local";

async function checkTurnstile(env, req, token) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) fail(400, "请先完成人机验证");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(token));
  form.append("remoteip", clientIp(req));
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) fail(400, "人机验证失败，请刷新后重试");
}

const otpHash = (env, email, purpose, code) => sha256(`${env.OTP_PEPPER || "dev"}:${email}:${purpose}:${code}`);

/** 发验证码。purpose: login | change（换绑，需登录） */
export async function sendCode(env, req, { email, purpose, userId, turnstile }) {
  const ip = clientIp(req);
  // 顺序：IP 限流 -> 人机验证 -> 邮箱限流（避免他人未过验证就耗尽你的邮箱配额）-> 全站日上限
  await limit(env, `otp:ip:${ip}`, 20, 3600, "当前网络请求过多，请稍后再试");
  await checkTurnstile(env, req, turnstile);
  const kMail = `otp:mail:${email}`;
  const kDay = `otp:mail-day:${email}`;
  const kGlobal = "otp:global";
  await limit(env, kMail, 1, 60, "发送太频繁，请 1 分钟后再试");
  await limit(env, kDay, 8, 86400, "该邮箱今天的验证码次数已用完");
  await limit(env, kGlobal, +(env.OTP_DAILY_CAP || 300), 86400, "今日验证码发送量已达上限，请明天再试");

  const code = randCode(6);
  await env.DB.prepare(
    `INSERT INTO otps (email, purpose, user_id, hash, expires, tries) VALUES (?1, ?2, ?3, ?4, ?5, 0)
     ON CONFLICT(email, purpose) DO UPDATE SET user_id = ?3, hash = ?4, expires = ?5, tries = 0`,
  ).bind(email, purpose, userId ?? null, await otpHash(env, email, purpose, code), now() + OTP_TTL).run();

  const [r] = await sendMail(env, [otpMail(env, email, code, purpose)]).catch((e) => [{ ok: false, error: e.message }]);
  if (!r.ok) {
    // 邮件没发出去就不算一次：退还配额，并删掉这条用户永远收不到的验证码，允许立刻重试
    console.error("otp mail failed", r.error);
    await env.DB.prepare("DELETE FROM otps WHERE email = ? AND purpose = ?").bind(email, purpose).run();
    await refund(env, kMail, kDay, kGlobal);
    fail(502, "邮件发送失败，请稍后再试");
  }
}

/** 校验验证码，成功即作废；返回 otp 行 */
export async function checkCode(env, email, purpose, code) {
  code = String(code || "").trim();
  if (!/^\d{6}$/.test(code)) fail(400, "验证码是 6 位数字");
  const row = await env.DB.prepare("SELECT * FROM otps WHERE email = ? AND purpose = ?").bind(email, purpose).first();
  if (!row || row.expires < now()) fail(400, "验证码已过期，请重新获取");
  if (row.tries >= OTP_TRIES) fail(429, "错误次数过多，请重新获取验证码");
  if ((await otpHash(env, email, purpose, code)) !== row.hash) {
    await env.DB.prepare("UPDATE otps SET tries = tries + 1 WHERE email = ? AND purpose = ?").bind(email, purpose).run();
    fail(400, `验证码不正确（还可尝试 ${OTP_TRIES - row.tries - 1} 次）`);
  }
  await env.DB.prepare("DELETE FROM otps WHERE email = ? AND purpose = ?").bind(email, purpose).run();
  return row;
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function createSession(env, userId) {
  const token = randToken();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, expires, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), userId, t + SESSION_TTL, t),
    env.DB.prepare("UPDATE users SET login_at = ? WHERE id = ?").bind(t, userId),
  ]);
  return cookie(token, SESSION_TTL);
}

export const clearCookie = () => cookie("", 0);

function readCookie(req) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** 返回 {user, sid, refresh?}；会话剩余不足一半时续期 */
export async function session(env, req) {
  const token = readCookie(req);
  if (!token || token.length > 100) return null;
  const sid = await sha256(token);
  const user = await env.DB.prepare(
    `SELECT u.*, s.expires AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires > ?`,
  ).bind(sid, now()).first();
  if (!user) return null;
  let refresh = null;
  if (user.s_expires - now() < SESSION_TTL / 2) {
    await env.DB.prepare("UPDATE sessions SET expires = ? WHERE id = ?").bind(now() + SESSION_TTL, sid).run();
    refresh = cookie(token, SESSION_TTL);
  }
  return { user, sid, refresh };
}

export async function logout(env, req) {
  const token = readCookie(req);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
}

export const isAdmin = (env, email) =>
  (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(email);
