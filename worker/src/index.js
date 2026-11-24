// WattWatch WattWatch：宿舍电费余量追踪 / 作息感知预测 / 停电前邮件预警。
// 静态页面由 Workers Static Assets 直接返回（不计 Worker 调用次数）；只有 /api/* 进入这里。
import { json, HttpError } from "./util.js";
import { handleApi } from "./api.js";
import { handlePoller } from "./poller.js";
import { cron } from "./cron.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname.startsWith("/api/poller/")) return await handlePoller(req, env, ctx, url);
      return await handleApi(req, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e && e.stack ? e.stack : e);
      return json({ error: "服务器开小差了，请稍后再试" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env));
  },
};
