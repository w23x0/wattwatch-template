// 定时任务（每 30 分钟）：补发邮件、数据中断时按模型推算预警、轮询器掉线告警；每天凌晨更新全校先验与误差校准、归档、清理。
import { now, getMeta, setMeta, fmtTime, advanceRoomVersion, isRoomWriteConflict } from "./util.js";
import { enqueue, flushOutbox, adminMail } from "./mail.js";
import { cfg, alertDecision, prepareAlert } from "./poller.js";
import { dayStart, DAY } from "../public/js/model.js";

/**
 * 数据中断兜底：预测里的停电时刻是绝对时间，读数断了也照样会「走到」。
 * 对 90 分钟以上没有新读数、且最早停电时刻已进入预警范围的寝室，照常发预警（邮件里注明是推算）。
 */
async function deadReckoning(env) {
  const c = cfg(env), t = now();
  const { results } = await env.DB.prepare(
    // 从 users 驱动，避免全表扫描 rooms 里的全校目录（约 8400 行），见 poller.js 同名注释
    `SELECT id, build_name, room_name, forecast, balance, balance_at, alert_level, write_version FROM rooms r
     WHERE r.id IN (SELECT room_id FROM users WHERE room_id IS NOT NULL)
       AND r.forecast IS NOT NULL AND r.balance_at < ?1 AND r.alert_level < 2
       AND json_extract(r.forecast, '$.early') IS NOT NULL
       AND json_extract(r.forecast, '$.early') - ?2 <= ?3`,
  ).bind(t - 5400, t, c.threshold * 3600).all();
  for (const room of results) {
    const fc = JSON.parse(room.forecast);
    const { level, want } = alertDecision(c, room.alert_level, fc, room.balance, t, false);
    if (want <= level) continue;
    const mail = await prepareAlert(env, { room, fc, balance: room.balance, level: want, staleHours: (t - room.balance_at) / 3600 });
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE rooms SET alert_level = ?, ${advanceRoomVersion} WHERE id = ?`)
          .bind(want, room.write_version, room.id),
        ...mail,
      ]);
    } catch (e) {
      if (!isRoomWriteConflict(e)) throw e;
      // 有较新的读数或告警处理接管了此寝室，下一次定时任务按最新状态判断。
    }
  }
}

/** 全校先验画像：已有 1 天以上数据（mid/high）的寝室，各分桶用电的平均值。
 *  单个寝室的异常读数会把全校先验拉偏，进而让新寝室的「粗估」预测失真；
 *  因此先按寝室日用电总量的对数做稳健离群点剔除（中位数 + MAD，modified z-score > 3.5 剔除），
 *  再对剩余寝室逐桶取算术平均。剔除后样本仍不足 3 间时回退到全部样本。
 *  用对数而不是原始值：用电量是乘性分布，0.7 度和 15 度同样「偏」，线性 MAD 在样本少时会把前者漏掉。 */
async function updatePrior(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.forecast FROM rooms r
      WHERE r.id IN (SELECT room_id FROM users WHERE room_id IS NOT NULL) AND r.balance_at >= ?
        AND json_extract(r.forecast, '$.confidence') IN ('mid', 'high')`
  ).bind(now() - 3 * DAY).all();
  const rooms = [];
  for (const r of results) {
    let f;
    try { f = JSON.parse(r.forecast); } catch { continue; }
    if (!f || ![f.work, f.rest].every((a) => Array.isArray(a) && a.length === 24 &&
      a.every((v) => Number.isFinite(v) && v >= 0))) continue;
    const total = f.work.reduce((a, b) => a + b, 0) + f.rest.reduce((a, b) => a + b, 0);
    rooms.push({ f, score: Math.log(total + 0.1) });
  }
  if (rooms.length < 3) return env.DB.prepare("DELETE FROM meta WHERE k = 'prior'");
  // 稳健离群点剔除：按 log(日用电总量) 的 modified z-score
  const scores = rooms.map((r) => r.score).slice().sort((a, b) => a - b);
  const median = scores.length % 2
    ? scores[(scores.length - 1) / 2]
    : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;
  const devs = rooms.map((r) => Math.abs(r.score - median)).slice().sort((a, b) => a - b);
  const mad = devs.length % 2
    ? devs[(devs.length - 1) / 2]
    : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
  let kept = rooms;
  if (mad > 0) {
    const filtered = rooms.filter((r) => (0.6745 * Math.abs(r.score - median)) / mad <= 3.5);
    if (filtered.length >= 3) kept = filtered;
  }
  const n = kept.length;
  const v = Array(48).fill(0);
  for (let i = 0; i < 24; i++) {
    let sw = 0, sr = 0;
    for (const r of kept) { sw += r.f.work[i]; sr += r.f.rest[i]; }
    v[i] = Math.round((sw / n) * 1e4) / 1e4;
    v[24 + i] = Math.round((sr / n) * 1e4) / 1e4;
  }
  return setMeta(env, "prior", { at: now(), rooms: n, v });
}

/** 全校误差校准：近 14 天的评估汇总。24h 给出误差带与平均误差，72h（long）只用来收窄多天后的区间。 */
async function updateCalib(env) {
  const { results } = await env.DB.prepare(
    "SELECT h, SUM(n) AS n, SUM(s1) AS s1, SUM(s2) AS s2, SUM(sa) AS sa FROM accuracy WHERE h IN (24, 72) AND day >= ? GROUP BY h",
  ).bind(dayStart(now()) - 14 * DAY).all();
  const stat = (r) => {
    const mu = r.s1 / r.n;
    return { n: r.n, mu, sd: Math.sqrt(Math.max(0, r.s2 / r.n - mu * mu)), mape: r.sa / r.n };
  };
  const r24 = results.find((r) => r.h === 24 && r.n), r72 = results.find((r) => r.h === 72 && r.n);
  if (!r24) return env.DB.prepare("DELETE FROM meta WHERE k = 'calib'");
  return setMeta(env, "calib", { at: now(), ...stat(r24), ...(r72 ? { long: stat(r72) } : {}) });
}

async function daily(env) {
  const t = now(), today = dayStart(t);
  const stmts = [
    // 已不再轮询的寝室：把滞留的当天缓冲归档
    env.DB.prepare("INSERT OR REPLACE INTO days (room_id, day, v) SELECT id, today_day, today FROM rooms WHERE today IS NOT NULL AND today_day < ?").bind(today),
    env.DB.prepare("UPDATE rooms SET today = NULL, today_day = NULL, write_version = write_version + 1 WHERE today IS NOT NULL AND today_day < ?").bind(today),
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
  try {
    await deadReckoning(env);
  } finally {
    await flushOutbox(env);
  }

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
