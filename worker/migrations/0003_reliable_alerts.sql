ALTER TABLE rooms ADD COLUMN write_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE outbox ADD COLUMN alert_room_id INTEGER;
ALTER TABLE outbox ADD COLUMN alert_user_id INTEGER;
ALTER TABLE outbox ADD COLUMN alert_level INTEGER;
ALTER TABLE outbox ADD COLUMN cancelled_at INTEGER;
ALTER TABLE outbox ADD COLUMN claim_token TEXT;
ALTER TABLE outbox ADD COLUMN claim_until INTEGER NOT NULL DEFAULT 0;

-- 旧预警按邮件标题识别。只有收件人和标题里的寝室能对应上时才可继续发送。
UPDATE outbox AS o SET
  alert_level = CASE WHEN o.subject LIKE '⚠️ %即将停电%' THEN 2 ELSE 1 END,
  alert_user_id = (SELECT id FROM users WHERE email = o.to_addr),
  alert_room_id = (SELECT r.id FROM users u JOIN rooms r ON r.id = u.room_id WHERE u.email = o.to_addr
    AND (instr(o.subject, r.build_name || ' ' || r.room_name || ' 电量不足，预计 ') = 1
      OR instr(o.subject, '⚠️ ' || r.build_name || ' ' || r.room_name || ' 即将停电') = 1))
WHERE o.sent_at IS NULL AND (o.subject LIKE '% 电量不足，预计 % 停电' OR o.subject LIKE '⚠️ %即将停电%');

CREATE INDEX outbox_room_alerts ON outbox(alert_room_id, alert_level) WHERE sent_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX outbox_user_alerts ON outbox(alert_user_id) WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE TRIGGER cancel_disabled_room_alerts AFTER UPDATE OF notify_alerts, notify_urgent ON rooms
WHEN (OLD.notify_alerts = 1 AND NEW.notify_alerts = 0) OR (OLD.notify_urgent = 1 AND NEW.notify_urgent = 0)
BEGIN
  UPDATE outbox SET cancelled_at = unixepoch(), error = '寝室已关闭该档提醒'
  WHERE sent_at IS NULL AND cancelled_at IS NULL AND alert_room_id = NEW.id
    AND ((alert_level = 1 AND NEW.notify_alerts = 0) OR (alert_level = 2 AND NEW.notify_urgent = 0));
END;

CREATE TRIGGER cancel_user_alerts AFTER UPDATE OF alert_unsubscribed, room_id, email ON users
WHEN (OLD.alert_unsubscribed = 0 AND NEW.alert_unsubscribed = 1) OR OLD.room_id IS NOT NEW.room_id OR OLD.email != NEW.email
BEGIN
  UPDATE outbox SET cancelled_at = unixepoch(), error = '收件人已退订或成员资料已变更'
  WHERE sent_at IS NULL AND cancelled_at IS NULL AND alert_user_id = NEW.id;
END;

CREATE TRIGGER cancel_deleted_user_alerts AFTER DELETE ON users
BEGIN
  UPDATE outbox SET cancelled_at = unixepoch(), error = '收件人账号已删除'
  WHERE sent_at IS NULL AND cancelled_at IS NULL AND alert_user_id = OLD.id;
END;
