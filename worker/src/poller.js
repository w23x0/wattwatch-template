// 本地轮询器专用接口（Bearer POLLER_TOKEN）：取待查寝室、上报读数、同步寝室目录、上报健康状态、导入旧数据。
import { now, json, fail, body, safeEqual, getMeta, setMeta, alertCooling, pollerFailText } from "./util.js";
import { enqueue, flushOutbox, adminMail, alertMail } from "./mail.js";
import { calendar, unpack, pack, update, forecast, meterHour, dayStart, encodeDay, decodeDay, DAY } from "../public/js/model.js";

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
  const o = Object.fromEntries(results.map((r) => [r.k, JSON.parse(r.v)]));
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

/** 给寝室成员排队发预警邮件 */
export async function queueAlerts(env, alerts) {
  const mails = [], t = now();
  let sent = 0;
  for (const a of alerts) {
    // 冷却：刚给这个寝室发过同级或更高级的提醒，就不再发（状态机复位后又触发、读数抖动等都会被挡住）
    const key = `alerted:${a.room.id}`;
    if (alertCooling(await getMeta(env, key, null), a.level, t)) continue;
    const { results } = await env.DB.prepare("SELECT id, email, alerts, urgent FROM users WHERE room_id = ?").bind(a.room.id).all();
    let n = 0;
    for (const u of results) {
      if (!u.alerts || (a.level >= 2 && !u.urgent && a.prevLevel >= 1)) continue;
      mails.push(enqueue(env, await alertMail(env, u, a.room, a.fc, a.balance, a.level, a.staleHours)));
      n++;
    }
    sent += n;
    if (n) mails.push(setMeta(env, key, { level: a.level, at: t }));
  }
  if (mails.length) await env.DB.batch(mails);
  return sent;
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
    const id = +r.id, t = Math.floor(+r.t), b = +r.b;
    if (!Number.isInteger(id) || !Number.isFinite(b) || b < -1000 || b > 1e5) continue;
    if (!(t > t0 - 400 * DAY && t < t0 + 600)) continue;
    if (!byRoom.has(id)) byRoom.set(id, []);
    byRoom.get(id).push([t, b]);
  }
  if (!byRoom.size) return { rooms: 0, alerts: 0 };

  const { prior, calib } = await shared(env);
  const rooms = [];
  for (const ids of chunk([...byRoom.keys()], 90)) {
    const { results } = await env.DB.prepare(
      `SELECT id, build_name, room_name, model, alert_level, balance_at, today, today_day FROM rooms WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all();
    rooms.push(...results);
  }

  const stmts = [], alerts = [], acc = {};
  for (const room of rooms) {
    // 只处理比已有读数更新的，避免重复上报被当成「充值」
    const fresh = byRoom.get(room.id).sort((a, b) => a[0] - b[0]).filter(([t]) => t > (room.balance_at || 0));
    if (!fresh.length) continue;

    const m = unpack(room.model);
    let recharged = false;
    for (const [t, b] of fresh) {
      const r = update(m, t, b, c.cal, c.lag, prior);
      if (r.kind === "recharge") {
        // 电表读数偶尔会往上抖一点点，不能当成充值去复位预警；真充值至少 1 度
        if (r.amount >= RECHARGE_MIN_KWH) recharged = true;
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO recharges (room_id, t, kwh) VALUES (?, ?, ?)").bind(room.id, t, Math.round(r.amount * 100) / 100));
      }
      for (const e of r.evals) {
        const a = acc[e.h] || (acc[e.h] = { n: 0, s1: 0, s2: 0, sa: 0 });
        a.n++; a.s1 += e.r; a.s2 += e.r * e.r; a.sa += Math.abs(e.r);
      }
    }

    // 当天读数缓冲：跨天时把前一天归档成 days 的一行
    let day = room.today_day, pts = room.today ? decodeDay(room.today_day, room.today) : [];
    for (const [t, b] of fresh) {
      const d = dayStart(t);
      if (day != null && d !== day && pts.length) {
        stmts.push(env.DB.prepare("INSERT OR REPLACE INTO days (room_id, day, v) VALUES (?, ?, ?)").bind(room.id, day, encodeDay(day, pts)));
        pts = [];
      }
      day = d;
      pts.push([t, b]);
    }

    const [lt, lb] = fresh[fresh.length - 1];
    const fc = forecast(m, lb, c.cal, { from: meterHour(lt, c.lag), cutoff: c.cutoff, prior, calib });
    const { level, want } = alertDecision(c, room.alert_level, fc, lb, t0, recharged);
    let newLevel = level;
    if (want > level) {
      if (!silent && lt > t0 - 3 * 3600) alerts.push({ room, fc, balance: lb, level: want, prevLevel: level });
      newLevel = want;
    }
    stmts.push(env.DB.prepare(
      `UPDATE rooms SET balance = ?, balance_at = ?, model = ?, forecast = ?, alert_level = ?, today = ?, today_day = ?,
       poll_error = NULL, poll_error_at = NULL WHERE id = ?`,
    ).bind(lb, lt, pack(m), fc ? JSON.stringify(fc) : null, newLevel, encodeDay(day, pts), day, room.id));
  }

  const today = dayStart(t0);
  for (const [h, a] of Object.entries(acc)) {
    stmts.push(env.DB.prepare(
      `INSERT INTO accuracy (day, h, n, s1, s2, sa) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(day, h) DO UPDATE SET n = n + ?3, s1 = s1 + ?4, s2 = s2 + ?5, sa = sa + ?6`,
    ).bind(today, +h, a.n, a.s1, a.s2, a.sa));
  }
  for (const part of chunk(stmts, 50)) await env.DB.batch(part);

  let sent = 0;
  if (alerts.length) {
    sent = await queueAlerts(env, alerts);
    if (sent) ctx.waitUntil(flushOutbox(env));
  }
  return { rooms: rooms.length, alerts: alerts.length };
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
  const pts = readings.map(([t, b]) => ({ id, t: Math.floor(+t), b: +b })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.b));
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
