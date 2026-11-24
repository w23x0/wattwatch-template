import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { DAY, HOUR, dayStart, decodeDay, encodeDay, unpack, newModel, pack, calendar, update, forecast } from "../public/js/model.js";

// 邮件网络接口不可在测试中调用；其余入库逻辑使用真实 SQLite 表与事务。
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:sockets") return {
    url: "data:text/javascript,export function connect() { throw new Error('Unexpected SMTP connection'); }", shortCircuit: true,
  };
  return next(specifier, context);
} });
const { ingest, prepareAlert } = await import("../src/poller.js");
const { cron } = await import("../src/cron.js");
const { handleApi } = await import("../src/api.js");
const { createSession } = await import("../src/auth.js");
const { flushOutbox, enqueue, unsubSig } = await import("../src/mail.js");
const notificationsMigration = readFileSync(new URL("../migrations/0002_room_notifications.sql", import.meta.url), "utf8");
const reliableAlertsMigration = readFileSync(new URL("../migrations/0003_reliable_alerts.sql", import.meta.url), "utf8");

function database(t, { legacy = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  if (!legacy) db.exec(notificationsMigration + reliableAlertsMigration);
  db.exec(`INSERT INTO rooms (id, item_id, ptype, item_name, area_id, area_name, build_id, build_name, room_ext_id, room_name)
    VALUES (1, '1', '1', '电费', '1', '示例校区', '1', '1 栋', '101', '101')`);
  const DB = {
    prepare(sql) {
      const numbered = /\?\d+/.test(sql);
      const stmt = db.prepare(sql.replace(/\?(\d+)/g, (_, n) => `$p${n}`));
      let args = [];
      return {
        bind(...values) {
          args = numbered ? [Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]))] : values;
          return this;
        },
        async first() { return stmt.get(...args) || null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() {
          if (!sql.includes("RETURNING")) return { meta: stmt.run(...args) };
          return { results: stmt.all(...args), meta: db.prepare("SELECT changes() AS changes").get() };
        },
      };
    },
    batch(stmts) {
      const task = pending.then(async () => {
        db.exec("BEGIN");
        try {
          const result = [];
          for (const stmt of stmts) result.push(await stmt.run());
          db.exec("COMMIT");
          return result;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      });
      pending = task.catch(() => {});
      return task;
    },
  };
  let pending = Promise.resolve();
  return { db, env: { DB } };
}
const ctx = { waitUntil() { throw new Error("Unexpected mail task"); } };

test("寝室提醒沿用旧页面开关，所有入寝方式都遵循两档设置", async (t) => {
  const { db, env } = database(t, { legacy: true });
  env.ADMIN_EMAILS = "you@example.com,added@example.com";
  db.exec(`INSERT INTO users (id, email, room_id, alerts, urgent, created_at) VALUES
    (1, 'you@example.com', 1, 0, 1, 1), (2, 'roomie@example.com', 1, 1, 1, 1),
    (3, 'joiner@example.com', NULL, 0, 0, 1)`);
  db.exec(notificationsMigration + reliableAlertsMigration);
  const adminCookie = (await createSession(env, 1)).split(";")[0];
  const joiningCookie = (await createSession(env, 3)).split(";")[0];
  async function request(path, data, cookie = adminCookie) {
    const url = new URL(path, "https://power.example.com");
    const req = new Request(url, {
      method: data ? "POST" : "GET", body: data ? JSON.stringify(data) : undefined,
      headers: { cookie, origin: url.origin, "content-type": "application/json" },
    });
    const res = await handleApi(req, env, ctx, url);
    assert.equal(res.status, 200);
    return res;
  }
  const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get();
  async function recipients(level) {
    db.exec("DELETE FROM outbox; DELETE FROM meta WHERE k = 'alerted:1'");
    const mail = await prepareAlert(env, { room, balance: 2, level });
    if (mail.length) await env.DB.batch(mail);
    return db.prepare("SELECT to_addr FROM outbox ORDER BY to_addr").all().map((m) => m.to_addr);
  }
  const allMembers = ["added@example.com", "joiner@example.com", "roomie@example.com", "you@example.com"];

  await request("/api/room/members/add", { email: "added@example.com" });
  const joined = await (await request("/api/room/join", { roomId: 1 }, joiningCookie)).json();
  assert.deepEqual(joined.room.notify, { alerts: false, urgent: true });
  assert.deepEqual(await recipients(1), []);
  assert.deepEqual(await recipients(2), allMembers);

  const updated = await (await request("/api/room/settings", { urgent: false }, joiningCookie)).json();
  assert.deepEqual(updated.room.notify, { alerts: false, urgent: false });
  await request("/api/room/settings", { alerts: true });
  assert.deepEqual(await recipients(1), allMembers);
  assert.deepEqual(await recipients(2), []);

  await request("/api/unsub?u=3&s=" + await unsubSig(env, 3), {}, "");
  await request("/api/room/settings", { urgent: true });
  const me = await (await request("/api/me", undefined, joiningCookie)).json();
  assert.deepEqual(me.room.notify, { alerts: true, urgent: true });
  assert.equal(me.user.unsubscribed, true);
  assert.deepEqual(await recipients(1), allMembers.filter((email) => email !== "joiner@example.com"));
  const filtered = await (await request("/api/admin/users?filter=muted")).json();
  assert.deepEqual(filtered.users.map((user) => user.email), ["joiner@example.com"]);

  await request("/api/me/subscribe", {}, joiningCookie);
  assert.deepEqual(await recipients(1), allMembers);
});

test("入队写入失败会回滚读数和告警等级，重试可寄出提醒", async (t) => {
  const { db, env } = database(t);
  env.MAIL_MODE = "log";
  t.mock.method(console, "log", () => {});
  db.exec("INSERT INTO users (email, room_id, created_at) VALUES ('you@example.com', 1, 1)");
  db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test outbox error'); END`);
  const reading = { id: 1, t: Math.floor(Date.now() / 1000), b: 0.2 };
  await assert.rejects(ingest(env, ctx, [reading]), /test outbox error/);
  assert.deepEqual({ ...db.prepare("SELECT balance_at, alert_level FROM rooms WHERE id = 1").get() },
    { balance_at: null, alert_level: 0 });
  db.exec("DROP TRIGGER fail_outbox");
  const tasks = [];
  assert.equal((await ingest(env, { waitUntil: (task) => tasks.push(task) }, [reading])).alerts, 1);
  await Promise.all(tasks);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NOT NULL").get().n, 1);
});

test("并行发件各领一批，关掉后再打开也不会恢复已取消的预警", async (t) => {
  const { db, env } = database(t);
  env.MAIL_MODE = "log";
  const log = t.mock.method(console, "log", () => {});
  db.exec(`INSERT INTO users (email, room_id, created_at) VALUES
    ('roomie@example.com', 1, 1), ('you@example.com', 1, 1)`);
  const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get();
  for (const level of [1, 2]) {
    await env.DB.batch(await prepareAlert(env, { room, balance: 2, level }));
  }
  await enqueue(env, { to: "you@example.com", subject: "系统通知", text: "测试" }).run();
  db.exec(`UPDATE rooms SET notify_alerts = 0 WHERE id = 1;
           UPDATE rooms SET notify_alerts = 1 WHERE id = 1;
           UPDATE users SET alert_unsubscribed = 1 WHERE email = 'you@example.com'`);
  const sent = await Promise.all([flushOutbox(env, 1), flushOutbox(env, 1), flushOutbox(env, 1)]);
  assert.equal(sent.reduce((sum, n) => sum + n, 0), 2);
  assert.equal(log.mock.callCount(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE cancelled_at IS NOT NULL").get().n, 3);
  assert.equal(db.prepare("SELECT MAX(tries) AS n FROM outbox").get().n, 1);
});

test("并发读数保留最新余额和双方历史", async (t) => {
  const { db, env } = database(t);
  const prepare = env.DB.prepare.bind(env.DB), ready = Promise.withResolvers();
  let snapshots = 0;
  t.mock.method(env.DB, "prepare", (sql) => {
    const stmt = prepare(sql);
    if (sql.startsWith("SELECT id, build_name, room_name, model, alert_level")) {
      const all = stmt.all.bind(stmt);
      stmt.all = async () => {
        const result = await all();
        if (++snapshots === 2) ready.resolve();
        await ready.promise;
        return result;
      };
    }
    return stmt;
  });
  const at = Math.floor(Date.now() / 1000), older = at - HOUR;
  await Promise.all([
    ingest(env, ctx, [{ id: 1, t: at, b: 19 }], { silent: true }),
    ingest(env, ctx, [{ id: 1, t: older, b: 20 }], { silent: true }),
  ]);
  const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get();
  assert.equal(room.balance_at, at);
  assert.equal(room.balance, 19);
  const archived = db.prepare("SELECT day, v FROM days WHERE room_id = 1 ORDER BY day").all();
  const points = [...archived.flatMap((r) => decodeDay(r.day, r.v)), ...decodeDay(room.today_day, room.today)];
  assert.deepEqual(points.map((p) => p[1]), [20, 19]);
});

test("并发添加只能占用一个空位，移除成员后可以再加", async (t) => {
  const { db, env } = database(t);
  const candidates = ["new-member@example.com", "existing-member@example.com"];
  env.ADMIN_EMAILS = candidates.join(",");
  db.exec(`INSERT INTO users (id, email, room_id, created_at) VALUES
    (1, 'you@example.com', 1, 1), (2, 'roomie@example.com', 1, 1),
    (3, 'third-member@example.com', 1, 1), (4, 'existing-member@example.com', NULL, 1)`);
  const cookie = (await createSession(env, 1)).split(";")[0];
  const request = (path, data) => {
    const url = new URL(path, "https://power.example.com");
    const req = new Request(url, {
      method: "POST", body: JSON.stringify(data),
      headers: { cookie, origin: url.origin, "content-type": "application/json" },
    });
    return handleApi(req, env, ctx, url);
  };
  const add = (email) => request("/api/room/members/add", { email });
  const prepare = env.DB.prepare.bind(env.DB);
  const ready = Promise.withResolvers();
  let waiting = 0;
  t.mock.method(env.DB, "prepare", (sql) => {
    const stmt = prepare(sql);
    if (sql.startsWith("INSERT INTO users (email, room_id")) {
      const run = stmt.run.bind(stmt);
      stmt.run = async () => {
        if (++waiting === 2) ready.resolve();
        await ready.promise;
        return run();
      };
    }
    return stmt;
  });

  const results = await Promise.allSettled(candidates.map(add));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.findIndex((r) => r.status === "rejected");
  assert.equal(results[rejected].reason.status, 409);
  assert.match(results[rejected].reason.message, /已满 4 人/);
  const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE room_id = 1");
  assert.equal(count.get().n, 4);

  await request("/api/room/kick", { userId: 2 });
  assert.equal(count.get().n, 3);
  const response = await add(candidates[rejected]);
  assert.equal(response.status, 200);
  assert.equal(count.get().n, 4);
});

test("入库拒绝空值，不让相同时间戳制造充值；重试无副作用", async (t) => {
  const { db, env } = database(t), at = dayStart(Math.floor(Date.now() / 1000)) - DAY + 1200;
  const result = await ingest(env, ctx, [
    null, { id: 1, t: at, b: null }, { id: 1, t: at, b: "" }, { id: 1, t: at, b: false },
    { id: 1, t: at, b: 20 }, { id: 1, t: at, b: 100 }, { id: 1, t: at + HOUR, b: 19.5 },
  ], { silent: true });
  assert.equal(result.rooms, 1);
  const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get();
  assert.equal(room.balance, 19.5);
  assert.equal(decodeDay(room.today_day, room.today).length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recharges").get().n, 0);
  assert.equal((await ingest(env, ctx, [{ id: 1, t: at, b: 100 }], { silent: true })).rooms, 0);
  assert.deepEqual(db.prepare("SELECT * FROM rooms WHERE id = 1").get(), room);
});

test("历史误差归到评估当天，静默导入不会标记已发送预警", async (t) => {
  const { db, env } = database(t);
  const start = dayStart(Math.floor(Date.now() / 1000)) - 5 * DAY;
  const reads = Array.from({ length: 73 }, (_, i) => ({ id: 1, t: start + i * HOUR + 1200, b: 20 - i * 0.3 }));
  await ingest(env, ctx, reads, { silent: true });
  const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get();
  const expected = new Map(), m = newModel();
  for (const { t: at, b } of reads) for (const e of update(m, at, b, calendar()).evals) {
    const key = `${dayStart(e.t)}:${e.h}`;
    expected.set(key, (expected.get(key) || 0) + 1);
  }
  const rows = db.prepare("SELECT day, h, n FROM accuracy").all();
  assert.ok(rows.length > 2);
  assert.deepEqual(new Map(rows.map((r) => [`${r.day}:${r.h}`, r.n])), expected);
  assert.equal(room.alert_level, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);
  assert.ok(unpack(room.model).acc[24].n > 0);
});

test("凌晨归档后补到旧日的读数，不覆盖已有日归档", async (t) => {
  const { db, env } = database(t);
  const day = dayStart(Math.floor(Date.now() / 1000)) - 2 * DAY;
  const points = [[day + 1200, 30], [day + HOUR + 1200, 29.5]];
  await ingest(env, ctx, points.map(([at, b]) => ({ id: 1, t: at, b })), { silent: true });
  db.prepare("INSERT INTO days (room_id, day, v) VALUES (?, ?, ?)").run(1, day, encodeDay(day, points));
  db.exec("UPDATE rooms SET today = NULL, today_day = NULL WHERE id = 1");
  await ingest(env, ctx, [
    { id: 1, t: day + 2 * HOUR + 1200, b: 29 },
    { id: 1, t: day + DAY + 1200, b: 20 },
  ], { silent: true });
  const archived = db.prepare("SELECT v FROM days WHERE room_id = 1 AND day = ?").get(day);
  assert.deepEqual(decodeDay(day, archived.v), [...points, [day + 2 * HOUR + 1200, 29]]);
});

test("空的精度窗口和不足三个活跃寝室会清除旧共享缓存", async (t) => {
  const { db, env } = database(t);
  const at = Math.floor(Date.now() / 1000), m = newModel();
  for (let i = 0; i <= 30; i++) update(m, at - (30 - i) * HOUR, 30 - i * 0.25, calendar());
  const fc = JSON.stringify(forecast(m, m.B, calendar()));
  db.prepare("UPDATE rooms SET model = ?, forecast = ?, balance_at = ? WHERE id = 1").run(pack(m), fc, at);
  db.exec("INSERT INTO users (email, room_id, created_at) VALUES ('you@example.com', 1, 1)");
  for (const k of ["prior", "calib"]) db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run(k, '{}');
  await cron(env, { force: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE k IN ('prior', 'calib')").get().n, 0);
});

test("共享先验同时过滤离群、停采与无成员寝室", async (t) => {
  const { db, env } = database(t), at = Math.floor(Date.now() / 1000);
  const rates = [0.2, 0.25, 0.3, 10, 5, 5];
  for (let i = 0; i < rates.length; i++) {
    const id = i + 1;
    if (id > 1) db.prepare(`INSERT INTO rooms (id, item_id, ptype, item_name, area_id, area_name, build_id, build_name, room_ext_id, room_name)
      SELECT ?, item_id, ptype, item_name, area_id, area_name, build_id, build_name, ?, room_name FROM rooms WHERE id = 1`).run(id, String(id));
    const f = { confidence: "mid", work: Array(24).fill(rates[i]), rest: Array(24).fill(rates[i]), early: null };
    db.prepare("UPDATE rooms SET forecast = ?, balance_at = ? WHERE id = ?")
      .run(JSON.stringify(f), id === 5 ? at - 4 * DAY : at, id);
    if (id !== 6) db.prepare("INSERT INTO users (email, room_id, created_at) VALUES (?, ?, ?)").run(`room${id}@example.com`, id, at);
  }
  await cron(env, { force: true });
  const prior = JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'prior'").get().v);
  assert.equal(prior.rooms, 3);
  assert.deepEqual(prior.v, Array(48).fill(0.25));
});

test("极端误差留在本寝室，仍按原部署规则排除全校校准", async (t) => {
  const { db, env } = database(t), start = dayStart(Math.floor(Date.now() / 1000)) - 2 * DAY;
  const m = newModel();
  update(m, start + 1200, 100, calendar());
  m.snap = [{ T: start, B: 100, d: 0, p: [1000, 1000, 1000] }];
  db.prepare("UPDATE rooms SET model = ?, balance = ?, balance_at = ? WHERE id = 1").run(pack(m), 100, start + 1200);
  await ingest(env, ctx, [{ id: 1, t: start + 6 * HOUR + 1200, b: 100 }], { silent: true });
  const learned = unpack(db.prepare("SELECT model FROM rooms WHERE id = 1").get().model);
  assert.equal(learned.acc[6].n, 1);
  assert.ok(learned.acc[6].s1 < -3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accuracy").get().n, 0);
});
