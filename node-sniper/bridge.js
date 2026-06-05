#!/usr/bin/env node
'use strict';

/*
 * 抢号桥接守护进程(跑在 ECS 上,常驻监听)。
 *
 * 浏览器用户脚本把「凭据 + 抢号任务」通过 HTTP 推到这里:
 *   POST /sync   { cookie, uid, token, userAgent }            登录后/解锁后各同步一次
 *   POST /task   { bill, fireAt, name, expectPrice, ... , creds? }  下发并启动抢号任务
 *   GET  /status                                              查看任务/凭据/状态
 *   POST /cancel { bill }                                     取消任务
 *
 * 所有请求必须带头 `X-Sniper-Secret: <config.bridge.secret>`,否则 401。
 * 抢号结束且无其它任务后,空闲 idleShutdownMin 分钟自动退出(默认 40)。
 *
 * 安全:这是会接收你 cookie 的端口。务必:
 *   1) config.bridge.secret 用足够长的随机串
 *   2) 在云安全组把该端口只放行你家/常用 IP
 *   3) 不要把它暴露给不可信网络
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const core = require('./core');
const { log, warn, errlog, fmtBeijing, parseBeijing, mask } = core;

const CONFIG_PATH = path.join(__dirname, 'config.json');

let CFG;
try { CFG = core.loadConfigFile(CONFIG_PATH); }
catch (e) { console.error(e.message); process.exit(1); }
core.configure(CFG);

const B = CFG.bridge || {};
const PORT = B.port || 8787;
const HOST = B.host || '0.0.0.0';          // SSH 隧道方案改成 '127.0.0.1'
const SECRET = B.secret || '';
const IDLE_MIN = B.idleShutdownMin != null ? B.idleShutdownMin : 40;

if (!SECRET || SECRET.length < 16) {
  console.error('请在 config.json 的 bridge.secret 设一个 ≥16 位的随机密钥。例如:');
  console.error('  ' + crypto.randomBytes(24).toString('base64url'));
  process.exit(1);
}

// ====================== 任务状态 ======================
const tasks = {};   // bill -> { handle, meta }
let shutdownTimer = null;

function pendingCount() {
  return Object.values(tasks).filter((t) => t.handle && ['deploying', 'scheduled', 'firing'].includes(t.handle.status)).length;
}
function armIdleShutdown() {
  if (IDLE_MIN <= 0) return;                 // 0 = 永不自动退出
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    if (pendingCount() === 0) { log(`空闲 ${IDLE_MIN} 分钟,关闭服务`); process.exit(0); }
    else armIdleShutdown();
  }, IDLE_MIN * 60000);
  log(`⏳ 已设空闲关机:无任务则 ${IDLE_MIN} 分钟后退出`);
}
function cancelIdleShutdown() { if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; } }

// ====================== HTTP ======================
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''; let tooBig = false;
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => { if (tooBig) return reject(new Error('body too large')); try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress;
  // 鉴权
  if (!safeEqual(req.headers['x-sniper-secret'] || '', SECRET)) {
    warn(`401 来自 ${ip} ${req.method} ${req.url}`);
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }
  const url = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET' && url === '/status') {
      return send(res, 200, {
        ok: true,
        creds: { cookie: mask(CFG.cookie), uid: CFG.uid || null, token: mask(CFG.token) },
        tasks: Object.entries(tasks).map(([bill, t]) => ({ bill, name: t.meta.name, fireAt: t.meta.fireAt, status: t.handle ? t.handle.status : '?' })),
        idleShutdownMin: IDLE_MIN,
      });
    }

    if (req.method === 'POST' && url === '/sync') {
      const body = await readBody(req);
      const creds = {};
      for (const k of ['cookie', 'token', 'uid', 'userAgent']) if (body[k]) creds[k] = body[k];
      if (!creds.cookie && !creds.token) return send(res, 400, { ok: false, error: 'no creds' });
      const changed = core.applyCreds(creds);
      log(`🔄 /sync 来自 ${ip} ${changed ? '凭据已更新' : '凭据未变'}(cookie=${mask(CFG.cookie)})`);
      return send(res, 200, { ok: true, changed });
    }

    if (req.method === 'POST' && url === '/task') {
      const body = await readBody(req);
      // 允许随任务带上最新凭据
      const creds = {};
      for (const k of ['cookie', 'token', 'uid', 'userAgent']) if (body[k]) creds[k] = body[k];
      if (Object.keys(creds).length) core.applyCreds(creds);

      const bill = body.bill;
      const fireAtMs = parseBeijing(body.fireAt);
      if (!bill) return send(res, 400, { ok: false, error: 'no bill' });
      if (isNaN(fireAtMs)) return send(res, 400, { ok: false, error: 'bad fireAt(需北京时间,如 2026-06-05 20:00:00)' });
      if (!CFG.cookie && !CFG.token) return send(res, 400, { ok: false, error: '尚未同步凭据,先 /sync' });

      if (tasks[bill] && tasks[bill].handle) tasks[bill].handle.cancel();
      cancelIdleShutdown();
      const meta = { name: body.name || bill, fireAt: body.fireAt };
      log(`📥 /task 来自 ${ip}:${meta.name} bill=${bill} 开抢 ${body.fireAt}`);
      const handle = await core.deploySnipe(
        { bill, fireAtMs, name: meta.name, expectPrice: body.expectPrice != null ? body.expectPrice : CFG.expectPrice, priceTolerance: body.priceTolerance != null ? body.priceTolerance : CFG.priceTolerance },
        { onComplete: (success) => {
            log(`任务完成 ${meta.name}:${success ? '成功' : '失败'}`);
            delete tasks[bill];
            if (pendingCount() === 0) armIdleShutdown();
          } }
      );
      tasks[bill] = { handle, meta };
      return send(res, 200, { ok: true, bill, fireAt: body.fireAt, status: handle.status });
    }

    if (req.method === 'POST' && url === '/cancel') {
      const body = await readBody(req);
      const bill = body.bill;
      if (bill && tasks[bill]) { tasks[bill].handle.cancel(); delete tasks[bill]; log(`🛑 已取消 ${bill}`); if (pendingCount() === 0) armIdleShutdown(); return send(res, 200, { ok: true }); }
      return send(res, 404, { ok: false, error: 'no such task' });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    errlog('处理请求出错:', e.message);
    return send(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`🌉 抢号桥已启动:监听 ${HOST}:${PORT}`);
  log(`   接口:POST /sync · POST /task · GET /status · POST /cancel(均需 X-Sniper-Secret)`);
  if (HOST === '0.0.0.0') warn('正在公网监听!请确认安全组已把该端口限制到你的 IP,且 secret 足够强。');
  armIdleShutdown();
});
