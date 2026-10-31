import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOUR, DAY, calendar, update, newModel, forecast, hourly, stats, meterHour, pack, unpack, isRest, hourOfDay, ymd,
  weekday, encodeDay, decodeDay, dayStart, profile, DEFAULT_PROFILE,
} from "../public/js/model.js";

const cal = calendar();
const T0 = 1790611200; // 2026-09-29 00:00 +08:00（周二）

// 典型学生作息：上课时段低、晚上高、周末白天也在宿舍
function truth(t) {
  const h = hourOfDay(t), rest = isRest(t, cal);
  if (h >= 1 && h < 7) return 0.15;
  if (h >= 19 || h < 1) return 0.9;
  if (rest) return 0.6;
  return h >= 8 && h < 17 ? 0.12 : 0.4;
}

/** 模拟学校后台：每小时 :01 刷新，读数保留 0.1 度精度；轮询在每小时 :20 */
function simulate(start, hours, balance) {
  const reads = [];
  let b = balance;
  for (let i = 0; i < hours; i++) {
    const h = start + i * HOUR;
    reads.push([h + 20 * 60, Math.round(b * 10) / 10]);
    b -= truth(h);
  }
  return { reads, end: b };
}

test("日期工具按北京时间划分", () => {
  assert.equal(ymd(T0), "2026-09-29");
  assert.equal(hourOfDay(T0 + 3 * HOUR), 3);
  assert.equal(isRest(T0 + 4 * DAY, cal), true); // 10-03 周六
  assert.equal(isRest(T0 + 4 * DAY, calendar("", "2026-10-03")), false); // 调休上班
  assert.equal(meterHour(T0 + 21 * HOUR + 60, 600), T0 + 20 * HOUR); // 21:01 读到的是 20:00
});

test("学到作息差异：夜间高峰 > 上课时段", () => {
  const m = newModel();
  const { reads } = simulate(T0, 21 * 24, 400);
  for (const [t, b] of reads) update(m, t, b, cal);
  const fc = forecast(m, 100, cal);
  assert.ok(fc.ready);
  assert.equal(fc.confidence, "high");
  assert.ok(Math.abs(fc.work[21] - 0.9) < 0.15, `工作日 21 点 ${fc.work[21]}`);
  assert.ok(Math.abs(fc.work[10] - 0.12) < 0.1, `工作日 10 点 ${fc.work[10]}`);
  assert.ok(fc.rest[14] > fc.work[14] + 0.2, "周末白天应高于工作日白天");
});

test("停电时刻预测误差 < 3 小时，且优于线性外推", () => {
  const m = newModel();
  const { reads, end } = simulate(T0, 21 * 24 + 7, 240);
  for (const [t, b] of reads) update(m, t, b, cal);
  const [lastT, lastB] = reads[reads.length - 1];
  const from = meterHour(lastT);
  const fc = forecast(m, lastB, cal, { from });

  // 真实停电时刻
  let b = lastB, h = from;
  while (b - truth(h) > 0) { b -= truth(h); h += HOUR; }
  const actual = h + (HOUR * b) / truth(h);

  const err = Math.abs(fc.mid - actual) / HOUR;
  assert.ok(err < 3, `误差 ${err.toFixed(1)}h`);
  assert.ok(fc.early <= fc.mid && fc.mid <= fc.late);

  // 旧算法：48h 首尾差线性外推
  const win = reads.filter(([t]) => t >= lastT - 48 * HOUR);
  const rate = (win[0][1] - lastB) / ((lastT - win[0][0]) / HOUR);
  const naive = lastT + (lastB / rate) * HOUR;
  const naiveErr = Math.abs(naive - actual) / HOUR;
  console.log(`  模型误差 ${err.toFixed(2)}h，旧线性外推误差 ${naiveErr.toFixed(2)}h，剩余 ${lastB}度`);
  assert.ok(err <= naiveErr, `模型 ${err.toFixed(1)}h vs 线性 ${naiveErr.toFixed(1)}h`);
  void end;
});

test("充值不污染画像，且被识别", () => {
  const m = newModel();
  const { reads } = simulate(T0, 72, 20);
  const mid = 40;
  const r = reads.map(([t, b], i) => [t, i >= mid ? b + 100 : b]);
  const kinds = r.map(([t, b]) => update(m, t, b, cal).kind);
  assert.equal(kinds.filter((k) => k === "recharge").length, 1);
  const fc = forecast(m, 100, cal);
  assert.ok(Math.max(...fc.work, ...fc.rest) < 1.5, "充值那一小时不应学成负用电/巨额用电");
});

test("近期用电整体上升时 scale > 1（例如开始开空调）", () => {
  const m = newModel();
  const { reads } = simulate(T0, 14 * 24, 400);
  for (const [t, b] of reads) update(m, t, b, cal);
  let b = reads[reads.length - 1][1];
  for (let i = 0; i < 48; i++) {
    const h = T0 + (14 * 24 + i) * HOUR;
    b -= truth(h) * 1.6;
    update(m, h + 20 * 60, Math.round(b * 10) / 10, cal);
  }
  const fc = forecast(m, b, cal);
  assert.ok(fc.scale > 1.25, `scale ${fc.scale}`);
});

test("缺采样时按画像分摊，序列化往返不变", () => {
  const m = newModel();
  const { reads } = simulate(T0, 10 * 24, 300);
  const sparse = reads.filter((_, i) => i % 3 === 0 || i > 200);
  for (const [t, b] of sparse) update(m, t, b, cal);
  const m2 = unpack(pack(m));
  const a = forecast(m, 50, cal), c = forecast(m2, 50, cal);
  assert.ok(Math.abs(a.mid - c.mid) < 60);
});

test("数据不足时给粗估而不是空白", () => {
  const m = newModel();
  update(m, T0 + 1200, 50, cal);
  update(m, T0 + HOUR + 1200, 49.8, cal);
  const fc = forecast(m, 49.8, cal); // 没有全校先验，走内置兜底形状
  assert.equal(fc.ready, true);
  assert.equal(fc.confidence, "prior");
  assert.ok(fc.mid > 0 && fc.early <= fc.mid && fc.mid <= fc.late);
  assert.equal(DEFAULT_PROFILE.length, 48);
  const avg = DEFAULT_PROFILE.reduce((a, b) => a + b, 0) / 48;
  assert.ok(Math.abs(avg - 6 / 24) < 1e-3, `兜底均值 ${avg}`);
});

test("hourly / stats：日均、周均、夜间占比", () => {
  const { reads } = simulate(T0, 28 * 24, 600);
  const { hours, recharges } = hourly(reads);
  assert.equal(recharges.length, 0);
  const now = T0 + 28 * DAY + 10 * HOUR;
  const s = stats(hours, cal, now);
  let work = 0, rest = 0;
  for (let h = 0; h < 24; h++) { work += truth(T0 + h * HOUR); rest += truth(T0 + 4 * DAY + h * HOUR); }
  assert.ok(Math.abs(s.workAvg - work) < 0.3, `工作日日均 ${s.workAvg} vs ${work}`);
  assert.ok(Math.abs(s.restAvg - rest) < 0.3, `休息日日均 ${s.restAvg} vs ${rest}`);
  assert.ok(Math.abs(s.weekAvg - (5 * work + 2 * rest)) < 1.5, `周均 ${s.weekAvg}`);
  assert.ok(s.nightShare > 0.2 && s.nightShare < 0.5);
  assert.ok(Math.abs(s.hourWork[21] - 0.9) < 0.15);
});

// 带噪声的模拟：每小时用电在真值上下 ±40% 随机波动
function noisy(start, hours, balance, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const reads = [];
  let b = balance;
  for (let i = 0; i < hours; i++) {
    const h = start + i * HOUR;
    reads.push([h + 20 * 60, Math.round(b * 100) / 100]);
    b -= truth(h) * (0.6 + 0.8 * rnd());
  }
  return reads;
}

test("weekday 与 Date 一致（快速算法）", () => {
  for (let t = T0 - 400 * DAY; t < T0 + 400 * DAY; t += 7 * HOUR) {
    assert.equal(weekday(t), new Date((t + 8 * HOUR) * 1000).getUTCDay());
    assert.equal(hourOfDay(t), new Date((t + 8 * HOUR) * 1000).getUTCHours());
  }
});

test("没有数据时用全校平均画像粗估", () => {
  const prior = Array.from({ length: 48 }, (_, k) => truth(T0 + (k < 24 ? k : 4 * 24 + k - 24) * HOUR));
  const m = newModel();
  update(m, T0 + 1200, 50, cal);
  const fc = forecast(m, 50, cal, { prior });
  assert.equal(fc.ready, true);
  assert.equal(fc.confidence, "prior");
  assert.ok(Math.abs(fc.work[21] - 0.9) < 0.01 && Math.abs(fc.rest[14] - 0.6) < 0.01, "零数据时画像=全校平均");
  // 有了本寝室数据后，水平向本寝室靠拢（本寝室用电是全校的 2 倍）
  let b = 50;
  for (let i = 1; i <= 24; i++) { b -= truth(T0 + (i - 1) * HOUR) * 2; update(m, T0 + i * HOUR + 1200, b, cal, 600, prior); }
  const p = profile(m, prior);
  assert.ok(p[21] > 1.2, `学到更高的水平 ${p[21]}`);
});

test("精度闭环：记录 24h 误差并校准区间", () => {
  const m = newModel();
  const reads = noisy(T0, 21 * 24, 600);
  let n = 0;
  for (const [t, b] of reads) n += update(m, t, b, cal).evals.length;
  assert.ok(n > 100, `评估次数 ${n}`);
  const a = m.acc[24];
  assert.ok(a && a.n >= 8);
  const fc = forecast(m, 40, cal, { from: meterHour(reads.at(-1)[0]) });
  assert.equal(fc.band.src, "room");
  assert.ok(fc.band.mape < 0.2, `24h 平均误差 ${(fc.band.mape * 100).toFixed(1)}%`);
  assert.ok(fc.early <= fc.mid && fc.mid <= fc.late);
  console.log(`  24h 平均误差 ${(fc.band.mape * 100).toFixed(1)}%，区间系数 ${fc.band.lo}~${fc.band.hi}`);
  // 序列化后统计不丢
  assert.deepEqual(Object.keys(unpack(pack(m)).acc), Object.keys(m.acc));
});

test("充值后快照作废，不产生错误评估", () => {
  const m = newModel();
  const reads = noisy(T0, 5 * 24, 300);
  for (const [t, b] of reads) update(m, t, b, cal);
  const [t, b] = reads.at(-1);
  update(m, t + HOUR, b + 80, cal);
  assert.equal(m.snap.length, 0);
});

test("读数紧凑编码往返", () => {
  const day = dayStart(T0 + 3 * DAY);
  const pts = [[day + 1234, 66.64], [day + 3600 + 1300, 66.24], [day + 7200 + 1250, 65.74], [day + 86000, 0.01]];
  const back = decodeDay(day, encodeDay(day, pts));
  assert.deepEqual(back.map(([t, b]) => [Math.round(t / 60), b]), pts.map(([t, b]) => [Math.round(t / 60), b]));
});

test("性能：单个寝室入库（解包+学习+预测+打包）< 0.2ms", () => {
  const m = newModel();
  for (const [t, b] of noisy(T0, 30 * 24, 2000)) update(m, t, b, cal);
  const s = pack(m);
  const N = 2000, t1 = T0 + 30 * 24 * HOUR + 1200;
  const st = performance.now();
  for (let i = 0; i < N; i++) {
    const mm = unpack(s);
    update(mm, t1, mm.B - 0.3, cal);
    JSON.stringify(forecast(mm, 1500, cal, { from: meterHour(t1) })); // 大余量 = 最长模拟
    pack(mm);
  }
  const per = (performance.now() - st) / N;
  console.log(`  每寝室 ${per.toFixed(3)} ms，模型 ${s.length} 字节`);
  assert.ok(per < 0.2);
});
