// 本地轮询器专用接口（Bearer POLLER_TOKEN）：取待查寝室、上报读数、同步寝室目录、上报健康状态、导入旧数据。
import { now, json, fail, body, safeEqual, getMeta, setMeta, alertCooling, advanceRoomVersion, isRoomWriteConflict, pollerFailText } from "./util.js";
import { enqueue, flushOutbox, adminMail, alertMail } from "./mail.js";
import { calendar, unpack, pack, update, forecast, meterHour, dayStart, encodeDay, decodeDay, normalizeReadings, validReading, DAY } from "../public/js/model.js";

const RECHARGE_MIN_KWH = 1;

export const cfg = (env) => ({
  cal: calendar(env.HOLIDAYS, env.WORKDAYS),
  lag: +(env.METER_LAG_MIN || 10) * 60,
  cutoff: +(env.CUTOFF_KWH || 0),
  threshold: +(env.THRESHOLD_HOURS || 24),
  urgent: +(env.URGENT_HOURS || 6),
  low: +(env.LOW_KWH || 3),
});

/** 全校先验画像与误差校准（由定时任务每天更新） */
export async function shared(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('prior', 'calib')").all();
  const o = {};
  for (const r of results) {
    try { o[r.k] = JSON.parse(r.v); } catch { /* 损坏的共享缓存退回本寝室模型。 */ }
  }
  return { prior: o.prior && o.prior.v, calib: o.calib };
}

function authorize(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!env.POLLER_TOKEN || !safeEqual(h.replace(/^Bearer\s+/i, ""), env.POLLER_TOKEN)) fail(401, "unauthorized");
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** 预警状态机：0 -> 1(24h) -> 2(临停)；充值或预测明显好转时复位。返回 {level, want} */
export function alertDecision(c, prevLevel, fc, balance, t0, recharged) {
  let level = prevLevel || 0;
  const hoursEarly = fc && fc.ready && fc.early != null ? (fc.early - t0) / 3600 : null;
  if (recharged || (hoursEarly != null && hoursEarly > c.threshold * 2 && balance > c.low)) level = 0;
  let want = 0;
  if ((hoursEarly != null && hoursEarly <= c.urgent) || balance <= c.cutoff + 0.5) want = 2;
  else if ((hoursEarly != null && hoursEarly <= c.threshold) || balance <= c.low) want = 1;
  return { level, want };
}

/** 和寝室告警等级在同一批事务提交，失败时两者一起回滚。 */
export async function prepareAlert(env, { room, fc, balance, level, staleHours }) {
  const key = `alerted:${room.id}`, t = now();
  if (alertCooling(await getMeta(env, key, null), level, t)) return [];
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email FROM users u JOIN rooms r ON r.id = u.room_id
     WHERE u.room_id = ? AND u.alert_unsubscribed = 0
     AND CASE WHEN ? = 2 THEN r.notify_urgent ELSE r.notify_alerts END = 1`,
  ).bind(room.id, level).all();
  if (!results.length) return [];
  const mails = await Promise.all(results.map(async (u) => enqueue(env, await alertMail(env, u, room, fc, balance, level, staleHours))));
  return [...mails, setMeta(env, key, { level, at: t })];
}

/**
 * 写入读数并增量更新模型、预测与预警状态。
 * reads: [{id, t, b}]；silent=true 时不发邮件（导入历史时用）。
 * 写入量：每寝室每次 1 行（rooms），跨天时再加 1 行（days 归档）。
 */
export async function ingest(env, ctx, reads, { silent = false } = {}) {
  const c = cfg(env);
  const t0 = now();
  const byRoom = new Map();
  for (const r of reads) {
    if (!r || typeof r !== "object") continue;
    const { id, t, b } = r;
    if (!Number.isSafeInteger(id) || id <= 0 || !validReading(t, b)) continue;
    if (!(t > t0 - 400 * DAY && t < t0 + 600)) continue;
    if (!byRoom.has(id)) byRoom.set(id, []);
    byRoom.get(id).push([t, b]);
  }
  if (!byRoom.size) return { rooms: 0, alerts: 0 };

  const { prior, calib } = await shared(env);
  const rooms = [];
  for (const ids of chunk([...byRoom.keys()], 90)) {
    rooms.push(...await readRooms(env, ids));
  }
  // 实时上报允许近期乱序读数补进历史。静默导入仍跳过数据库已有的时间范围。
  for (const room of rooms) {
    const cutoff = silent ? (room.balance_at || 0) : t0 - 3 * 3600;
    byRoom.set(room.id, normalizeReadings(byRoom.get(room.id))
      .filter(([t]) => t > Math.min(cutoff, room.balance_at || 0) && t !== room.balance_at));
  }

  let processed = 0, triggers = 0, queued = false;
  for (let group of chunk(rooms.filter((room) => byRoom.get(room.id).length), 25)) {
    for (let attempt = 0; ; attempt++) {
      const writes = [];
      for (const room of group) {
        const write = await prepareReadings(env, room, byRoom.get(room.id), { c, t0, prior, calib, silent });
        if (write) writes.push(write);
      }
      if (!writes.length) break;
      try {
        await env.DB.batch(writes.flatMap((write) => write.stmts));
        processed += writes.length;
        triggers += writes.filter((write) => write.triggered).length;
        queued ||= writes.some((write) => write.queued);
        break;
      } catch (e) {
        if (!isRoomWriteConflict(e)) throw e;
        if (attempt >= 2) fail(503, "读数正在并发写入，请重试");
        group = await readRooms(env, group.map((room) => room.id));
      }
    }
  }
  if (queued) ctx.waitUntil(flushOutbox(env));
  return { rooms: processed, alerts: triggers };
}

async function readRooms(env, ids) {
  const { results } = await env.DB.prepare(
    `SELECT id, build_name, room_name, model, alert_level, balance_at, today, today_day, write_version
     FROM rooms WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all();
  return results;
}

async function prepareReadings(env, room, readings, { c, t0, prior, calib, silent }) {
  const fresh = readings.filter(([t]) => t > (room.balance_at || 0));
  const history = readings.filter(([t]) => t !== room.balance_at);
  const { stmts, day, today, changed } = await prepareHistory(env, room, history, fresh.at(-1), t0);
  if (!fresh.length) {
    if (!changed) return null;
    stmts.unshift(env.DB.prepare(`UPDATE rooms SET today = ?, today_day = ?, ${advanceRoomVersion} WHERE id = ?`)
      .bind(today, day, room.write_version, room.id));
    return { stmts };
  }

  const m = unpack(room.model), acc = new Map();
  let recharged = false;
  for (const [t, b] of fresh) {
    const r = update(m, t, b, c.cal, c.lag, prior);
    if (r.kind === "recharge") {
      // 小幅读数抖动不复位预警，至少回升 1 度才复位。
      if (r.amount >= RECHARGE_MIN_KWH) recharged = true;
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO recharges (room_id, t, kwh) VALUES (?, ?, ?)")
        .bind(room.id, t, Math.round(r.amount * 100) / 100));
    }
    for (const e of r.evals) {
      // 极端误差只保留在本寝室统计中。
      if (!Number.isFinite(e.r) || Math.abs(e.r) > 3) continue;
      const day = dayStart(e.t), key = `${day}:${e.h}`;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { day, h: e.h, n: 0, s1: 0, s2: 0, sa: 0 }));
      a.n++; a.s1 += e.r; a.s2 += e.r * e.r; a.sa += Math.abs(e.r);
    }
  }

  const [lt, lb] = fresh.at(-1);
  const fc = forecast(m, lb, c.cal, { from: meterHour(lt, c.lag), cutoff: c.cutoff, prior, calib });
  const { level, want } = alertDecision(c, room.alert_level, fc, lb, t0, recharged);
  const triggered = !silent && want > level && lt > t0 - 3 * 3600;
  const newLevel = silent ? room.alert_level : triggered ? want : level;
  const mail = triggered ? await prepareAlert(env, { room, fc, balance: lb, level: want }) : [];
  stmts.unshift(env.DB.prepare(
    `UPDATE rooms SET balance = ?, balance_at = ?, model = ?, forecast = ?, alert_level = ?, today = ?, today_day = ?,
     poll_error = NULL, poll_error_at = NULL, ${advanceRoomVersion} WHERE id = ?`,
  ).bind(lb, lt, pack(m), fc ? JSON.stringify(fc) : null, newLevel, today, day, room.write_version, room.id));

  for (const a of acc.values()) {
    stmts.push(env.DB.prepare(
      `INSERT INTO accuracy (day, h, n, s1, s2, sa) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(day, h) DO UPDATE SET n = n + ?3, s1 = s1 + ?4, s2 = s2 + ?5, sa = sa + ?6`,
    ).bind(a.day, a.h, a.n, a.s1, a.s2, a.sa));
  }
  return { stmts: [...stmts, ...mail], triggered, queued: mail.length > 0 };
}

async function prepareHistory(env, room, readings, latest, t0) {
  const days = new Map(), stmts = [];
  const day = latest ? dayStart(latest[0]) : room.today_day;
  let today = room.today, changed = false;
  if (room.today && room.today_day !== day) days.set(room.today_day, []);
  for (const point of readings) {
    const d = dayStart(point[0]);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(point);
  }
  for (const [d, incoming] of days) {
    let saved = d === room.today_day ? room.today : null;
    if (!saved && d < dayStart(t0)) {
      const archived = await env.DB.prepare("SELECT v FROM days WHERE room_id = ? AND day = ?").bind(room.id, d).first();
      saved = archived?.v;
    }
    const points = saved ? decodeDay(d, saved) : [];
    const minutes = new Set(points.map(([t]) => Math.floor(t / 60)));
    for (const point of incoming) {
      // 同一分钟已保存的读数不因并发重试而重复写入。
      if (point[0] < room.balance_at && minutes.has(Math.floor(point[0] / 60))) continue;
      points.push(point);
      changed = true;
    }
    if (!points.length) continue;
    points.sort((a, b) => a[0] - b[0]);
    const encoded = encodeDay(d, points);
    if (d === day) today = encoded;
    else stmts.push(env.DB.prepare("INSERT OR REPLACE INTO days (room_id, day, v) VALUES (?, ?, ?)").bind(room.id, d, encoded));
  }
  return { stmts, day, today, changed };
}

/** 重建目录摘要（校区 -> 楼栋），存 meta 供前端一次读取 */
async function rebuildDir(env) {
  const { results } = await env.DB.prepare(
    `SELECT item_id, area_id, area_name, build_id, build_name, COUNT(*) AS n FROM rooms
     GROUP BY item_id, area_id, build_id ORDER BY area_name, length(build_name), build_name`,
  ).all();
  const areas = [];
  for (const r of results) {
    const key = `${r.item_id}:${r.area_id}`;
    let a = areas.find((x) => x.id === key);
    if (!a) areas.push((a = { id: key, name: r.area_name, builds: [] }));
    a.builds.push({ id: r.build_id, name: r.build_name, n: r.n });
  }
  await setMeta(env, "dir", { at: now(), areas }).run();
  return areas.length;
}

/**
 * 导入历史：直接走 ingest 的时间顺序处理（自动归档到 days、重放模型、不发邮件）。
 * 每次最多 100 条，由轮询器分块按时间先后调用；早于已有数据的读数会被忽略。
 */
async function importHistory(env, ctx, id, readings) {
  if (readings.length > 100) fail(413, "每次最多导入 100 条，请分块");
  const pts = normalizeReadings(readings).map(([t, b]) => ({ id, t, b }));
  return ingest(env, ctx, pts, { silent: true });
}

export async function handlePoller(req, env, ctx, url) {
  authorize(req, env);
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/poller/rooms") {
    const onlyNew = url.searchParams.get("new") === "1";
    // ⚠️ 必须从 users 驱动（IN 子查询 + users_room 索引），让 SQLite 走 rooms 主键点查。
    // rooms 表存的是全校目录（约 8400 行），只有极少数有注册成员；若写成
    // `FROM rooms r WHERE EXISTS(... users ...)` 会全表扫描 rooms，而本接口每天被
    // 调 700+ 次（每小时全量 + 每 2 分钟 --new），几天就能打爆 D1 免费读额度（500 万行/天）。
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.item_id, r.ptype, r.area_id, r.build_id, r.room_ext_id, r.build_name, r.room_name FROM rooms r
       WHERE r.id IN (SELECT room_id FROM users WHERE room_id IS NOT NULL)
       ${onlyNew ? "AND r.balance_at IS NULL AND (r.poll_error_at IS NULL OR r.poll_error_at < ?)" : ""}
       ORDER BY r.id`,
    ).bind(...(onlyNew ? [now() - 3600] : [])).all();
    return json({ rooms: results });
  }

  if (req.method === "POST" && p === "/api/poller/ingest") {
    const b = await body(req, 256 * 1024);
    const readings = Array.isArray(b.readings) ? b.readings : [];
    if (readings.length > 100) fail(413, "单批最多 100 条（Worker 免费计划每次请求只有 10ms CPU）");
    const res = await ingest(env, ctx, readings);
    const errs = (Array.isArray(b.errors) ? b.errors : []).slice(0, 100);
    if (errs.length) {
      await env.DB.batch(errs.map((e) => env.DB.prepare("UPDATE rooms SET poll_error = ?, poll_error_at = ? WHERE id = ?")
        .bind(String(e.msg || "error").slice(0, 200), now(), +e.id)));
    }
    return json({ ok: true, ...res });
  }

  if (req.method === "POST" && p === "/api/poller/directory") {
    const b = await body(req, 2 * 1024 * 1024);
    const keys = ["item_id", "ptype", "item_name", "area_id", "area_name", "build_id", "build_name", "room_id", "room_name"];
    const rows = (Array.isArray(b.rooms) ? b.rooms : []).filter((r) => keys.every((k) => r[k] != null && String(r[k]).length <= 64));
    for (const part of chunk(rows, 100)) {
      await env.DB.batch(part.map((r) => env.DB.prepare(
        `INSERT INTO rooms (item_id, ptype, item_name, area_id, area_name, build_id, build_name, room_ext_id, room_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(item_id, area_id, build_id, room_ext_id) DO UPDATE SET ptype = ?2, item_name = ?3, area_name = ?5, build_name = ?7, room_name = ?9
         WHERE ptype != ?2 OR item_name != ?3 OR area_name != ?5 OR build_name != ?7 OR room_name != ?9`,
      ).bind(...keys.map((k) => String(r[k]).trim()))));
    }
    const areas = b.done ? await rebuildDir(env) : undefined;
    return json({ ok: true, upserted: rows.length, areas });
  }

  if (req.method === "POST" && p === "/api/poller/status") {
    const b = await body(req);
    const prev = await getMeta(env, "poller", {});
    const st = {
      at: now(), ok: !!b.ok, msg: String(b.msg || "").slice(0, 300), polled: +b.polled || 0, failed: +b.failed || 0,
      tokenAge: b.tokenAge == null ? null : +b.tokenAge, tokenFp: String(b.tokenFp || "").slice(0, 32),
    };
    const t = st.at;
    const stmts = [];
    // 轮询器整体失败：12 小时内只通知管理员一次；失败原因按实际错误给出排查方向
    const notifyFail = !st.ok && t - (prev.notifiedAt || 0) > 12 * 3600;
    if (notifyFail) {
      const text = pollerFailText(st, t);
      for (const m of adminMail(env, "轮询失败", text)) stmts.push(enqueue(env, m));
    }
    // token 有效期约 30 天：用到第 25 天时提醒一次（每个 token 只提醒一次）
    const notifyAge = st.tokenAge != null && st.tokenAge >= 25 && st.tokenFp && prev.ageNotifiedFp !== st.tokenFp;
    if (notifyAge) {
      for (const m of adminMail(env, "校园卡 token 即将过期", `当前 token 已使用 ${st.tokenAge.toFixed(1)} 天（有效期约 30 天）。\n请在过期前重新抓取并更新本机 token 文件，避免轮询中断。`)) stmts.push(enqueue(env, m));
    }
    stmts.unshift(setMeta(env, "poller", {
      ...st,
      okAt: st.ok ? t : prev.okAt || 0,
      notifiedAt: notifyFail ? t : prev.notifiedAt || 0,
      ageNotifiedFp: notifyAge ? st.tokenFp : prev.ageNotifiedFp || "",
      staleNotified: prev.staleNotified || 0,
    }));
    await env.DB.batch(stmts);
    if (stmts.length > 1) ctx.waitUntil(flushOutbox(env));
    return json({ ok: true });
  }

  if (req.method === "POST" && p === "/api/poller/import") {
    const b = await body(req, 2 * 1024 * 1024);
    const conds = ["build_name = ?", "room_name = ?"], args = [String(b.build_name), String(b.room_name)];
    if (b.area_name) { conds.push("trim(area_name) = ?"); args.push(String(b.area_name).trim()); }
    if (b.item_id) { conds.push("item_id = ?"); args.push(String(b.item_id)); }
    const { results } = await env.DB.prepare(`SELECT id FROM rooms WHERE ${conds.join(" AND ")}`).bind(...args).all();
    if (results.length !== 1) fail(404, `找到 ${results.length} 个匹配寝室，请先同步目录或指定 area_name / item_id`);
    const id = results[0].id;
    const res = await importHistory(env, ctx, id, Array.isArray(b.readings) ? b.readings : []);
    return json({ ok: true, room: id, ...res });
  }

  fail(404, "not found");
}
