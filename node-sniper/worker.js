#!/usr/bin/env node
'use strict';

/*
 * 抢号 worker(按需进程):由 bridge.js 为每个任务 spawn 一个,抢完(或 taskLingerMin
 * 分钟后)自行退出。重逻辑在 core.js。
 *
 * 凭据来自 .creds.json(bridge 在 /sync 时写入),并实时监听:解锁后浏览器重新同步,
 * bridge 更新该文件,worker 热加载 → 引爆时用的是解锁后的最新 cookie。
 *
 * 用法(一般由 bridge 调用,不手动跑):
 *   node worker.js '{"bill":"...","fireAt":"2026-06-05 20:00:00","name":"...","expectPrice":500}'
 */

const fs = require('fs');
const path = require('path');
const core = require('./core');
const { log, warn, errlog, parseBeijing, mask, applyCreds } = core;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CREDS_PATH = path.join(__dirname, '.creds.json');

function pickCreds(o) {
  const c = {};
  for (const k of ['cookie', 'token', 'uid', 'userAgent']) if (o && o[k]) c[k] = o[k];
  return c;
}
function loadCredsFile() { try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch (e) { return null; } }

let CFG;
try { CFG = core.loadConfigFile(CONFIG_PATH); } catch (e) { console.error(e.message); process.exit(1); }
Object.assign(CFG, pickCreds(loadCredsFile()));   // 覆盖凭据(文件优先于 config.json)
core.configure(CFG);

const task = JSON.parse(process.argv[2] || '{}');
if (!task.bill) { errlog('worker 缺 bill'); process.exit(1); }
const fireAtMs = parseBeijing(task.fireAt);
if (isNaN(fireAtMs)) { errlog('worker fireAt 非法(需北京时间)'); process.exit(1); }
CFG.bill = task.bill;   // 让 heartbeat/校时用这个 bill 的 bill_detail

// 监听凭据文件:解锁后重新同步 → 热加载
fs.watchFile(CREDS_PATH, { interval: 1000 }, () => {
  const o = loadCredsFile();
  if (o && applyCreds(pickCreds(o))) log(`🔄 worker 凭据热更新(cookie=${mask(CFG.cookie)})`);
});

let handle = null;
function shutdown(code) {
  try { if (handle) handle.cancel(); } catch (e) {}
  try { fs.unwatchFile(CREDS_PATH); } catch (e) {}
  process.exit(code || 0);
}
process.on('SIGTERM', () => { log('worker 收到 SIGTERM,退出'); shutdown(0); });
process.on('SIGINT', () => shutdown(0));

(async () => {
  const lingerMin = (CFG.bridge && CFG.bridge.taskLingerMin != null) ? CFG.bridge.taskLingerMin : 40;
  log(`worker 启动:${task.name || task.bill} 开抢 ${task.fireAt}(干完 ${lingerMin > 0 ? lingerMin + ' 分钟后退出' : '立即退出'})`);
  try {
    handle = await core.deploySnipe(
      { bill: task.bill, fireAtMs, name: task.name || task.bill, expectPrice: task.expectPrice, priceTolerance: task.priceTolerance },
      { onComplete: (success) => {
          log(`任务完成:${success ? '成功' : '失败'}`);
          if (lingerMin > 0) setTimeout(() => shutdown(0), lingerMin * 60000);
          else shutdown(0);
        } }
    );
    log('worker 部署完成,等待引爆…');
  } catch (e) { errlog('worker 部署失败:', e.message); shutdown(1); }
})();
