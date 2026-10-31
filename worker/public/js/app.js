// WattWatch 前端：登录 -> 选寝室 -> 看板。无框架、无构建，ES Module 直接运行。
import { HOUR, DAY, calendar, dayStart, weekday, hourOfDay } from "./model.js";
import { accuracyChart, fmtDate } from "./charts.js";
import { mountHistory } from "./history.js";

// ---------- 小工具 ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
/** 模板：插值默认转义；嵌套 html`` 或数组原样拼接 */
const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => {
  if (i >= vals.length) return a + s;
  const v = vals[i];
  const out = v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("") : v === false || v == null ? "" : esc(v);
  return a + s + out;
}, ""));
const now = () => Math.floor(Date.now() / 1000);
const WD = "日一二三四五六";
const pad2 = (n) => String(n).padStart(2, "0");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 大数字从 0 涨到目标（只对纯数字；尊重 prefers-reduced-motion） */
function countUp(el, target) {
  if (!el || reduced() || document.hidden || !/^\d+(\.\d+)?$/.test(target)) return;
  const to = +target, dec = (target.split(".")[1] || "").length, t0 = performance.now(), dur = 560;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(dec);
    if (p < 1) requestAnimationFrame(tick); else el.textContent = target;
  };
  requestAnimationFrame(tick);
  // 兜底：切后台/切页时 rAF 会暂停，不能让数字卡在中间值
  setTimeout(() => { el.textContent = target; }, dur + 150);
}

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `请求失败（${r.status}）`); e.status = r.status; e.data = j; throw e; }
  return j;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast" + (err ? " err" : "")), 2600);
}
/** 包装按钮动作：禁用、错误提示 */
async function busy(btn, fn) {
  if (btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); throw e; } finally { btn.disabled = false; btn.innerHTML = label; }
}

function rel(t, exact = false) {
  const tt = exact ? t : Math.round(t / HOUR) * HOUR;
  const diff = Math.round((dayStart(tt) - dayStart(now())) / DAY);
  const d = new Date((tt + 8 * 3600) * 1000);
  const day = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : diff < 7 && diff > 0 ? `周${WD[weekday(tt)]}` : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  const h = hourOfDay(tt);
  if (exact) return `${day} ${pad2(h)}:${pad2(d.getUTCMinutes())}`;
  const seg = h < 5 ? "凌晨" : h < 8 ? "早上" : h < 11 ? "上午" : h < 13 ? "中午" : h < 18 ? "下午" : "晚上";
  const h12 = h > 12 ? h - 12 : h;
  return `${day}${seg} ${h12} 点`;
}
function ago(t) {
  const s = now() - t;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return fmtDate(t);
}
const fmt = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));

// ---------- 状态 ----------
const S = {
  config: null, cal: null, me: null,
  readings: [], loadedFrom: null, readingsDone: false, fullHistory: false, readingsRoom: null,
  observers: [], timer: null,
};

const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

// ---------- 页面骨架 ----------
function shell() {
  return html`
<header class="top" id="top"><div class="wrap">
  <a class="brand" href="#">${S.config.siteName}</a>
  <div class="mini" id="mini" aria-hidden="true"></div>
</div></header>
<main id="main"></main>
<footer><div class="wrap">非学校官方服务</div></footer>`;
}

function mount(mainHtml) {
  for (const o of S.observers) o.disconnect();
  S.observers = [];
  $("#app").innerHTML = shell().s;
  const host = $("#main");
  host.innerHTML = mainHtml.s;
  // 入场动效：各区块错峰上浮（prefers-reduced-motion 时跳过）
  const wrap = host.firstElementChild;
  if (wrap && !reduced()) [...wrap.children].forEach((el, i) => { el.style.setProperty("--i", i); el.classList.add("enter"); });
  window.scrollTo(0, 0);
}

// ---------- 登录 ----------
let tsWidget = null, tsToken = null;
function loadTurnstile(box) {
  if (!S.config.turnstile) return;
  const render = () => {
    tsWidget = window.turnstile.render(box, {
      sitekey: S.config.turnstile, language: "zh-cn", appearance: "interaction-only", theme: "light",
      callback: (t) => (tsToken = t), "expired-callback": () => (tsToken = null),
    });
  };
  if (window.turnstile) return render();
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async = true;
  s.onload = render;
  document.head.appendChild(s);
}
const resetTurnstile = () => { if (window.turnstile && tsWidget != null) { window.turnstile.reset(tsWidget); tsToken = null; } };

function viewLogin() {
  mount(html`
<div class="wrap"><section class="gate">
  <h1>登录</h1>
  <p class="tag">QQ 邮箱验证码登录，首次即注册</p>
  <form id="f-email" novalidate>
    <div class="field-row">
      <input class="input" id="email" type="text" inputmode="email" autocomplete="email" placeholder="QQ 邮箱" aria-label="QQ 邮箱" required>
      <span class="suffix" id="suffix">@qq.com</span>
      <button class="arrow" id="send" aria-label="获取验证码">${new Raw(ARROW)}</button>
    </div>
    <div id="ts"></div>
  </form>
  <form id="f-code" novalidate hidden>
    <div class="field-row">
      <input class="input code" id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="验证码" aria-label="验证码" required>
      <button class="arrow" id="verify" aria-label="登录">${new Raw(ARROW)}</button>
    </div>
    <p class="hint" id="sentto"></p>
    <div class="row" style="gap:18px"><button type="button" class="link" id="back">换邮箱</button><button type="button" class="link" id="resend" disabled>重发</button></div>
  </form>
</section></div>`);

  const email = $("#email"), suffix = $("#suffix");
  email.addEventListener("input", () => (suffix.hidden = email.value.includes("@")));
  loadTurnstile($("#ts"));
  let addr = "", cdTimer;
  const countdown = () => {
    const b = $("#resend");
    let cd = 60;
    b.disabled = true;
    clearInterval(cdTimer);
    cdTimer = setInterval(() => {
      cd--; b.textContent = cd > 0 ? `重发 ${cd}` : "重发";
      if (cd <= 0) { b.disabled = false; clearInterval(cdTimer); }
    }, 1000);
  };
  const send = (btn) => busy(btn, async () => {
    addr = email.value.trim();
    await api("/api/auth/send", { email: addr, turnstile: tsToken });
    resetTurnstile();
    $("#f-email").hidden = true; $("#f-code").hidden = false;
    $("#sentto").textContent = addr.includes("@") ? addr : addr + "@qq.com";
    $("#code").focus();
    countdown();
  }).catch(() => resetTurnstile());
  $("#f-email").addEventListener("submit", (e) => { e.preventDefault(); send($("#send")); });
  $("#resend").addEventListener("click", () => { $("#f-code").hidden = true; $("#f-email").hidden = false; send($("#send")); });
  $("#back").addEventListener("click", () => { $("#f-code").hidden = true; $("#f-email").hidden = false; email.focus(); });
  const verify = () => busy($("#verify"), async () => {
    await api("/api/auth/verify", { email: addr, code: $("#code").value.trim() });
    clearInterval(cdTimer);
    await reload();
  }).catch(() => {});
  $("#f-code").addEventListener("submit", (e) => { e.preventDefault(); verify(); });
  $("#code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); if (e.target.value.length === 6) verify(); });
}

// ---------- 选寝室 ----------
async function viewPicker() {
  mount(html`
<section class="wrap pickhead">
  <h1>选择寝室</h1>
  <div id="browse">
    <div class="step" id="areastep"><span class="lbl">校区</span><div class="tabs" id="areas"></div></div>
    <div class="step"><span class="lbl">楼栋</span><div class="grid b" id="builds"></div></div>
    <div class="step" id="roomstep" hidden>
      <div class="lbl-row"><span class="lbl">房间</span><input class="input" id="q" style="height:30px;max-width:120px;font-size:13px" placeholder="搜索" inputmode="numeric"></div>
      <div class="grid r" id="rooms"></div>
    </div>
  </div>
  <div class="confirm" id="confirm" hidden></div>
</section>`);

  const joined = async (res) => {
    S.me = res;
    toast(`${res.room.build} ${res.room.name}`);
    route();
    if (!res.room.balanceAt) awaitFirstRead();  // 等本机 poller 补读到第一个数
  };
  const dir = await api("/api/dir");
  if (!dir.areas.length) { $("#browse").innerHTML = `<p class="muted" style="margin-top:40px">目录尚未同步</p>`; return; }
  let area = dir.areas[0].id, rooms = [];
  $("#areas").innerHTML = dir.areas.map((a) => html`<button data-id="${a.id}">${a.name}</button>`.s).join("");
  if (dir.areas.length === 1) $("#areastep").hidden = true;
  const showRooms = () => {
    const q = $("#q").value.trim();
    const list = rooms.filter((r) => !q || r.name.includes(q));
    $("#rooms").innerHTML = list.map((r) => html`<button class="pick" data-id="${r.id}" ${r.n >= S.config.maxMembers ? new Raw("disabled") : ""}>
      <b>${r.name}</b><small>${r.n ? `${r.n}/${S.config.maxMembers}` : ""}&nbsp;</small></button>`.s).join("");
  };
  const showBuilds = () => {
    $$("#areas button").forEach((x) => x.classList.toggle("on", x.dataset.id === area));
    const a = dir.areas.find((x) => x.id === area);
    $("#builds").innerHTML = a.builds.map((b) => html`<button class="pick" data-id="${b.id}"><b>${b.name}</b></button>`.s).join("");
    $("#roomstep").hidden = true; $("#confirm").hidden = true;
  };
  $("#areas").onclick = (e) => { const b = e.target.closest("button"); if (b) { area = b.dataset.id; showBuilds(); } };
  $("#builds").onclick = async (e) => {
    const b = e.target.closest(".pick"); if (!b) return;
    $$("#builds .pick").forEach((x) => x.classList.toggle("on", x === b));
    $("#roomstep").hidden = false; $("#rooms").innerHTML = ""; $("#confirm").hidden = true;
    rooms = (await api(`/api/dir/rooms?area=${encodeURIComponent(area)}&build=${encodeURIComponent(b.dataset.id)}`)).rooms;
    showRooms();
    $("#roomstep").scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
  };
  $("#q").oninput = showRooms;
  $("#rooms").onclick = (e) => {
    const b = e.target.closest(".pick"); if (!b || b.disabled) return;
    $$("#rooms .pick").forEach((x) => x.classList.toggle("on", x === b));
    const r = rooms.find((x) => String(x.id) === b.dataset.id);
    const bname = $("#builds .pick.on b").textContent;
    const c = $("#confirm");
    c.hidden = false;
    c.innerHTML = html`<form class="row between wrapflex" id="f-join">
      <span style="letter-spacing:.14em">${bname} ${r.name}</span>
      <span class="row"><button class="btn solid" id="jbtn">加入</button></span></form>`.s;
    $("#f-join").onsubmit = (ev) => {
      ev.preventDefault();
      busy($("#jbtn"), async () => joined(await api("/api/room/join", { roomId: r.id }))).catch(() => {});
    };
    $("#jbtn").focus({ preventScroll: true });
  };
  showBuilds();
}

// ---------- 看板 ----------
function status(hEarly, ready) {
  const c = S.config;
  if (!ready) return { cls: "", label: "学习中" };
  if (hEarly == null) return { cls: "ok", label: "正常" };
  if (hEarly <= c.urgent) return { cls: "warn", label: "即将停电" };
  if (hEarly <= c.threshold) return { cls: "warn", label: "预警" };
  return { cls: "ok", label: "正常" };
}

function heroHtml(room) {
  const fc = room.forecast, t = now();
  if (room.balanceAt == null) {
    return html`<div class="hero"><div class="where"><span>${room.build} ${room.name}</span><span class="badge">等待数据</span></div>
      <div class="big"><span class="v">—</span></div>
      <p class="when">等待首次读表<small>注册后约 1~2 分钟</small></p></div>`;
  }
  const ready = fc && fc.ready;
  const hours = ready && fc.mid ? Math.max(0, (fc.mid - t) / 3600) : null;
  const hEarly = ready && fc.early ? Math.max(0, (fc.early - t) / 3600) : null;
  const st = status(hEarly, ready);
  let big, unit, when;
  if (!ready) {
    big = fmt(room.balance, 1); unit = "度";
    when = html`正在估算用电<small>读数很少，仅供参考</small>`;
  } else if (hours == null) {
    big = "60+"; unit = "天"; when = html`两个月内不会停电`;
  } else {
    if (hours < 72) { big = hours < 1 ? "<1" : String(Math.round(hours)); unit = "小时"; }
    else { big = (hours / 24).toFixed(1); unit = "天"; }
    // 停电时刻给区间（最早~最晚），比一个 ±百分比好读：不用先换算百分比才知道差多久
    const lead = fc.confidence === "prior" ? "粗估，" : "";
    when = fc.late != null
      ? html`预计 ${rel(fc.mid)} 前后停电<small>${lead}最早 ${rel(fc.early, true)} · 最晚 ${rel(fc.late, true)}</small>`
      : html`预计 ${rel(fc.mid)} 前后停电<small>${lead}最早 ${rel(fc.early, true)}</small>`;
  }
  const stale = t - room.balanceAt > 3 * 3600;
  return html`<div class="hero">
  <div class="where"><span>${room.build} ${room.name}</span><span class="badge ${st.cls}">${st.label}</span></div>
  <div class="big"><span class="v" id="bigv" data-v="${big}">${big}</span><span class="u">${unit}</span>
    ${ready ? html`<span class="bal"><span>余量</span><b class="num">${fmt(room.balance, 2)}<small>度</small></b></span>` : ""}</div>
  <p class="when">${when}</p>
  ${stale ? html`<p class="note">数据中断 ${Math.round((t - room.balanceAt) / 3600)} 小时 · 按习惯推算</p>` : ""}
  ${room.pollError ? html`<p class="note">读表失败 · ${room.pollError}</p>` : ""}
</div>`;
}

function miniHtml(room) {
  return html`${room.balanceAt ? "更新 " + ago(room.balanceAt) : ""}`;
}

function viewDashboard() {
  const room = S.me.room, u = S.me.user;
  const free = S.config.maxMembers - room.members.length;
  mount(html`
<div class="wrap">
<section id="overview">
  ${heroHtml(room)}
</section>

<section class="card" id="charts">
  <div class="lbl-row"><span class="lbl">余量</span><span class="mini2" id="rng"></span></div>
  <div id="bal"><div class="chart-loading"><div class="spinner" role="status" aria-label="加载中"></div></div></div>
  <div class="panel" id="usage">
    <div class="wk-clip"><div id="wk"></div></div>
    <div class="wk-clip"><div id="hr"></div></div>
  </div>
</section>

<section class="block" id="room">
  <span class="lbl">寝室成员</span>
  <ul class="mlist">
    ${room.members.map((m) => html`<li class="mrow ${m.me ? "me" : ""}">
      <span class="maddr" title="${m.email}">${m.email}</span>
      ${m.me ? html`<span class="mtag">我</span>` : html`<button class="link danger" data-kick="${m.id}">移除</button>`}
    </li>`)}
  </ul>
  ${free > 0 ? html`<form class="field-row" id="f-add" style="margin-top:14px">
    <input class="input" id="add-email" placeholder="添加室友的 QQ 邮箱" inputmode="email" autocomplete="off" aria-label="添加成员">
    <button class="arrow" id="add-btn" aria-label="添加成员">${new Raw(ARROW)}</button></form>` : ""}
  <div class="panel">
    <span class="lbl">停电提醒 · 发给上面每位成员</span>
    <label class="switch"><span>停电前 ${S.config.threshold} 小时提醒</span><input type="checkbox" id="s-alerts" ${room.notify.alerts ? new Raw("checked") : ""}></label>
    <label class="switch"><span>${S.config.urgent} 小时内再提醒</span><input type="checkbox" id="s-urgent" ${room.notify.urgent ? new Raw("checked") : ""}></label>
    <p class="hint">充值后余量回升，提醒会自动复位。</p>
  </div>
  <div class="actions">${u.admin ? html`<a class="link" href="#/admin">管理后台</a>` : ""}<button class="link danger" id="delete">注销</button></div>
</section>

</div>`);

  $("#mini").innerHTML = miniHtml(room).s;
  const bv = $("#bigv");
  if (bv) countUp(bv, bv.dataset.v);
  const heroIo = new IntersectionObserver(([e]) => $("#top").classList.toggle("compact", !e.isIntersecting), { rootMargin: "-64px 0px 0px 0px" });
  heroIo.observe($(".hero"));
  S.observers.push(heroIo);

  // 换了寝室/账号：读数缓存作废
  if (S.readingsRoom !== room.id) { S.readings = []; S.loadedFrom = null; S.readingsDone = false; S.fullHistory = false; S.readingsRoom = room.id; }

  bindRoom(room);
  loadReadings().then(renderData).catch((e) => toast(e.message, true));
}

function bindRoom(room) {
  const fAdd = $("#f-add");
  if (fAdd) fAdd.onsubmit = (e) => {
    e.preventDefault();
    const email = $("#add-email").value.trim();
    if (!email) return;
    busy($("#add-btn"), async () => {
      await api("/api/room/members/add", { email });
      toast("已添加");
      await reload(true);
    }).catch(() => {});
  };
  $$("[data-kick]").forEach((b) => b.onclick = () => {
    if (!confirm("把这位成员移出寝室？")) return;
    busy(b, async () => { await api("/api/room/kick", { userId: +b.dataset.kick }); toast("已移除"); await reload(true); }).catch(() => {});
  });
  const saveNotify = () => api("/api/room/settings", { alerts: $("#s-alerts").checked, urgent: $("#s-urgent").checked })
    .then(() => toast("已保存")).catch((e) => toast(e.message, true));
  $("#s-alerts").onchange = saveNotify;
  $("#s-urgent").onchange = saveNotify;
  // 注销 = 退出寝室 + 解除所有绑定（账号、登录状态一并删除）
  $("#delete").onclick = () => {
    const v = prompt("注销后你将退出寝室并解除所有绑定，不可恢复。\n输入「注销」确认");
    if (v !== "注销") return;
    busy($("#delete"), async () => { await api("/api/me/delete", { confirm: "删除" }); S.me = null; route(); }).catch(() => {});
  };
}

// ---------- 数据：读数、统计、图表 ----------
async function loadReadings(from) {
  const t = now();
  from = from ?? t - 35 * DAY;
  if (S.loadedFrom != null && from >= S.loadedFrom && S.readings.length) {
    // 只补最新的
    const last = S.readings[S.readings.length - 1][0];
    const r = await api(`/api/room/readings?from=${last + 1}&to=${t}`);
    S.readings.push(...r.readings);
    return;
  }
  const r = await api(`/api/room/readings?from=${from}&to=${t}`);
  S.readings = r.readings;
  S.loadedFrom = r.from;
}

/** 往前再取一段更早的读数（历史图翻到头时调用）；取回空段就认为到底了 */
async function loadOlder(span = 35) {
  if (S.readingsDone || S.loadedFrom == null) return { readings: S.readings, done: true };
  // 一次性取回全部历史（余量图要用全局最大值定刻度）：每次打开页面只做一次
  if (span > 35) { if (S.fullHistory) return { readings: S.readings, done: S.readingsDone }; S.fullHistory = true; }
  const to = S.loadedFrom, r = await api(`/api/room/readings?from=${to - span * DAY}&to=${to}`);
  const firstT = S.readings.length ? S.readings[0][0] : Infinity;
  const got = r.readings.filter(([t]) => t < firstT);
  if (got.length) S.readings = got.concat(S.readings);
  S.loadedFrom = r.from;
  S.readingsDone = !got.length;
  return { readings: S.readings, done: S.readingsDone };
}

function renderData() {
  if (!$("#bal")) return;   // 读数回来之前已经切走了
  const room = S.me.room;

  mountHistory({ bal: $("#bal"), rng: $("#rng"), use: $("#usage"), wk: $("#wk"), hr: $("#hr") }, {
    now: now(), cal: S.cal, lag: S.config.lag, cutoff: S.config.cutoff,
    fc: room.forecast, balance: room.balance, readings: S.readings, loadOlder,
  });
}

// ---------- 路由与启动 ----------
async function reload(keepView) {
  try { S.me = await api("/api/me"); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
  if (keepView && S.me && S.me.room) {
    // 原地刷新看板：保留滚动位置
    const y = scrollY;
    route();
    window.scrollTo(0, y);
    return;
  }
  route();
}

const adminHash = () => (location.hash.match(/^#\/admin(?:\/(\w+))?$/) || [])[1] ?? (location.hash === "#/admin" ? "overview" : null);

async function viewAdminPage(tab) {
  const { viewAdmin } = await import("./admin.js");
  viewAdmin({ $, $$, html, Raw, api, toast, busy, ago, mount, fmtDate, accuracyChart, ARROW }, tab);
}

function route() {
  if (!S.me) return viewLogin();
  const tab = S.me.user.admin ? adminHash() : null;
  if (tab) return viewAdminPage(tab).catch((e) => toast(e.message, true));
  if (!S.me.room) return viewPicker().catch((e) => toast(e.message, true));
  return viewDashboard();
}

/** 刚加入寝室：电表可能还没读到，短时轮询等第一个读数（本机 poller 每 2 分钟补读一次新寝室） */
let firstReadTimer;
function awaitFirstRead() {
  clearInterval(firstReadTimer);
  let n = 0;
  firstReadTimer = setInterval(async () => {
    if (++n > 16 || !S.me || !S.me.room || S.me.room.balanceAt) { clearInterval(firstReadTimer); return; }
    try {
      const me = await api("/api/me");
      if (me.room && me.room.balanceAt) {
        clearInterval(firstReadTimer);
        S.me = me;
        const y = scrollY; route(); window.scrollTo(0, y);
      }
    } catch { /* 静默 */ }
  }, 15000);
}

async function refreshQuietly() {
  if (document.hidden || !S.me || !S.me.room || adminHash()) return;
  try {
    const me = await api("/api/me");
    const changed = !S.me.room || !me.room || me.room.balanceAt !== S.me.room.balanceAt || me.room.id !== S.me.room.id;
    if (changed) { S.me = me; const y = scrollY; route(); window.scrollTo(0, y); }
  } catch { /* 静默 */ }
}

async function boot() {
  try {
    S.config = await api("/api/config");
    S.cal = calendar(S.config.holidays, S.config.workdays);
    await reload();
  } catch (e) {
    $("#app").innerHTML = html`<div class="loading"><div style="text-align:center"><p>加载失败：${e.message}</p><button class="btn" id="retry">重试</button></div></div>`.s;
    $("#retry").onclick = () => location.reload();
  }
  // 每 10 分钟静默检查一次新读数；切回页面时也检查
  S.timer = setInterval(refreshQuietly, 10 * 60 * 1000);
  addEventListener("hashchange", () => { if (S.me) route(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuietly(); });
}

boot();
