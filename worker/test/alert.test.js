import { test } from "node:test";
import assert from "node:assert/strict";
import { alertCooling, ALERT_COOLDOWN } from "../src/util.js";

const T = 1790611200;

test("没发过提醒：不冷却", () => {
  assert.equal(alertCooling(null, 1, T), false);
});

test("刚发过同级或更高级提醒：冷却期内挡住", () => {
  assert.equal(alertCooling({ level: 1, at: T }, 1, T + 3600), true);
  assert.equal(alertCooling({ level: 2, at: T }, 1, T + 3600), true);
  assert.equal(alertCooling({ level: 2, at: T }, 2, T + ALERT_COOLDOWN - 1), true);
});

test("升级到更高级别（1 -> 2）不受冷却影响，临停提醒必须发", () => {
  assert.equal(alertCooling({ level: 1, at: T }, 2, T + 60), false);
});

test("冷却期过后可以再发", () => {
  assert.equal(alertCooling({ level: 1, at: T }, 1, T + ALERT_COOLDOWN), false);
  assert.equal(alertCooling({ level: 2, at: T }, 2, T + ALERT_COOLDOWN + 1), false);
});
