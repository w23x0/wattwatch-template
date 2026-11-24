import { test } from "node:test";
import assert from "node:assert/strict";
import { auditData, backtest } from "../../scripts/audit-data.mjs";
import { DAY, HOUR, dayStart, encodeDay, newModel, update, calendar, pack, forecast } from "../public/js/model.js";

const T0 = 1790611200;
test("数据审计报告缺采、同小时变化和坏归档，不输出寝室标识", () => {
  const points = [[T0 + 1200, 20], [T0 + 1800, 19.9], [T0 + 3 * HOUR + 1200, 19]];
  const m = newModel();
  for (const [t, b] of points) update(m, t, b, calendar());
  const { quality, series } = auditData({
    rooms: [{ id: 1, model: pack(m), forecast: JSON.stringify(forecast(m, 19, calendar())), balance_at: points.at(-1)[0] }],
    days: [{ room_id: 1, day: T0, v: encodeDay(T0, points) }, { room_id: 1, day: T0 - DAY, v: "broken" }],
  }, { now: T0 + 4 * HOUR });
  assert.equal(quality.readings, 3);
  assert.equal(quality.missingMeterHours, 2);
  assert.equal(quality.sameHourChanges, 1);
  assert.equal(quality.malformedDays, 1);
  assert.equal(quality.invalidModels, 0);
  assert.equal(quality.invalidForecasts, 0);
  assert.deepEqual(series, [points]);
  assert.equal(quality.room_id, undefined);
});

test("回测只结算到期窗口，跳过缺采与充值，不用未来共享先验", () => {
  const points = Array.from({ length: 12 * 24 }, (_, i) => [T0 + i * HOUR + 1200, 200 - i * 0.25]);
  const complete = backtest([points]);
  assert.ok(complete[24].windows > 20);
  const missing = points.filter(([t]) => dayStart(t) !== T0 + 9 * DAY);
  assert.ok(backtest([missing])[24].windows < complete[24].windows);
  const charged = points.map(([t, b]) => [t, t >= T0 + 9 * DAY ? b + 100 : b]);
  assert.ok(backtest([charged])[24].windows < complete[24].windows);
  assert.equal(backtest([])[24].wapePercent, null);
});
