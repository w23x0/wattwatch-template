// 管理后台页面（仅管理员，从 app.js 按需加载）。标签页：总览 / 用户 / 寝室 / 充值 / 邮件 / 运行。
// 工具函数由 app.js 传入（h），避免与 app.js 循环依赖。
const TABS = [["overview", "总览"], ["users", "用户"], ["rooms", "寝室"], ["recharges", "充值"], ["mail", "邮件"], ["system", "运行"]];

const USER_FILTERS = [["all", "全部"], ["recent", "近7天登录"], ["noroom", "未选寝室"], ["muted", "关了提醒"], ["never", "从未登录"]];
const ROOM_VIEWS = [["used", "有人在用"], ["low", "余量最低"], ["stale", "数据过期"], ["error", "轮询报错"], ["alert", "已预警"], ["all", "全部"]];
const MAIL_FILTERS = [["all", "全部"], ["pending", "待发"], ["failed", "失败"], ["sent", "已发"]];

export function viewAdmin(h, tab) {
  const { $, $$, html, Raw, api, toast, busy, ago, mount, fmtDate, accuracyChart, ARROW } = h;
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  const A = { tab, req: 0 }; // req：丢弃过期响应（切换标签后晚到的结果）

  mount(html`
<div class="wrap">
<section class="block">
  <div class="lbl-row"><span class="lbl">管理后台</span><a class="link" href="#">返回看板</a></div>
  <div class="tabs" id="atabs">${TABS.map(([k, name]) => html`<button data-t="${k}">${name}</button>`)}</div>
</section>
<section class="block" id="apane"><div class="spinner"></div></section>
</div>`);

  const pane = $("#apane");
  const abs = (t) => (t ? fmtDate(t) : "—");
  const ageOf = (t) => (t ? ago(t) : "—");
  const sw = (items, cur, attr) => html`<div class="tabs sub">${items.map(([k, name]) => html`<button ${new Raw(attr)}="${k}" class="${k === cur ? "on" : ""}">${name}</button>`)}</div>`;
  const searchForm = (id, ph, q) => html`<form class="field-row" id="${id}" style="max-width:420px;margin:12px 0 4px">
    <input class="input" name="q" value="${q}" placeholder="${ph}" autocomplete="off" style="font-size:14px"><button class="arrow" aria-label="搜索">${new Raw(ARROW)}</button></form>`;

  function select(t, push = true) {
    A.tab = t; A.req++;
    $$("#atabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    if (push) history.replaceState(null, "", t === "overview" ? "#/admin" : `#/admin/${t}`);
    pane.innerHTML = `<div class="spinner"></div>`;
    ({ overview, users, rooms, recharges, mail, system })[t]().catch((e) => { pane.textContent = e.message; });
  }
  $$("#atabs button").forEach((b) => (b.onclick = () => select(b.dataset.t)));

  /** 分页列表：先拉第一页，「更多」追加；换筛选/搜索由调用方重新调用 */
  async function paged(box, { path, key, row, empty = "没有数据", bind }) {
    const my = A.req;
    let offset = 0, shown = 0;
    box.innerHTML = `<div class="spinner"></div>`;
    const more = async () => {
      const r = await api(`${path}${path.includes("?") ? "&" : "?"}offset=${offset}`);
      if (my !== A.req) return;
      if (offset === 0) box.innerHTML = `<div class="alist"></div><div class="afoot"></div>`;
      const list = $(".alist", box);
      list.insertAdjacentHTML("beforeend", r[key].map((x) => row(x).s).join(""));
      offset += r.page; shown += r[key].length;
      $(".afoot", box).innerHTML = r.total === 0 ? `<p class="muted" style="font-size:12.5px">${empty}</p>`
        : html`<span class="muted">${shown} / ${r.total}</span>${shown < r.total ? html`<button class="link" id="more">更多</button>` : ""}`.s;
      if ($("#more", box)) $("#more", box).onclick = () => busy($("#more", box), more).catch(() => {});
      if (bind) bind(list);
    };
    await more().catch((e) => { box.textContent = e.message; });
  }

  const stat = (label, value, go) => html`<div ${new Raw(go ? `class="go" data-go="${go}"` : "")}><span>${label}</span><b>${value}</b></div>`;
  const bars = (vals, from, unit, digits = 0) => {
    const max = Math.max(...vals, 1), day = 86400;
    return html`<div class="bars">${vals.map((v, i) => html`<i class="${v ? "" : "z"}" style="height:${Math.max(3, (v / max) * 100)}%" title="${fmtDate(from + i * day, false)}：${v.toFixed(digits)} ${unit}"></i>`)}</div>
      <div class="bar-foot"><span>${fmtDate(from, false)}</span><span>合计 ${vals.reduce((a, b) => a + b, 0).toFixed(digits)} ${unit}</span><span>今天</span></div>`;
  };

  // ---------- 总览 ----------
  async function overview() {
    const my = A.req, s = await api("/api/admin/stats");
    if (my !== A.req) return;
    const p = s.poller;
    // 预测误差：实际生效的误差带（模型算「最早/最晚」时真正用的倍率）+ 24h 平均绝对误差
    const bd = s.band || {};
    const bandText = bd.hi ? ` · 误差带 ×${bd.lo}~×${bd.hi}（${bd.src === "school" ? "全校校准" : "经验值"}）` : "";
    const errText = s.calib ? ` · 24 小时 ±${((Math.exp(s.calib.mape) - 1) * 100).toFixed(1)}%（${s.calib.n} 次评估）` : " · 还没有评估样本";
    pane.innerHTML = html`
<span class="lbl">用户</span>
<div class="stats">${[
      stat("注册用户", s.users.total, "users:all"), stat("近 7 天登录", s.users.d7, "users:recent"),
      stat("近 30 天登录", s.users.d30), stat("有效会话", s.users.sessions),
      stat("未选寝室", s.users.noRoom, "users:noroom"), stat("关了提醒", s.users.muted, "users:muted"),
    ]}</div>
<p class="hint">登录会话可保持一年，所以「登录」只统计验证码登录，不是真实访问量。</p>
<div class="panel"><span class="lbl">寝室</span>
<div class="stats">${[
      stat("有人在用", s.rooms.used, "rooms:used"), stat("目录总数", s.rooms.total, "rooms:all"),
      stat("已发 24 小时预警", s.rooms.alert1, "rooms:alert"), stat("已发临停提醒", s.rooms.alert2, "rooms:alert"),
      stat(`余量 < ${s.lowKwh} 度`, s.rooms.low, "rooms:low"), stat("数据过期 > 3 小时", s.rooms.stale, "rooms:stale"),
      stat("轮询报错", s.rooms.error, "rooms:error"), stat("预测先验", s.priorRooms ? s.priorRooms + " 间" : "—"),
    ]}</div></div>
<div class="panel"><span class="lbl">邮件</span>
<div class="stats">${[
      stat("今日验证码", `${s.otp.today}/${s.otp.cap}`), stat("24 小时已发", s.outbox.sent24),
      stat("待发", s.outbox.pending, "mail:pending"), stat("失败", s.outbox.failed, "mail:failed"),
    ]}</div></div>
<div class="panel"><span class="lbl">轮询器</span>
<div class="stats">${[
      stat("状态", p ? (p.ok ? "正常" : "失败") : "—"), stat("上次成功", ageOf(p && p.okAt)),
      stat("token 已用", p && p.tokenAge != null ? p.tokenAge.toFixed(1) + " 天" : "—"), stat("目录同步", ageOf(s.dirAt)),
    ]}</div>${p && !p.ok ? html`<p class="note">${p.msg}</p>` : ""}</div>
<div class="panel"><span class="lbl">近 14 天新增用户</span>${bars(s.days.signups, s.days.from, "人")}
  <p class="hint">含被室友按邮箱添加、尚未登录过的账号。</p></div>
<div class="panel"><span class="lbl">近 14 天充值</span>${bars(s.days.recharge, s.days.from, "度")}
  <p class="hint">由余量回升识别，共 ${s.days.rechargeN.reduce((a, b) => a + b, 0)} 笔。</p></div>
<div class="panel"><div class="lbl-row"><span class="lbl">预测误差${bandText}${errText}</span>
  <span class="legend" style="margin:0"><span class="k"><span class="ln"></span>6h</span><span class="k"><span class="ln dash"></span>24h</span></span></div>
  <div id="acc-chart"></div>
  <p class="hint">曲线是每天 6h/24h 的平均绝对误差（%，悬停看样本数）。误差带是模型算「最早/最晚」时用的用电倍率范围${bd.src !== "school" ? "；全校校准要累计 ≥30 次评估才启用，现在样本不足，先用经验值 ×0.8~×1.25" : ""}。</p>
  <div class="actions"><button class="link" id="recalc">重算先验与校准</button></div></div>`.s;
    accuracyChart($("#acc-chart"), s.accuracy || []);
    $("#recalc").onclick = () => busy($("#recalc"), async () => { await api("/api/admin/recalc", {}); toast("已重算"); select("overview", false); }).catch(() => {});
    $$("[data-go]").forEach((el) => (el.onclick = () => {
      const [t, f] = el.dataset.go.split(":");
      A.preset = { tab: t, f };
      select(t);
    }));
  }

  // ---------- 用户 ----------
  async function users() {
    const preset = A.preset && A.preset.tab === "users" ? A.preset.f : null;
    A.preset = null;
    const st = A.users = { filter: preset || (A.users && A.users.filter) || "all", q: "" };
    const draw = () => {
      pane.innerHTML = html`<span class="lbl">用户</span>${sw(USER_FILTERS, st.filter, "data-f")}${searchForm("f-q", "邮箱或寝室", st.q)}<div id="list"></div>`.s;
      $$("[data-f]", pane).forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; draw(); }));
      $("#f-q").onsubmit = (e) => { e.preventDefault(); st.q = new FormData(e.target).get("q").trim(); draw(); };
      paged($("#list"), {
        path: `/api/admin/users?filter=${st.filter}&q=${encodeURIComponent(st.q)}`, key: "users", empty: "没有符合条件的用户",
        row: (u) => html`<div class="arow">
          <div class="l1"><b>${u.email}</b><span class="muted">${u.room_id ? `${u.build} ${u.room}` : "未选寝室"}</span></div>
          <div class="l2"><span>注册 ${abs(u.created_at)}</span><span>${u.login_at ? "登录 " + ageOf(u.login_at) : "从未登录"}</span>
            <span>${u.sessions} 个会话</span>${!u.alerts || !u.urgent ? html`<span class="bad">${!u.alerts && !u.urgent ? "提醒全关" : !u.alerts ? "关了 24h 预警" : "关了临停提醒"}</span>` : ""}</div>
          <div class="acts">${u.room_id ? html`<button class="link danger" data-kick="${u.id}">移出寝室</button>` : ""}${u.sessions ? html`<button class="link danger" data-out="${u.id}">下线所有设备</button>` : ""}</div></div>`,
        bind: (list) => {
          $$("[data-kick]", list).forEach((b) => (b.onclick = () => {
            if (!confirm("把该用户移出寝室？")) return;
            busy(b, async () => { await api("/api/admin/user/kick", { userId: +b.dataset.kick }); toast("已移出"); draw(); }).catch(() => {});
          }));
          $$("[data-out]", list).forEach((b) => (b.onclick = () => {
            if (!confirm("让该用户在所有设备上退出登录？")) return;
            busy(b, async () => { await api("/api/admin/user/logout", { userId: +b.dataset.out }); toast("已下线"); draw(); }).catch(() => {});
          }));
        },
      });
    };
    draw();
  }

  // ---------- 寝室 ----------
  async function rooms() {
    const preset = A.preset && A.preset.tab === "rooms" ? A.preset.f : null;
    A.preset = null;
    const st = A.rooms = { view: preset || (A.rooms && A.rooms.view) || "used", q: "" };
    const draw = () => {
      pane.innerHTML = html`<span class="lbl">寝室</span>${sw(ROOM_VIEWS, st.view, "data-v")}${searchForm("f-q", "楼栋或房号", st.q)}<div id="list"></div>`.s;
      $$("[data-v]", pane).forEach((b) => (b.onclick = () => { st.view = b.dataset.v; draw(); }));
      $("#f-q").onsubmit = (e) => { e.preventDefault(); st.q = new FormData(e.target).get("q").trim(); draw(); };
      paged($("#list"), {
        path: `/api/admin/rooms?view=${st.view}&q=${encodeURIComponent(st.q)}`, key: "rooms", empty: "没有符合条件的寝室",
        row: (r) => html`<div class="arow" data-room="${r.id}">
          <div class="l1"><b>${r.area} ${r.build} ${r.name}</b><span class="num">${r.balance == null ? "—" : r.balance.toFixed(1) + " 度"}</span></div>
          <div class="l2"><span>${r.n} 人</span><span>读数 ${ageOf(r.balance_at)}</span>
            ${r.early ? html`<span>最早停电 ${fmtDate(r.early)}</span>` : ""}${r.alert ? html`<span class="bad">${r.alert === 2 ? "已发临停提醒" : "已发 24h 预警"}</span>` : ""}
            ${r.error ? html`<span class="bad">${r.error}</span>` : ""}</div>
          <div class="acts"><button class="link" data-open="${r.id}">详情</button></div><div class="detail"></div></div>`,
        bind: (list) => $$("[data-open]", list).forEach((b) => { b.onclick = () => toggleRoom(b); }),
      });
    };
    draw();
  }

  async function toggleRoom(btn) {
    const row = btn.closest(".arow"), box = $(".detail", row);
    if (row.classList.toggle("open") === false) { btn.textContent = "详情"; box.innerHTML = ""; return; }
    btn.textContent = "收起";
    box.innerHTML = `<div class="spinner"></div>`;
    try {
      const d = await api(`/api/admin/room?id=${btn.dataset.open}`);
      const f = d.forecast;
      box.innerHTML = html`<div class="stats" style="margin-top:8px">
        ${stat("购电项", d.room.item_name)}${stat("历史覆盖", d.days ? `${d.days} 天，起 ${fmtDate(d.firstDay, false)}` : "—")}
        ${stat("预测", f ? (f.ready ? "可用" : "学习中") : "—")}${stat("置信度", f && f.confidence ? { high: "高", mid: "中", low: "低" }[f.confidence] || f.confidence : "—")}
        ${stat("最早停电", f && f.early ? fmtDate(f.early) : "—")}${stat("最晚停电", f && f.late ? fmtDate(f.late) : "—")}</div>
        <ul class="mlist" style="margin-top:8px">${d.members.map((m) => html`<li class="mrow"><span class="maddr">${m.email}</span>
          <span class="mtag">${m.login_at ? "登录 " + ageOf(m.login_at) : "未登录"}</span></li>`)}</ul>
        ${d.recharges.length ? html`<p class="hint">最近充值：${d.recharges.map((r) => `${fmtDate(r.t, false)} +${r.kwh.toFixed(1)}度`).join("；")}</p>` : ""}
        ${d.room.error ? html`<p class="note">${d.room.error}（${abs(d.room.error_at)}）</p>` : ""}
        ${d.members.length ? html`<div class="acts"><button class="link danger" data-clear="${d.room.id}">清空所有成员</button></div>` : ""}`.s;
      const c = $("[data-clear]", box);
      if (c) c.onclick = () => {
        if (!confirm(`清空 ${d.room.build} ${d.room.name} 的所有成员？`)) return;
        busy(c, async () => { await api("/api/admin/room/clear", { roomId: d.room.id }); toast("已清空"); select("rooms", false); }).catch(() => {});
      };
    } catch (e) { box.textContent = e.message; }
  }

  // ---------- 充值 ----------
  async function recharges() {
    pane.innerHTML = html`<span class="lbl">全校充值记录</span><div id="list"></div>`.s;
    paged($("#list"), {
      path: "/api/admin/recharges?", key: "recharges", empty: "还没有识别到充值",
      row: (r) => html`<div class="arow"><div class="l1"><b>${r.area} ${r.build} ${r.name}</b><span class="num">+${r.kwh.toFixed(1)} 度</span></div>
        <div class="l2"><span>${abs(r.t)}</span><span>${ageOf(r.t)}</span></div></div>`,
    });
  }

  // ---------- 邮件 ----------
  async function mail() {
    const preset = A.preset && A.preset.tab === "mail" ? A.preset.f : null;
    A.preset = null;
    const st = A.mail = { status: preset || (A.mail && A.mail.status) || "all" };
    const draw = () => {
      pane.innerHTML = html`<div class="lbl-row"><span class="lbl">发件箱（保留 30 天）</span>${st.status === "failed" ? html`<button class="link" id="retry-all">全部重试</button>` : ""}</div>
        ${sw(MAIL_FILTERS, st.status, "data-s")}<div id="list" style="margin-top:8px"></div>
        <p class="hint">验证码邮件不经过发件箱，这里只有停电预警、换绑通知和管理员通知。</p>`.s;
      $$("[data-s]", pane).forEach((b) => (b.onclick = () => { st.status = b.dataset.s; draw(); }));
      const ra = $("#retry-all");
      if (ra) ra.onclick = () => busy(ra, async () => {
        const r = await api("/api/admin/mail/retry", {});
        toast(`重新入队 ${r.requeued} 封，发出 ${r.sent} 封`); draw();
      }).catch(() => {});
      paged($("#list"), {
        path: `/api/admin/mail?status=${st.status}`, key: "mails", empty: "没有邮件",
        row: (m) => {
          const failed = !m.sent_at && m.tries >= 5;
          return html`<div class="arow"><div class="l1"><b>${m.subject}</b>
              <span class="${failed ? "bad" : "muted"}">${m.sent_at ? "已发" : failed ? "失败" : "待发"}</span></div>
            <div class="l2"><span>${m.to_addr}</span><span>${abs(m.created_at)}</span>${m.tries ? html`<span>尝试 ${m.tries} 次</span>` : ""}
              ${m.error ? html`<span class="bad">${m.error}</span>` : ""}</div>
            <div class="acts"><button class="link" data-body="${m.id}">查看正文</button>${failed ? html`<button class="link" data-retry="${m.id}">重试</button>` : ""}</div>
            <pre class="mbody" hidden></pre></div>`;
        },
        bind: (list) => {
          $$("[data-body]", list).forEach((b) => (b.onclick = async () => {
            const pre = $(".mbody", b.closest(".arow"));
            if (!pre.hidden) { pre.hidden = true; return; }
            if (!pre.textContent) {
              try { pre.textContent = (await api(`/api/admin/mail/item?id=${b.dataset.body}`)).text; } catch (e) { return toast(e.message, true); }
            }
            pre.hidden = false;
          }));
          $$("[data-retry]", list).forEach((b) => (b.onclick = () => busy(b, async () => {
            const r = await api("/api/admin/mail/retry", { id: +b.dataset.retry });
            toast(r.sent ? "已发出" : "已重新入队"); draw();
          }).catch(() => {})));
        },
      });
    };
    draw();
  }

  // ---------- 运行 ----------
  async function system() {
    const my = A.req, s = await api("/api/admin/system");
    if (my !== A.req) return;
    const p = s.poller, c = s.config;
    const yes = (v) => (v ? "已配置" : "未配置");
    pane.innerHTML = html`
<span class="lbl">轮询器</span>
<div class="stats">${[
      stat("状态", p ? (p.ok ? "正常" : "失败") : "—"), stat("上报", ageOf(p && p.at)),
      stat("上次成功", ageOf(p && p.okAt)), stat("token 已用", p && p.tokenAge != null ? p.tokenAge.toFixed(1) + " 天（约 30 天过期）" : "—"),
      stat("本轮成功/失败", p ? `${p.polled}/${p.failed}` : "—"), stat("目录同步", ageOf(s.dirAt)),
      stat("先验更新", `${ageOf(s.priorAt)}${s.priorRooms ? ` · ${s.priorRooms} 间` : ""}`), stat("校准更新", ageOf(s.calibAt)),
    ]}</div>${p && p.msg ? html`<p class="${p.ok ? "hint" : "note"}">${p.msg}</p>` : ""}
<div class="panel"><span class="lbl">配置自检</span>
<div class="stats">${[
      stat("POLLER_TOKEN", yes(c.secrets.POLLER_TOKEN)), stat("OTP_PEPPER", yes(c.secrets.OTP_PEPPER)),
      stat("SMTP_PASS", yes(c.secrets.SMTP_PASS)), stat("发信邮箱", c.smtp ? "正常" : "SMTP_USER 与 MAIL_FROM 需填同一地址"),
      stat("人机验证", c.turnstile && c.secrets.TURNSTILE_SECRET ? "已启用" : c.turnstile ? "缺 TURNSTILE_SECRET" : "未启用"),
      stat("电价", c.price ? "已设置" : "未设置"), stat("管理员", c.admins + " 个"), stat("验证码日上限", c.otpCap),
      stat("预警阈值", `${c.threshold}h / ${c.urgent}h`), stat("停电余量", c.cutoff + " 度"),
    ]}</div><p class="hint">这里只显示是否已配置，不显示任何密钥。</p></div>
<div class="panel"><span class="lbl">数据库行数</span>
<div class="stats">${Object.entries(s.tables).map(([k, n]) => stat(k, n.toLocaleString()))}</div></div>
<div class="panel"><span class="lbl">限流计数（未过期，前 15）</span>
${s.limits.length ? html`<div class="alist">${s.limits.map((l) => html`<div class="arow"><div class="l1"><b class="mono">${l.k}</b><span class="num">${l.n}</span></div>
  <div class="l2"><span>${Math.max(0, Math.round((l.reset - Date.now() / 1000) / 60))} 分钟后重置</span></div></div>`)}</div>` : `<p class="muted" style="font-size:12.5px">没有</p>`}</div>`.s;
  }

  select(tab, false);
}
