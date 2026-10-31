// 邮件：Worker 通过 TCP socket 直连 SMTP（默认 QQ 邮箱 465/SSL + 授权码），免费、可发给任意地址。
// 预警邮件先写 outbox 表，再由 waitUntil / 定时任务发送，失败自动重试；验证码邮件同步发送。
import { connect } from "cloudflare:sockets";
import { now, fmtTime } from "./util.js";

const enc = new TextEncoder();
const b64 = (s) => {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");

/** RFC 2047：非 ASCII 头按 UTF-8 拆段（每段 ≤ 45 字节，不切断字符） */
function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const parts = [];
  let cur = "", len = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (len + n > 45) { parts.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => `=?UTF-8?B?${b64(p)}?=`).join("\r\n ");
}

function buildMessage(env, { to, subject, text, html, headers }) {
  const from = env.MAIL_FROM || env.SMTP_USER;
  const domain = from.split("@")[1] || "localhost";
  const boundary = "ww_" + crypto.randomUUID().replace(/-/g, "");
  const head = [
    `From: ${encodeHeader(env.SITE_NAME || "WattWatch")} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    ...Object.entries(headers || {}).filter(([k, v]) => /^[A-Za-z-]+$/.test(k) && !/[\r\n]/.test(v)).map(([k, v]) => `${k}: ${v}`),
  ];
  const part = (type, content) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(content))}`;
  if (!html) {
    return [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text))].join("\r\n");
  }
  return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    part("text/plain", text), part("text/html", html), `--${boundary}--`, ""].join("\r\n");
}

class SmtpConn {
  constructor(sock) {
    this.sock = sock;
    this.reader = sock.readable.getReader();
    this.writer = sock.writable.getWriter();
    this.buf = "";
    this.dec = new TextDecoder();
  }
  async line() {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return l; }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP 连接被关闭");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async reply(expect) {
    const lines = [];
    let l;
    do { l = await this.line(); lines.push(l); } while (l[3] === "-");
    const code = +l.slice(0, 3);
    if (expect && !expect.includes(code)) throw new Error(`SMTP ${code}: ${lines.join(" | ").slice(0, 200)}`);
    return code;
  }
  async send(raw) { await this.writer.write(enc.encode(raw)); }
  async cmd(line, expect) { await this.send(line + "\r\n"); return this.reply(expect); }
  release() { this.reader.releaseLock(); this.writer.releaseLock(); }
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时`)), ms))]);

/** 用一条 SMTP 会话发送多封邮件；返回每封的 {ok, error} */
async function smtpSendAll(env, messages) {
  const secure = env.SMTP_SECURE || "tls"; // tls(465) | starttls(587) | off(仅本地测试)
  const sock = connect(
    { hostname: env.SMTP_HOST || "smtp.qq.com", port: +(env.SMTP_PORT || 465) },
    { secureTransport: secure === "tls" ? "on" : secure === "starttls" ? "starttls" : "off", allowHalfOpen: false },
  );
  let c = new SmtpConn(sock);
  const results = [];
  try {
    await c.reply([220]);
    const helo = (env.MAIL_FROM || env.SMTP_USER || "x@localhost").split("@")[1] || "localhost";
    await c.cmd(`EHLO ${helo}`, [250]);
    if (secure === "starttls") {
      await c.cmd("STARTTLS", [220]);
      c.release();
      c = new SmtpConn(sock.startTls());
      await c.cmd(`EHLO ${helo}`, [250]);
    }
    if (env.SMTP_USER && env.SMTP_PASS) {
      await c.cmd("AUTH LOGIN", [334]);
      await c.cmd(b64(env.SMTP_USER), [334]);
      await c.cmd(b64(env.SMTP_PASS), [235]);
    }
    const from = env.MAIL_FROM || env.SMTP_USER;
    for (const m of messages) {
      try {
        await c.cmd(`MAIL FROM:<${from}>`, [250]);
        await c.cmd(`RCPT TO:<${m.to}>`, [250, 251]);
        await c.cmd("DATA", [354]);
        // 正文为 base64，不会出现以 "." 开头的行，无需点转义
        await c.send(buildMessage(env, m) + "\r\n.\r\n");
        await c.reply([250]);
        results.push({ ok: true });
      } catch (e) {
        results.push({ ok: false, error: String(e.message || e) });
        try { await c.cmd("RSET", [250]); } catch { break; }
      }
    }
    try { await c.cmd("QUIT", [221]); } catch { /* 忽略 */ }
  } finally {
    try { await sock.close(); } catch { /* 忽略 */ }
  }
  while (results.length < messages.length) results.push({ ok: false, error: "SMTP 会话中断" });
  return results;
}

export async function sendMail(env, messages) {
  if (!messages.length) return [];
  if (env.MAIL_MODE === "log") {
    for (const m of messages) console.log(`[mail] to=${m.to} subject=${m.subject}\n${m.text}`);
    return messages.map(() => ({ ok: true }));
  }
  if (!env.SMTP_USER || !env.SMTP_PASS) throw new Error("未配置发信邮箱：SMTP_USER / SMTP_PASS 为空（见 README「部署」一节）");
  return withTimeout(smtpSendAll(env, messages), 25000, "SMTP");
}

// ---------- outbox ----------

export const enqueue = (env, { to, subject, text, html, headers }) =>
  env.DB.prepare("INSERT INTO outbox (to_addr, subject, text, html, headers, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(to, subject, text, html || null, headers ? JSON.stringify(headers) : null, now());

export async function flushOutbox(env, max = 20) {
  const { results } = await env.DB.prepare(
    "SELECT id, to_addr, subject, text, html, headers FROM outbox WHERE sent_at IS NULL AND tries < 5 ORDER BY id LIMIT ?",
  ).bind(max).all();
  if (!results.length) return 0;
  let res;
  try {
    res = await sendMail(env, results.map((r) => ({ to: r.to_addr, subject: r.subject, text: r.text, html: r.html, headers: r.headers ? JSON.parse(r.headers) : null })));
  } catch (e) {
    res = results.map(() => ({ ok: false, error: String(e.message || e) }));
  }
  const t = now();
  await env.DB.batch(results.map((r, i) => res[i].ok
    ? env.DB.prepare("UPDATE outbox SET sent_at = ?, tries = tries + 1, error = NULL WHERE id = ?").bind(t, r.id)
    : env.DB.prepare("UPDATE outbox SET tries = tries + 1, error = ? WHERE id = ?").bind(res[i].error.slice(0, 300), r.id)));
  return res.filter((r) => r.ok).length;
}

// ---------- 模板 ----------

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(env, title, rows, foot) {
  const site = escHtml(env.SITE_NAME || "WattWatch");
  const url = env.SITE_URL ? `<a href="${escHtml(env.SITE_URL)}" style="color:#161614">${escHtml(env.SITE_URL.replace(/^https?:\/\//, ""))}</a>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f5f1;padding:24px 12px;font:15px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#161614">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e7e5de;border-radius:14px;padding:24px">
<div style="font-size:12px;color:#8a8983;letter-spacing:.08em">⚡ ${site}</div>
<h1 style="font-size:20px;font-weight:600;margin:8px 0 16px">${title}</h1>
${rows}
<p style="font-size:12px;color:#8a8983;margin:20px 0 0;border-top:1px solid #efede7;padding-top:12px">${foot}${url ? "<br>" + url : ""}</p>
</div></body></html>`;
}

export function otpMail(env, to, code, purpose) {
  const what = purpose === "change" ? "更换绑定邮箱" : "登录";
  const subject = `${code} 是你的${env.SITE_NAME || "WattWatch"}${what}验证码`;
  const text = `验证码：${code}\n10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。`;
  const html = layout(env, `${what}验证码`,
    `<div style="font-size:34px;font-weight:600;letter-spacing:.3em;margin:4px 0 8px">${code}</div>
<div style="color:#55544f">10 分钟内有效，请勿告诉他人。</div>`,
    "如果不是你本人操作，请忽略这封邮件。");
  return { to, subject, text, html };
}

/** 退订签名：HMAC(OTP_PEPPER, "unsub:<uid>")，链接无需登录即可使用 */
export async function unsubSig(env, uid) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.OTP_PEPPER || "dev"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`unsub:${uid}`));
  return [...new Uint8Array(sig)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** level 1 = 24h 预警，level 2 = 临停提醒；staleHours>0 表示电表数据中断，以下为推算 */
export async function alertMail(env, user, room, fc, balance, level, staleHours = 0) {
  const name = `${room.build_name} ${room.room_name}`;
  const t = fc && fc.mid ? fmtTime(fc.mid) : null;
  const early = fc && fc.early ? fmtTime(fc.early) : null;
  const hours = fc && fc.mid ? Math.max(0, (fc.mid - now()) / 3600) : null;
  const mape = fc && fc.band && fc.band.mape != null ? Math.round(fc.band.mape * 100) : null;
  const subject = level >= 2
    ? `⚠️ ${name} 即将停电${t ? `（约 ${t}）` : ""}`
    : `${name} 电量不足，预计 ${t || "一天内"} 停电`;
  const lines = [
    [staleHours > 0 ? "最后读数" : "当前余量", `${balance.toFixed(2)} 度`],
    t && ["预计停电", `${t} 前后${hours != null ? `（约 ${hours.toFixed(0)} 小时后）` : ""}`],
    early && early !== t && ["最早可能", early],
    mape != null && ["预测误差", `近期平均约 ±${mape}%`],
  ].filter(Boolean);
  const stale = staleHours > 0 ? `注意：电表数据已中断约 ${Math.round(staleHours)} 小时，以上是按你们寝室的用电习惯推算的。` : "";
  const unsub = env.SITE_URL ? `${env.SITE_URL.replace(/\/$/, "")}/api/unsub?u=${user.id}&s=${await unsubSig(env, user.id)}` : null;
  const text = `${name}\n${lines.map(([k, v]) => `${k}：${v}`).join("\n")}\n${stale ? "\n" + stale + "\n" : ""}\n请尽快充值。充值后余量回升，提醒会自动复位。${env.SITE_URL ? "\n" + env.SITE_URL : ""}${unsub ? `\n\n退订提醒：${unsub}` : ""}`;
  const html = layout(env, level >= 2 ? `${escHtml(name)} 即将停电` : `${escHtml(name)} 电量不足`,
    `<table style="border-collapse:collapse;width:100%">${lines.map(([k, v]) =>
      `<tr><td style="color:#8a8983;padding:4px 0;width:84px">${k}</td><td style="padding:4px 0;font-weight:500">${escHtml(v)}</td></tr>`).join("")}</table>
${stale ? `<p style="margin:12px 0 0;padding:10px 12px;background:#fdf5e6;border-radius:8px;font-size:13px">${escHtml(stale)}</p>` : ""}
<p style="margin:16px 0 0">请尽快充值。充值后余量回升，提醒会自动复位。</p>`,
    unsub ? `不想再收到？<a href="${escHtml(unsub)}" style="color:#8a8983">一键退订</a>，也可以在网站「设置」里调整。` : "不想收到这类邮件？在网站「设置」里关闭。");
  const headers = unsub ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : null;
  return { to: user.email, subject, text, html, headers };
}

export function adminMail(env, subject, text) {
  return (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((to) => ({ to, subject: `[${env.SITE_NAME || "WattWatch"} 管理] ${subject}`, text }));
}
