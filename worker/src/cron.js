// 定时任务（每 30 分钟）：补发邮件、数据中断时按模型推算预警、轮询器掉线告警；每天凌晨更新全校先验与误差校准、归档、清理。
import { now, getMeta, setMeta, fmtTime } from "./util.js";
import { enqueue, flushOutbox, adminMail } from "./mail.js";
import { cfg, alertDecision, queueAlerts } from "./poller.js";
import { dayStart, DAY } from "../public/js/model.js";

/**
 * 数据中断兜底：预测里的停电时刻是绝对时间，读数断了也照样会「走到」。
 * 对 90 分钟以上没有新读数、且最早停电时刻已进入预警范围的寝室，照常发预警（邮件里注明是推算）。
 */
async function deadReckoning(env) {
  const c = cfg(env), t = now();
  const { results } = await env.DB.prepare(
    // 从 users 驱动，避免全表扫描 rooms 里的全校目录（约 8400 行），见 poller.js 同名注释
    `SELECT id, build_name, room_name, forecast, balance, balance_at, alert_level FROM rooms r
     WHERE r.id IN (SELECT room_id FROM users WHERE room_id IS NOT NULL)
       AND r.forecast IS NOT NULL AND r.balance_at < ?1 AND r.alert_level < 2
       AND json_extract(r.forecast, '$.early') IS NOT NULL
       AND json_extract(r.forecast, '$.early') - ?2 <= ?3`,
  ).bind(t - 5400, t, c.threshold * 3600).all();
  const alerts = [], stmts = [];
  for (const room of results) {
    const fc = JSON.parse(room.forecast);
    const { level, want } = alertDecision(c, room.alert_level, fc, room.balance, t, false);
    if (want > level) {
      alerts.push({ room, fc, balance: room.balance, level: want, prevLevel: level, staleHours: (t - room.balance_at) / 3600 });
      stmts.push(env.DB.prepare("UPDATE rooms SET alert_level = ? WHERE id = ?").bind(want, room.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return alerts.length ? queueAlerts(env, alerts) : 0;
}

/** 全校先验画像：已有 1 天以上数据（mid/high）的寝室，各分桶用电的平均值（在 D1 里用 json_each 聚合，不占 Worker CPU） */
async function updatePrior(env) {
  const { results } = await env.DB.prepare(
    `SELECT 0 AS o, CAST(j.key AS INTEGER) AS h, AVG(j.value) AS v, COUNT(*) AS n
       FROM rooms r, json_each(r.forecast, '$.work') j
      WHERE json_extract(r.forecast, '$.confidence') IN ('mid', 'high') GROUP BY j.key
     UNION ALL
     SELECT 24, CAST(j.key AS INTEGER), AVG(j.value), COUNT(*)
       FROM rooms r, json_each(r.forecast, '$.rest') j
      WHERE json_extract(r.forecast, '$.confidence') IN ('mid', 'high') GROUP BY j.key`,
  ).all();
  const n = Math.min(...results.map((r) => r.n), Infinity);
  if (results.length !== 48 || n < 3) return null; // 样本不足 3 个寝室时不用先验（改用模型内置的兜底作息形状）
  const v = Array(48).fill(0);
  for (const r of results) v[r.o + r.h] = Math.round(r.v * 1e4) / 1e4;
  return setMeta(env, "prior", { at: now(), rooms: n, v });
}

/** 全校 24h 误差校准：近 14 天的评估汇总 */
async function updateCalib(env) {
  const r = await env.DB.prepare(
    "SELECT SUM(n) AS n, SUM(s1) AS s1, SUM(s2) AS s2, SUM(sa) AS sa FROM accuracy WHERE h = 24 AND day >= ?",
  ).bind(dayStart(now()) - 14 * DAY).first();
  if (!r || !r.n) return null;
  const mu = r.s1 / r.n;
  return setMeta(env, "calib", { at: now(), n: r.n, mu, sd: Math.sqrt(Math.max(0, r.s2 / r.n - mu * mu)), mape: r.sa / r.n });
}

async function daily(env) {
  const t = now(), today = dayStart(t);
  const stmts = [
    // 已不再轮询的寝室：把滞留的当天缓冲归档
    env.DB.prepare("INSERT OR REPLACE INTO days (room_id, day, v) SELECT id, today_day, today FROM rooms WHERE today IS NOT NULL AND today_day < ?").bind(today),
    env.DB.prepare("UPDATE rooms SET today = NULL, today_day = NULL WHERE today IS NOT NULL AND today_day < ?").bind(today),
    env.DB.prepare("DELETE FROM ratelimit WHERE reset < ?").bind(t),
    env.DB.prepare("DELETE FROM otps WHERE expires < ?").bind(t),
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(t),
    env.DB.prepare("DELETE FROM outbox WHERE created_at < ?").bind(t - 30 * DAY),
    env.DB.prepare("DELETE FROM days WHERE day < ?").bind(today - 730 * DAY),
    env.DB.prepare("DELETE FROM accuracy WHERE day < ?").bind(today - 400 * DAY),
  ];
  for (const s of [await updatePrior(env)]) if (s) stmts.push(s);
  await env.DB.batch(stmts);
}

export async function cron(env, { force = false } = {}) {
  const t = now();
  await deadReckoning(env);
  await flushOutbox(env);

  // 全校误差校准：每次 cron 都刷新（只聚合 accuracy 表，很便宜）。
  // 以前只在凌晨 4 点算，部署初期 accuracy 还是空的，后台「预测误差」要空等一整天。
  const cal = await updateCalib(env);
  if (cal) await cal.run();

  // 轮询器超过 3 小时没有成功上报：通知管理员（每次掉线只通知一次）
  const st = await getMeta(env, "poller", null);
  if (st && st.okAt && t - st.okAt > 3 * 3600 && (st.staleNotified || 0) < st.okAt) {
    const mails = adminMail(env, "轮询器掉线", `最后一次成功轮询：${fmtTime(st.okAt)}\n最近状态：${st.msg || "无"}\n\n请检查本机是否开机、网络与 cron。在此期间网站会按模型推算，照常发送停电预警。`);
    await env.DB.batch([...mails.map((m) => enqueue(env, m)), setMeta(env, "poller", { ...st, staleNotified: t })]);
    await flushOutbox(env);
  }

  // 每天凌晨 4 点左右一次
  const local = new Date((t + 8 * 3600) * 1000);
  if (force || (local.getUTCHours() === 4 && local.getUTCMinutes() < 30)) await daily(env);
}
