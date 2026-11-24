#!/usr/bin/env node
// 本地预览：用真实的 public/js/model.js 现算 30 天合成读数，喂给真正的前端静态文件。
// 不需要部署、不碰 D1、不发邮件。用来改界面时看效果、重拍 README 的演示截图。
//
//   node scripts/preview-demo.mjs [port]      # 默认 8788
//
// 截图约定（重拍 docs/template/screenshot.png 时）：430px 宽、DPR 2、整页；
// 拍照前把 .top 设成 position: static（吸顶栏在整页截图里会串位）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOUR, DAY, calendar, update, newModel, forecast } from "../worker/public/js/model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../worker/public");
const PORT = +(process.argv[2] || 8788);
const TZ = 8 * HOUR;
const LAG = 600;

const cal = calendar("2026-10-01,2026-10-02,2026-10-03", "2026-10-11");
const shape = [0.55, 0.4, 0.35, 0.35, 0.35, 0.4, 0.5, 0.7, 0.6, 0.5, 0.45, 0.5, 0.75, 0.8, 0.6, 0.55, 0.6, 0.85, 1.1, 1.5, 1.6, 1.5, 1.2, 0.85];
const unit = 15 / shape.reduce((a, b) => a + b, 0);      // 约 15 度/天
const nowT = Math.floor(Date.now() / 1000);
const startHour = Math.floor((nowT - 30 * DAY) / HOUR) * HOUR;
const lastHour = Math.floor(nowT / HOUR) * HOUR - HOUR;

let bal = 360, seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const readings = [];
for (let h = startHour; h <= lastHour; h += HOUR) {
  const hod = (((h + TZ) % DAY) + DAY) % DAY / HOUR;
  const off = h - startHour;
  if (off === 5 * DAY) bal += 80;
  if (off === 24 * DAY) bal += 50;
  bal -= Math.max(0, shape[hod] * unit * (0.85 + rand() * 0.3));
  readings.push([h + LAG + 1500, Math.round(bal * 100) / 100]);
}
// 再补一条几分钟前的读数：顶栏的「更新 N 分钟前」才像个活的页面
readings.push([nowT - 300, Math.round((bal - 0.12) * 100) / 100]);

// 用真实的增量模型学一遍再预测，和 Worker 走同一条路径
const m = newModel();
for (const [t, b] of readings) update(m, t, b, cal, LAG);
const balance = readings[readings.length - 1][1];
const balanceAt = readings[readings.length - 1][0];
const fc = forecast(m, balance, cal, { from: m.T, cutoff: 0 });

const demo = {
  user: { id: 1, email: "101@qq.com", alerts: true, urgent: true, admin: false },
  room: {
    id: 1, area: "示例校区", build: "1 栋", name: "101", price: 0.56, recharges: [],
    members: [{ id: 1, me: true, email: "101@qq.com" }, { id: 2, me: false, email: "roomie@qq.com" }],
    notify: { alerts: true, urgent: true },
    balance, balanceAt, forecast: fc, alertLevel: null, pollError: null, pollErrorAt: null,
  },
};
const config = {
  siteName: "WattWatch", turnstile: null, threshold: 24, urgent: 6, lag: LAG, cutoff: 0,
  holidays: "2026-10-01,2026-10-02,2026-10-03", workdays: "2026-10-11", maxMembers: 4,
};

const TYPE = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const json = (res, data) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`), p = url.pathname;
  if (p === "/api/config") return json(res, config);
  if (p === "/api/me") return json(res, { ...demo, poller: { at: nowT - 300, ok: true, okAt: nowT - 300 } });
  if (p === "/api/room/readings") {
    const to = Math.min(+(url.searchParams.get("to") || nowT), nowT + 3600);
    const from = Math.max(+(url.searchParams.get("from") || to - 35 * DAY), to - 400 * DAY);
    return json(res, { from, to, readings: readings.filter(([t]) => t >= from && t <= to) });
  }
  if (p.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"not found"}'); }
  let file = path.join(ROOT, p === "/" ? "/index.html" : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  res.writeHead(200, { "content-type": TYPE[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`演示数据 · http://127.0.0.1:${PORT}  （${readings.length} 条读数，余量 ${balance} 度）`);
});
