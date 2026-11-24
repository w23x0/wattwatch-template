#!/usr/bin/env node
// 只读检查 D1 导出快照，按时间重放预测；不连接线上服务，不修改数据库。
// node scripts/audit-data.mjs <snapshot.json> [baseline-model.mjs]
// 快照字段：rooms、days、recharges、accuracy、meta（各表 SELECT 的结果数组），可选 vars。
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as model from "../worker/public/js/model.js";

export function auditData(data, { now = Math.floor(Date.now() / 1000) } = {}) {
  const lag = +(data.vars?.METER_LAG_MIN ?? 10) * 60;
  const quality = {
    rooms: data.rooms.length, readings: 0, malformedDays: 0, wrongDay: 0, invalidReadings: 0,
    duplicateTimestamps: 0, conflictingTimestamps: 0, outOfOrder: 0, futureReadings: 0,
    missingMeterHours: 0, gapsOver48Hours: 0, sameHourChanges: 0, smallRises: 0,
    rechargeRises: 0, storedRecharges: data.recharges?.length ?? 0, staleRooms: 0,
    invalidModels: 0, invalidForecasts: 0, invalidAccuracyRows: 0,
  };
  let first = Infinity, last = -Infinity;
  const series = [];
  for (const room of data.rooms) {
    const readings = [];
    const days = data.days.filter((d) => d.room_id === room.id);
    if (room.today) days.push({ day: room.today_day, v: room.today });
    for (const d of days) {
      const pts = model.decodeDay(d.day, d.v);
      if (!pts.length) quality.malformedDays++;
      quality.wrongDay += pts.filter(([t]) => model.dayStart(t) !== d.day).length;
      readings.push(...pts);
    }
    quality.readings += readings.length;
    const seen = new Map();
    for (let i = 0; i < readings.length; i++) {
      const [t, b] = readings[i];
      if (!model.validReading(t, b)) quality.invalidReadings++;
      if (i && t < readings[i - 1][0]) quality.outOfOrder++;
      if (seen.has(t)) {
        quality.duplicateTimestamps++;
        if (seen.get(t) !== b) quality.conflictingTimestamps++;
      }
      seen.set(t, b);
      if (t > now + 600) quality.futureReadings++;
      first = Math.min(first, t); last = Math.max(last, t);
    }
    const pts = model.normalizeReadings(readings);
    for (let i = 1; i < pts.length; i++) {
      const [t, b] = pts[i], [p, a] = pts[i - 1];
      const gap = (model.meterHour(t, lag) - model.meterHour(p, lag)) / model.HOUR;
      quality.missingMeterHours += Math.max(0, gap - 1);
      if (gap > 48) quality.gapsOver48Hours++;
      if (gap === 0 && b !== a) quality.sameHourChanges++;
      if (b > a && b - a <= 0.05) quality.smallRises++;
      if (b - a > 0.05) quality.rechargeRises++;
    }
    series.push(pts);
    if (room.balance_at == null || now - room.balance_at > 3 * model.HOUR) quality.staleRooms++;
    try {
      const m = JSON.parse(room.model), clean = model.unpack(room.model);
      if (!m || m.B == null || clean.B == null ||
          Object.keys(m.acc || {}).length !== Object.keys(clean.acc).length ||
          (m.snap || []).length !== clean.snap.length) quality.invalidModels++;
    } catch { quality.invalidModels++; }
    try {
      const f = JSON.parse(room.forecast);
      if (!f || !f.ready || [f.early, f.mid, f.late].some((t) => t !== null && !Number.isFinite(t)) ||
          (f.mid !== null && (f.early === null || f.early > f.mid)) ||
          (f.late !== null && (f.mid === null || f.mid > f.late))) quality.invalidForecasts++;
    } catch { quality.invalidForecasts++; }
  }
  quality.invalidAccuracyRows = (data.accuracy || []).filter((a) =>
    ![a.n, a.s1, a.s2, a.sa].every(Number.isFinite) || a.n <= 0 || a.s2 < 0 || a.sa < 0).length;
  return { quality, period: Number.isFinite(first) ? { from: model.ymd(first), to: model.ymd(last) } : null, series };
}

/** 只用预测发出前的数据；不使用快照中由未来数据计算出的全校先验或校准。 */
export function backtest(series, vars = {}, M = model) {
  const lag = +(vars.METER_LAG_MIN ?? 10) * 60;
  const cal = M.calendar(vars.HOLIDAYS, vars.WORKDAYS);
  const scores = Object.fromEntries(M.HORIZONS.map((h) => [h, { n: 0, absoluteError: 0, actual: 0 }]));
  for (const pts of series) {
    if (!pts.length) continue;
    const m = M.newModel();
    let pending = [];
    for (const [t, b] of pts) {
      const result = M.update(m, t, b, cal, lag), T = M.meterHour(t, lag);
      if (["recharge", "gap", "invalid"].includes(result.kind)) pending = [];
      for (const p of pending) if (p.due === T) {
        const actual = Math.max(0, p.balance - b), a = scores[p.h];
        a.n++; a.absoluteError += Math.abs(actual - p.predicted); a.actual += actual;
      }
      pending = pending.filter((p) => p.due > T);
      // 一周热身，每 3 小时发出 6h/24h 预测；只结算恰好到期且中途没有充值的窗口。
      if (result.kind !== "use" || T < pts[0][0] + 7 * M.DAY || T % (3 * M.HOUR) !== 0) continue;
      const f = M.forecast(m, b, cal, { from: T });
      for (const h of M.HORIZONS) {
        let predicted = 0;
        for (let i = 0; i < h; i++) predicted += M.expectedAt(f, T + i * M.HOUR, cal);
        pending.push({ h, due: T + h * M.HOUR, balance: b, predicted });
      }
    }
  }
  return Object.fromEntries(Object.entries(scores).map(([h, a]) => [h, {
    windows: a.n,
    maeKwh: a.n ? +(a.absoluteError / a.n).toFixed(4) : null,
    wapePercent: a.actual > 0 ? +(100 * a.absoluteError / a.actual).toFixed(2) : null,
  }]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) {
    console.error("用法：node scripts/audit-data.mjs <snapshot.json> [baseline-model.mjs]");
    process.exitCode = 1;
  } else {
    const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const { quality, period, series } = auditData(data);
    const report = { quality, period, backtest: backtest(series, data.vars) };
    if (process.argv[3]) report.baseline = backtest(series, data.vars, await import(pathToFileURL(process.argv[3]).href));
    console.log(JSON.stringify(report, null, 2));
  }
}
