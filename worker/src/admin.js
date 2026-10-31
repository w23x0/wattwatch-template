// 管理员接口（/api/admin/*）：概况、用户、寝室、充值、邮件、运行状态，以及少量运维操作。
// 调用方（api.js）已校验过管理员身份。
import { now, json, fail, body, getMeta, num } from "./util.js";
import { flushOutbox } from "./mail.js";
import { cfg } from "./poller.js";
import { cron } from "./cron.js";
import { dayStart, DAY, band } from "../public/js/model.js";

const PAGE = 30;
const LOW_KWH = 10; // 「余量偏低」榜的阈值（度）
const STALE_SEC = 3 * 3600; // 有人在用的寝室超过这么久没新读数，算数据过期

const offsetOf = (url) => Math.max(0, Math.floor(num(url.searchParams.get("offset"), 0)));
const qOf = (url) => (url.searchParams.get("q") || "").trim().slice(0, 30);
/** LIKE 模式：转义 % _，配合 ESCAPE '\' */
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/** 有成员（正在被使用）的寝室条件 */
const OCCUPIED = "EXISTS (SELECT 1 FROM users u WHERE u.room_id = r.id)";

async function accuracyHistory(env) {
  const { results } = await env.DB.prepare(
    "SELECT day, h, n, s1, sa FROM accuracy WHERE day >= ? ORDER BY day",
  ).bind(dayStart(now()) - 60 * DAY).all();
  return results.map((r) => ({ day: r.day, h: r.h, n: r.n, mape: Math.exp(r.sa / r.n) - 1, bias: Math.exp(r.s1 / r.n) - 1 }));
}

/** 把 (第几天, 值) 的稀疏结果补成连续 days 天的数组 */
function series(rows, days, field) {
  const out = Array(days).fill(0);
  for (const r of rows) if (r.i >= 0 && r.i < days) out[r.i] = r[field];
  return out;
}

export async function overview(env) {
  const t = now(), lo = dayStart(t) - 13 * DAY;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();
  const [users, rooms, otp, outbox, signups, recharge, poller, dir, calib, prior] = await Promise.all([
    q(`SELECT COUNT(*) AS total, COALESCE(SUM(room_id IS NULL), 0) AS no_room,
              COALESCE(SUM(COALESCE(login_at, 0) >= ?1), 0) AS d7, COALESCE(SUM(COALESCE(login_at, 0) >= ?2), 0) AS d30,
              COALESCE(SUM(alerts = 0 AND urgent = 0), 0) AS muted,
              (SELECT COUNT(*) FROM sessions WHERE expires > ?3) AS sessions FROM users`, t - 7 * DAY, t - 30 * DAY, t),
    q(`SELECT (SELECT COUNT(*) FROM rooms) AS total, COUNT(*) AS used,
              COALESCE(SUM(alert_level = 1), 0) AS a1, COALESCE(SUM(alert_level = 2), 0) AS a2,
              COALESCE(SUM(COALESCE(balance_at, 0) < ?1), 0) AS stale, COALESCE(SUM(poll_error IS NOT NULL), 0) AS err,
              COALESCE(SUM(balance < ?2), 0) AS low
         FROM rooms r WHERE ${OCCUPIED}`, t - STALE_SEC, LOW_KWH),
    q("SELECT n, reset FROM ratelimit WHERE k = 'otp:global'"),
    q(`SELECT COALESCE(SUM(sent_at IS NULL AND tries < 5), 0) AS pending, COALESCE(SUM(sent_at IS NULL AND tries >= 5), 0) AS failed,
              COALESCE(SUM(sent_at >= ?1), 0) AS sent24 FROM outbox`, t - DAY),
    env.DB.prepare("SELECT CAST((created_at - ?1) / 86400 AS INTEGER) AS i, COUNT(*) AS n FROM users WHERE created_at >= ?1 GROUP BY i").bind(lo).all(),
    env.DB.prepare("SELECT CAST((t - ?1) / 86400 AS INTEGER) AS i, SUM(kwh) AS kwh, COUNT(*) AS n FROM recharges WHERE t >= ?1 GROUP BY i").bind(lo).all(),
    getMeta(env, "poller", null),
    getMeta(env, "dir", null),
    getMeta(env, "calib", null),
    getMeta(env, "prior", null),
  ]);
  return {
    users: { total: users.total, noRoom: users.no_room, d7: users.d7, d30: users.d30, muted: users.muted, sessions: users.sessions },
    rooms: { total: rooms.total, used: rooms.used, alert1: rooms.a1, alert2: rooms.a2, stale: rooms.stale, error: rooms.err, low: rooms.low },
    lowKwh: LOW_KWH,
    otp: { today: otp && otp.reset > t ? otp.n : 0, cap: +(env.OTP_DAILY_CAP || 300) },
    outbox: { pending: outbox.pending, failed: outbox.failed, sent24: outbox.sent24 },
    days: { from: lo, signups: series(signups.results, 14, "n"), recharge: series(recharge.results, 14, "kwh"), rechargeN: series(recharge.results, 14, "n") },
    poller, dirAt: dir ? dir.at : null,
    calib, priorRooms: (prior || {}).rooms || 0,
    // 全校层面**实际生效**的误差带（含「calib.n >= 30 才启用」和限幅规则）。
    // 直接拿 calib 的 mu/sd 算原始倍率会误导：样本少时模型根本不看 calib。
    band: band(null, calib),
    accuracy: await accuracyHistory(env),
  };
}

async function users(env, url) {
  const t = now(), conds = ["1"], args = [];
  const f = url.searchParams.get("filter") || "all";
  if (f === "noroom") conds.push("u.room_id IS NULL");
  else if (f === "muted") conds.push("(u.alerts = 0 OR u.urgent = 0)");
  else if (f === "recent") conds.push(`COALESCE(u.login_at, 0) >= ${t - 7 * DAY}`);
  else if (f === "never") conds.push("u.login_at IS NULL");
  const q = qOf(url);
  if (q) { conds.push("(u.email LIKE ? ESCAPE '\\' OR (r.build_name || ' ' || r.room_name) LIKE ? ESCAPE '\\')"); args.push(like(q), like(q)); }
  const where = conds.join(" AND ");
  const from = "FROM users u LEFT JOIN rooms r ON r.id = u.room_id";
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.room_id, u.joined_at, u.alerts, u.urgent, u.created_at, u.login_at,
              trim(r.area_name) AS area, r.build_name AS build, r.room_name AS room,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires > ${t}) AS sessions
       ${from} WHERE ${where} ORDER BY u.id DESC LIMIT ${PAGE} OFFSET ${offsetOf(url)}`,
    ).bind(...args).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).bind(...args).first(),
  ]);
  return { users: results, total: total.n, page: PAGE };
}

const roomViews = () => ({
  used: { cond: OCCUPIED, order: "n DESC, r.id" },
  low: { cond: `${OCCUPIED} AND r.balance IS NOT NULL`, order: "r.balance ASC" },
  stale: { cond: `${OCCUPIED} AND COALESCE(r.balance_at, 0) < ${now() - STALE_SEC}`, order: "COALESCE(r.balance_at, 0) ASC" },
  error: { cond: "r.poll_error IS NOT NULL", order: "r.poll_error_at DESC" },
  alert: { cond: "r.alert_level > 0", order: "r.alert_level DESC, r.balance ASC" },
  all: { cond: "1", order: "r.id" },
});

async function rooms(env, url) {
  const views = roomViews();
  const view = views[url.searchParams.get("view")] || views.used;
  const q = qOf(url);
  const where = `${view.cond}${q ? " AND (r.build_name || ' ' || r.room_name) LIKE ? ESCAPE '\\'" : ""}`;
  const args = q ? [like(q)] : [];
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, trim(r.area_name) AS area, r.build_name AS build, r.room_name AS name, r.balance, r.balance_at,
              r.alert_level AS alert, r.poll_error AS error, r.poll_error_at AS error_at,
              json_extract(r.forecast, '$.confidence') AS conf, json_extract(r.forecast, '$.early') AS early,
              (SELECT COUNT(*) FROM users u WHERE u.room_id = r.id) AS n
       FROM rooms r WHERE ${where} ORDER BY ${view.order} LIMIT ${PAGE} OFFSET ${offsetOf(url)}`,
    ).bind(...args).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM rooms r WHERE ${where}`).bind(...args).first(),
  ]);
  return { rooms: results, total: total.n, page: PAGE };
}

async function room(env, url) {
  const id = +url.searchParams.get("id") || 0;
  const r = await env.DB.prepare(
    `SELECT id, trim(area_name) AS area, build_name AS build, room_name AS name, item_name, balance, balance_at,
            alert_level AS alert, poll_error AS error, poll_error_at AS error_at, forecast FROM rooms WHERE id = ?`,
  ).bind(id).first();
  if (!r) fail(404, "寝室不存在");
  const [members, recharges, cover] = await Promise.all([
    env.DB.prepare("SELECT id, email, joined_at, alerts, urgent, login_at FROM users WHERE room_id = ? ORDER BY joined_at, id").bind(id).all(),
    env.DB.prepare("SELECT t, kwh FROM recharges WHERE room_id = ? ORDER BY t DESC LIMIT 10").bind(id).all(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(day) AS first FROM days WHERE room_id = ?").bind(id).first(),
  ]);
  let fc = null;
  try { fc = r.forecast ? JSON.parse(r.forecast) : null; } catch { /* 忽略损坏的缓存 */ }
  delete r.forecast;
  return {
    room: r, members: members.results, recharges: recharges.results,
    forecast: fc && { ready: fc.ready, confidence: fc.confidence, early: fc.early, mid: fc.mid, late: fc.late },
    days: cover.n, firstDay: cover.first,
  };
}

async function recharges(env, url) {
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT c.t, c.kwh, trim(r.area_name) AS area, r.build_name AS build, r.room_name AS name, r.id AS room_id
       FROM recharges c JOIN rooms r ON r.id = c.room_id ORDER BY c.t DESC LIMIT ${PAGE} OFFSET ${offsetOf(url)}`,
    ).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM recharges").first(),
  ]);
  return { recharges: results, total: total.n, page: PAGE };
}

async function mail(env, url) {
  const f = url.searchParams.get("status") || "all";
  const where = { pending: "sent_at IS NULL AND tries < 5", failed: "sent_at IS NULL AND tries >= 5", sent: "sent_at IS NOT NULL" }[f] || "1";
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT id, to_addr, subject, created_at, tries, sent_at, error FROM outbox WHERE ${where}
       ORDER BY id DESC LIMIT ${PAGE} OFFSET ${offsetOf(url)}`,
    ).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE ${where}`).first(),
  ]);
  return { mails: results, total: total.n, page: PAGE };
}

/** 运行状态：配置自检（只给「是否已配置」，不给任何密钥）、限流计数、各表行数 */
async function system(env) {
  const t = now(), c = cfg(env);
  const count = async (tbl) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first()).n;
  const [poller, dir, calib, prior, limits, ...counts] = await Promise.all([
    getMeta(env, "poller", null), getMeta(env, "dir", null), getMeta(env, "calib", null), getMeta(env, "prior", null),
    env.DB.prepare("SELECT k, n, reset FROM ratelimit WHERE reset > ? ORDER BY n DESC LIMIT 15").bind(t).all(),
    ...["users", "rooms", "days", "recharges", "accuracy", "sessions", "outbox"].map(count),
  ]);
  const tables = Object.fromEntries(["users", "rooms", "days", "recharges", "accuracy", "sessions", "outbox"].map((k, i) => [k, counts[i]]));
  return {
    poller, dirAt: dir ? dir.at : null, calibAt: calib ? calib.at : null, priorAt: prior ? prior.at : null, priorRooms: (prior || {}).rooms || 0,
    limits: limits.results,
    tables,
    config: {
      secrets: Object.fromEntries(["POLLER_TOKEN", "OTP_PEPPER", "SMTP_PASS", "TURNSTILE_SECRET"].map((k) => [k, !!env[k]])),
      smtp: !!env.SMTP_USER && !!env.MAIL_FROM && env.SMTP_USER === env.MAIL_FROM,
      turnstile: !!env.TURNSTILE_SITE_KEY, price: !!(env.PRICE || "").trim(),
      admins: (env.ADMIN_EMAILS || "").split(",").filter((s) => s.trim()).length,
      threshold: c.threshold, urgent: c.urgent, cutoff: c.cutoff, otpCap: +(env.OTP_DAILY_CAP || 300),
    },
  };
}

/** 返回 Response；不属于管理员接口则返回 null */
export async function handleAdmin(req, env, url) {
  const p = url.pathname, m = req.method;
  const ok = (data = { ok: true }) => json(data);

  if (m === "GET") {
    if (p === "/api/admin/stats") return ok(await overview(env));
    if (p === "/api/admin/users") return ok(await users(env, url));
    if (p === "/api/admin/rooms") return ok(await rooms(env, url));
    if (p === "/api/admin/room") return ok(await room(env, url));
    if (p === "/api/admin/recharges") return ok(await recharges(env, url));
    if (p === "/api/admin/mail") return ok(await mail(env, url));
    if (p === "/api/admin/mail/item") {
      const r = await env.DB.prepare("SELECT text FROM outbox WHERE id = ?").bind(+url.searchParams.get("id") || 0).first();
      if (!r) fail(404, "邮件不存在（可能已过 30 天被清理）");
      return ok({ text: r.text });
    }
    if (p === "/api/admin/system") return ok(await system(env));
    // 旧版面板用的查寝室接口，保留
    if (p === "/api/admin/find") {
      const q = qOf(url);
      const { results } = await env.DB.prepare(
        `SELECT r.id, trim(r.area_name) AS area, r.build_name AS build, r.room_name AS name, r.balance, r.poll_error AS error,
                (SELECT COUNT(*) FROM users u WHERE u.room_id = r.id) AS n
         FROM rooms r WHERE (r.build_name || ' ' || r.room_name) LIKE ? ESCAPE '\\' ORDER BY n DESC LIMIT 20`,
      ).bind(like(q)).all();
      return ok({ rooms: results });
    }
  }

  if (m === "POST") {
    if (p === "/api/admin/recalc") {
      await cron(env, { force: true }); // 立即重算全校先验与误差校准
      return ok(await overview(env));
    }
    if (p === "/api/admin/room/clear") {
      const b = await body(req);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET room_id = NULL, joined_at = NULL WHERE room_id = ?").bind(+b.roomId),
        env.DB.prepare("UPDATE rooms SET invite = NULL, alert_level = 0 WHERE id = ?").bind(+b.roomId),
      ]);
      return ok();
    }
    if (p === "/api/admin/user/kick") {
      const b = await body(req);
      const u = await env.DB.prepare("SELECT room_id FROM users WHERE id = ?").bind(+b.userId).first();
      if (!u) fail(404, "用户不存在");
      if (!u.room_id) return ok();
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET room_id = NULL, joined_at = NULL WHERE id = ?").bind(+b.userId),
        // 寝室空了：预警等级复位，下一批人入住后重新计
        env.DB.prepare("UPDATE rooms SET invite = NULL, alert_level = 0 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM users WHERE room_id = ?1)").bind(u.room_id),
      ]);
      return ok();
    }
    if (p === "/api/admin/user/logout") {
      const b = await body(req);
      const r = await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(+b.userId).run();
      return ok({ ok: true, removed: r.meta.changes });
    }
    if (p === "/api/admin/mail/retry") {
      const b = await body(req);
      // 把重试次数用尽的邮件重新放回队列（指定 id 或全部失败），然后立刻发一批
      const r = b.id
        ? await env.DB.prepare("UPDATE outbox SET tries = 0 WHERE id = ? AND sent_at IS NULL AND tries >= 5").bind(+b.id).run()
        : await env.DB.prepare("UPDATE outbox SET tries = 0 WHERE sent_at IS NULL AND tries >= 5").run();
      const sent = await flushOutbox(env);
      return ok({ ok: true, requeued: r.meta.changes, sent });
    }
  }
  return null;
}
