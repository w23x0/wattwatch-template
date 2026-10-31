// 面向用户的接口：登录、账号、寝室成员、读数、管理员。
import { now, json, fail, body, limit, maskEmail, getMeta, num } from "./util.js";
import { normEmail, sendCode, checkCode, createSession, clearCookie, session, logout, isAdmin } from "./auth.js";
import { enqueue, flushOutbox, unsubSig } from "./mail.js";
import { cfg } from "./poller.js";
import { decodeDay, dayStart, DAY } from "../public/js/model.js";
import { handleAdmin } from "./admin.js";

/** 电价（元/度）：PRICE 可以是一个数，或按购电项的 JSON，如 {"1":0.56,"5":0.6} */
function priceOf(env, itemId) {
  const raw = (env.PRICE || "").trim();
  if (!raw) return null;
  if (/^[\d.]+$/.test(raw)) return +raw;
  try { const v = JSON.parse(raw)[itemId]; return v == null ? null : +v; } catch { return null; }
}

const MAX_MEMBERS = 4;

async function roomView(env, user) {
  if (!user.room_id) return null;
  const room = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(user.room_id).first();
  if (!room) return null;
  const { results: members } = await env.DB.prepare(
    "SELECT id, email, joined_at, alerts, urgent FROM users WHERE room_id = ? ORDER BY joined_at, id",
  ).bind(room.id).all();
  const { results: recharges } = await env.DB.prepare(
    "SELECT t, kwh FROM recharges WHERE room_id = ? ORDER BY t DESC LIMIT 20",
  ).bind(room.id).all();
  return {
    id: room.id,
    area: room.area_name.trim(), build: room.build_name, name: room.room_name,
    price: priceOf(env, room.item_id),
    recharges,
    // 没有寝室长：寝室里人人平等，谁都能加人/移除/改提醒
    members: members.map((m) => ({
      id: m.id, me: m.id === user.id, joinedAt: m.joined_at, email: m.email,
    })),
    // 提醒是寝室级的：开关一次，四个人一起生效
    notify: { alerts: members.length > 0 && members.every((m) => m.alerts), urgent: members.length > 0 && members.every((m) => m.urgent) },
    balance: room.balance, balanceAt: room.balance_at,
    forecast: room.forecast ? JSON.parse(room.forecast) : null,
    alertLevel: room.alert_level,
    pollError: room.poll_error, pollErrorAt: room.poll_error_at,
  };
}

async function me(env, user) {
  const poller = await getMeta(env, "poller", null);
  return {
    user: { id: user.id, email: user.email, alerts: !!user.alerts, urgent: !!user.urgent, admin: isAdmin(env, user.email) },
    room: await roomView(env, user),
    poller: poller ? { at: poller.at, ok: poller.ok, okAt: poller.okAt } : null,
  };
}

/** 加入寝室：直接选房间即可，不再需要邀请码；换寝室即加入新的 */
async function joinRoom(env, user, b) {
  await limit(env, `join:${user.id}`, 20, 3600, "尝试太频繁，请稍后再试");
  const room = await env.DB.prepare("SELECT id FROM rooms WHERE id = ?").bind(+b.roomId || 0).first();
  if (!room) fail(404, "寝室不存在");
  if (room.id === user.room_id) return;

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE room_id = ?").bind(room.id).first();
  if (n >= MAX_MEMBERS) fail(409, `该寝室已满 ${MAX_MEMBERS} 人`);

  const t = now();
  const old = user.room_id;
  const res = await env.DB.batch([
    // 条件更新防并发超员
    env.DB.prepare(`UPDATE users SET room_id = ?1, joined_at = ?2 WHERE id = ?3
                    AND (SELECT COUNT(*) FROM users WHERE room_id = ?1) < ${MAX_MEMBERS}`).bind(room.id, t, user.id),
    ...(old ? [clearEmpty(env, old)] : []),
  ]);
  if (!res[0].meta.changes) fail(409, `该寝室已满 ${MAX_MEMBERS} 人`);
}

const clearEmpty = (env, roomId) =>
  env.DB.prepare("UPDATE rooms SET invite = NULL WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM users WHERE room_id = ?1)").bind(roomId);

async function readings(env, user, url) {
  if (!user.room_id) fail(400, "还没有选择寝室");
  const t = now();
  const to = Math.min(num(url.searchParams.get("to"), t), t + 3600);
  const from = Math.max(num(url.searchParams.get("from"), to - 35 * DAY), to - 400 * DAY);
  const [{ results }, room] = await Promise.all([
    env.DB.prepare("SELECT day, v FROM days WHERE room_id = ? AND day BETWEEN ? AND ? ORDER BY day")
      .bind(user.room_id, dayStart(from), to).all(),
    env.DB.prepare("SELECT today, today_day FROM rooms WHERE id = ?").bind(user.room_id).first(),
  ]);
  const pts = results.flatMap((r) => decodeDay(r.day, r.v));
  if (room && room.today) pts.push(...decodeDay(room.today_day, room.today));
  const out = pts.filter(([x]) => x >= from && x <= to).sort((p, q) => p[0] - q[0]);
  return json({ from, to, readings: out }, 200, { "cache-control": "private, max-age=60" });
}

/** 邮件里的退订链接：GET 显示确认页，POST（页面按钮或邮件客户端一键退订）执行 */
async function unsubscribe(req, env, url) {
  const uid = +url.searchParams.get("u");
  const ok = Number.isInteger(uid) && uid > 0 && (url.searchParams.get("s") || "") === (await unsubSig(env, uid));
  const page = (msg, btn) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>退订提醒</title><body style="font:15px/1.6 -apple-system,'PingFang SC',sans-serif;background:#f6f5f1;color:#161614;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="background:#fff;border:1px solid #e7e5de;border-radius:14px;padding:24px;max-width:340px;margin:16px"><p style="margin:0 0 16px">${msg}</p>${btn
    ? `<form method="post"><button style="height:44px;width:100%;border:0;border-radius:12px;background:#161614;color:#fff;font-size:15px">确认退订</button></form>` : ""}
<p style="margin:16px 0 0;font-size:13px"><a href="/" style="color:#55544f">打开网站</a></p></div>`,
    { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
  if (!ok) return page("链接无效或已过期。", false);
  if (req.method === "GET") return page("退订后将不再收到停电预警和临停提醒邮件，之后可以在网站「设置」里重新开启。", true);
  if (req.method !== "POST") fail(405, "method not allowed");
  await env.DB.prepare("UPDATE users SET alerts = 0, urgent = 0 WHERE id = ?").bind(uid).run();
  return page("已退订。需要时可以在网站「设置」里重新开启。", false);
}

export async function handleApi(req, env, ctx, url) {
  const p = url.pathname, m = req.method;

  if (m === "GET" && p === "/api/config") {
    const c = cfg(env);
    return json({
      siteName: env.SITE_NAME || "WattWatch",
      turnstile: env.TURNSTILE_SITE_KEY || null,
      threshold: c.threshold, urgent: c.urgent, lag: c.lag, cutoff: c.cutoff,
      holidays: env.HOLIDAYS || "", workdays: env.WORKDAYS || "",
      maxMembers: MAX_MEMBERS,
    }, 200, { "cache-control": "public, max-age=300" });
  }

  if (p === "/api/unsub") return unsubscribe(req, env, url);

  // 同源校验：所有写操作必须来自本站页面（配合 SameSite=Lax cookie 防 CSRF）
  if (m !== "GET" && req.headers.get("origin") !== url.origin) fail(403, "forbidden");

  if (m === "POST" && p === "/api/auth/send") {
    const b = await body(req);
    await sendCode(env, req, { email: normEmail(b.email, env), purpose: "login", turnstile: b.turnstile });
    return json({ ok: true });
  }

  if (m === "POST" && p === "/api/auth/verify") {
    const b = await body(req);
    const email = normEmail(b.email, env);
    await checkCode(env, email, "login", b.code);
    const user = await env.DB.prepare(
      "INSERT INTO users (email, created_at) VALUES (?1, ?2) ON CONFLICT(email) DO UPDATE SET email = email RETURNING id",
    ).bind(email, now()).first();
    return json({ ok: true }, 200, { "set-cookie": await createSession(env, user.id) });
  }

  if (m === "POST" && p === "/api/auth/logout") {
    await logout(env, req);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  // ---- 以下需要登录 ----
  const s = await session(env, req);
  if (!s) fail(401, "请先登录");
  const user = s.user;
  const extra = s.refresh ? { "set-cookie": s.refresh } : {};
  const ok = (data = { ok: true }) => json(data, 200, extra);

  if (m === "GET" && p === "/api/me") return ok(await me(env, user));

  if (m === "POST" && p === "/api/me/email/send") {
    const b = await body(req);
    const email = normEmail(b.email, env);
    if (email === user.email) fail(400, "这就是你当前的邮箱");
    await limit(env, `chg:${user.id}`, 10, 3600); // 防止借此枚举已注册邮箱
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "该邮箱已被其他账号绑定");
    await sendCode(env, req, { email, purpose: "change", userId: user.id, turnstile: b.turnstile });
    return ok();
  }

  if (m === "POST" && p === "/api/me/email/verify") {
    const b = await body(req);
    const email = normEmail(b.email, env);
    const row = await checkCode(env, email, "change", b.code);
    if (row.user_id !== user.id) fail(400, "验证码不属于当前账号");
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, user.id),
        // 其它设备上的会话全部下线
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, s.sid),
        enqueue(env, { to: user.email, subject: "你的绑定邮箱已更换", text: `你的账号绑定邮箱已更换为 ${maskEmail(email)}。\n如非本人操作，请立即用新邮箱登录检查，或联系管理员。` }),
      ]);
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) fail(409, "该邮箱已被其他账号绑定");
      throw e;
    }
    ctx.waitUntil(flushOutbox(env));
    return ok();
  }

  if (m === "POST" && p === "/api/me/delete") {
    const b = await body(req);
    if (b.confirm !== "删除") fail(400, "请输入「删除」确认");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
      ...(user.room_id ? [clearEmpty(env, user.room_id)] : []),
    ]);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  if (m === "GET" && p === "/api/dir") {
    return ok((await getMeta(env, "dir", { areas: [] })));
  }

  if (m === "GET" && p === "/api/dir/rooms") {
    const [item, area] = (url.searchParams.get("area") || "").split(":");
    const build = url.searchParams.get("build") || "";
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.room_name AS name, (SELECT COUNT(*) FROM users u WHERE u.room_id = r.id) AS n
       FROM rooms r WHERE r.item_id = ? AND r.area_id = ? AND r.build_id = ? ORDER BY length(r.room_name), r.room_name`,
    ).bind(item || "", area || "", build).all();
    return json({ rooms: results }, 200, { ...extra, "cache-control": "private, max-age=60" });
  }

  if (m === "POST" && p === "/api/room/join") {
    await joinRoom(env, user, await body(req));
    return ok(await me(env, { ...user, ...(await env.DB.prepare("SELECT room_id FROM users WHERE id = ?").bind(user.id).first()) }));
  }

  if (m === "POST" && p === "/api/room/leave") {
    if (!user.room_id) return ok();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET room_id = NULL, joined_at = NULL WHERE id = ?").bind(user.id),
      clearEmpty(env, user.room_id),
    ]);
    return ok();
  }

  if (m === "POST" && p === "/api/room/kick") {
    const b = await body(req);
    const view = await roomView(env, user);
    if (!view) fail(400, "还没有选择寝室");
    const target = view.members.find((x) => x.id === +b.userId && !x.me);
    if (!target) fail(404, "成员不存在");
    await env.DB.prepare("UPDATE users SET room_id = NULL, joined_at = NULL WHERE id = ? AND room_id = ?")
      .bind(target.id, view.id).run();
    return ok(await me(env, user));
  }

  // 按邮箱加人：对方不用先注册也会收到停电提醒，之后用这个邮箱登录即可看到寝室
  if (m === "POST" && p === "/api/room/members/add") {
    const b = await body(req);
    const view = await roomView(env, user);
    if (!view) fail(400, "还没有选择寝室");
    const email = normEmail(b.email, env);
    if (view.members.length >= MAX_MEMBERS) fail(409, `寝室最多 ${MAX_MEMBERS} 人`);
    if (view.members.some((x) => x.email === email)) fail(409, "这个邮箱已经在寝室里了");
    const t = now();
    let res;
    try {
      res = await env.DB.prepare(
        `INSERT INTO users (email, room_id, joined_at, created_at) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(email) DO UPDATE SET room_id = ?2, joined_at = ?3 WHERE users.room_id IS NULL`,
      ).bind(email, view.id, t).run();
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) fail(409, "该邮箱已在其他寝室");
      throw e;
    }
    if (!res.meta.changes) fail(409, "该邮箱已加入其他寝室");
    return ok(await me(env, user));
  }

  // 提醒是寝室级的：一次开关，四个人都按这个来
  if (m === "POST" && p === "/api/room/settings") {
    const b = await body(req);
    const view = await roomView(env, user);
    if (!view) fail(400, "还没有选择寝室");
    await env.DB.prepare("UPDATE users SET alerts = ?, urgent = ? WHERE room_id = ?")
      .bind(b.alerts === false ? 0 : 1, b.urgent === false ? 0 : 1, view.id).run();
    return ok(await me(env, user));
  }

  if (m === "GET" && p === "/api/room/readings") return readings(env, user, url);

  // ---- 管理员 ----
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(env, user.email)) fail(403, "forbidden");
    const res = await handleAdmin(req, env, url);
    if (res) return res;
  }

  fail(404, "not found");
}
