import { test } from "node:test";
import assert from "node:assert/strict";
import { pollerFailHint, pollerFailText } from "../src/util.js";

const TOKEN_HINT = "请重新抓取并更新本机 token";
const NOT_TOKEN = "不是 token 过期";

test("TLS / 网络错误：不误报成 token 过期", () => {
  const msg = "<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1081)>";
  const hint = pollerFailHint(msg);
  assert.match(hint, new RegExp(NOT_TOKEN));
  assert.doesNotMatch(hint, new RegExp(TOKEN_HINT));
});

test("明确的 token 错误：提示重抓 token", () => {
  for (const msg of [
    "TOKEN ERROR /elecWater/getBalance -> code=300",
    "/elecWater/getBalance -> code=300 token 无效",
    "/elecWater/getBalance -> code = 300",
  ]) {
    assert.match(pollerFailHint(msg), new RegExp(TOKEN_HINT));
  }
});

test("没有错误信息时按非 token 问题排查", () => {
  assert.match(pollerFailHint(""), new RegExp(NOT_TOKEN));
});

test("失败邮件保留真实错误与成功/失败计数", () => {
  const text = pollerFailText({
    at: 1790611200, msg: "<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred>", polled: 0, failed: 6,
  }, 1790611200);
  assert.match(text, /UNEXPECTED_EOF_WHILE_READING/);
  assert.match(text, /本轮成功 0 间，失败 6 间/);
  assert.match(text, /直连 api\.etslink\.net/);
  assert.doesNotMatch(text, new RegExp(TOKEN_HINT));
});

test("token 失败的邮件仍提示重抓 token", () => {
  const text = pollerFailText({ at: 1790611200, msg: "TOKEN ERROR code=300", polled: 0, failed: 6 }, 1790611200);
  assert.match(text, new RegExp(TOKEN_HINT));
});
