-- 寝室目录（由本地轮询器从校园卡接口同步）+ 每个寝室的模型/预测缓存
CREATE TABLE rooms (
  id          INTEGER PRIMARY KEY,
  item_id     TEXT NOT NULL,              -- 购电项 payment_id（全校分属多个购电项）
  ptype       TEXT NOT NULL,              -- payment_type
  item_name   TEXT NOT NULL,
  area_id     TEXT NOT NULL,
  area_name   TEXT NOT NULL,
  build_id    TEXT NOT NULL,
  build_name  TEXT NOT NULL,
  room_ext_id TEXT NOT NULL,
  room_name   TEXT NOT NULL,
  invite      TEXT,                       -- 邀请码：有成员时才有
  balance     REAL,                       -- 最新余量（度）
  balance_at  INTEGER,                    -- 最新读数时刻
  model       TEXT,                       -- model.js 增量模型
  forecast    TEXT,                       -- 最近一次预测结果
  alert_level INTEGER NOT NULL DEFAULT 0, -- 0 无 / 1 已发 24h 预警 / 2 已发临停提醒
  today       TEXT,                       -- 当天读数（紧凑编码），跨天时归档到 days
  today_day   INTEGER,                    -- today 对应的当天 0 点
  poll_error  TEXT,
  poll_error_at INTEGER,
  UNIQUE (item_id, area_id, build_id, room_ext_id)
);
CREATE UNIQUE INDEX rooms_invite ON rooms(invite) WHERE invite IS NOT NULL;

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  room_id    INTEGER REFERENCES rooms(id),
  joined_at  INTEGER,
  alerts     INTEGER NOT NULL DEFAULT 1,  -- 24h 预警
  urgent     INTEGER NOT NULL DEFAULT 1,  -- 临停提醒
  created_at INTEGER NOT NULL,
  login_at   INTEGER
);
CREATE INDEX users_room ON users(room_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,            -- sha256(cookie)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE otps (
  email   TEXT NOT NULL,
  purpose TEXT NOT NULL,                  -- login / change
  user_id INTEGER,
  hash    TEXT NOT NULL,
  expires INTEGER NOT NULL,
  tries   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
) WITHOUT ROWID;

-- 历史读数：每寝室每天一行，紧凑编码（见 model.js encodeDay），约 110 字节/天
CREATE TABLE days (
  room_id INTEGER NOT NULL,
  day     INTEGER NOT NULL,
  v       TEXT NOT NULL,
  PRIMARY KEY (room_id, day)
) WITHOUT ROWID;

-- 识别到的充值（余量回升）
CREATE TABLE recharges (
  room_id INTEGER NOT NULL,
  t       INTEGER NOT NULL,
  kwh     REAL NOT NULL,
  PRIMARY KEY (room_id, t)
) WITHOUT ROWID;

-- 全校预测精度（按天、按跨度累计 ln(实际/预测) 的统计量），用于校准与观察算法改进
CREATE TABLE accuracy (
  day INTEGER NOT NULL,
  h   INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  s1  REAL NOT NULL,
  s2  REAL NOT NULL,
  sa  REAL NOT NULL,
  PRIMARY KEY (day, h)
) WITHOUT ROWID;

CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  text       TEXT NOT NULL,
  html       TEXT,
  headers    TEXT,                        -- 额外邮件头（JSON），如 List-Unsubscribe
  created_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER,
  error      TEXT
);
CREATE INDEX outbox_pending ON outbox(sent_at, tries);

CREATE TABLE ratelimit (
  k     TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  reset INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
