ALTER TABLE rooms ADD COLUMN notify_alerts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN notify_urgent INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN alert_unsubscribed INTEGER NOT NULL DEFAULT 0;

-- 沿用成员页显示的开关状态：旧记录里有一人关闭，该档就显示为关闭。
UPDATE rooms SET notify_alerts = settings.alerts, notify_urgent = settings.urgent
FROM (
  SELECT room_id, MIN(alerts) AS alerts, MIN(urgent) AS urgent
  FROM users WHERE room_id IS NOT NULL GROUP BY room_id
) AS settings
WHERE rooms.id = settings.room_id;
