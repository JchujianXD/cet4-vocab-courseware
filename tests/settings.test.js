"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const settings = source.slice(source.indexOf("const DEFAULTS ="), source.indexOf("function setS("));

test("新用户默认学习量与已保存设置兼容", () => {
  const load = entries => vm.runInNewContext(settings + "\nloadSettings(); S", {Sync: {entries: () => entries}});
  const fresh = load([]);
  assert.deepEqual([fresh.dailyCap, fresh.dailyMinutes, fresh.roundSize], [40, 20, 20]);
  const saved = load([["dailyCap", 120], ["dailyMinutes", 30], ["roundSize", 0]]);
  assert.deepEqual([saved.dailyCap, saved.dailyMinutes, saved.roundSize], [120, 30, 0]);
});
