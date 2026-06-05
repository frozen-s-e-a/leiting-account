#!/usr/bin/env node
'use strict';

/*
 * 抢号桥接守护进程(常驻 ECS,只负责监听端口 + 派活,自身永不退出)。
 *
 * 浏览器用户脚本把「凭据 + 抢号任务」HTTP 推过来:
 *   POST /sync   { cookie, uid, token, userAgent }       登录后/解锁后各同步一次 → 写 .creds.json
 *   POST /task   { bill, fireAt, name, expectPrice, ... } 为该任务 spawn 一个 worker 进程
 *   GET  /status                                          查看在跑的 worker / 凭据
 *   POST /cancel { bill }                                 杀掉对应 worker
 *
 * 所有请求必须带头 `X-Sniper-Secret: <config.bridge.secret>`,否则 401。
 * 真正抢号在按需 worker 进程里(worker.js),抢完(或 taskLingerMin 分钟后)worker 自退,
 * bridge 始终在线监听。
 *
 * 安全:这是会接收你 cookie 的端口。务必:
 *   1) bridge.secret 用足够长的随机串
 *   2) 云安全组把该端口只放行你家/常用 IP
 *   3) 别暴露给不可信网络
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./core');
const { log, warn, errlog, parseBeijing, mask } = core;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CREDS_PATH = path.join(__dirname, '.creds.json');
const WORKER = path.join(__dirname, 'worker.js');

let CFG;
try { CFG = core.loadConfigFile(CONFIG_PATH); }
catch (e) { console.error(e.message); process.exit(1); }
core.configure(CFG);

const B = CFG.bridge || {};
const PORT = B.port || 8787;
const HOST = B.host || '0.0.0.0';          // SSH 隧道方案改 '127.0.0.1'
const SECRET = B.secret || '';

if (!SECRET || SECRET.length < 16) {
  console.error('请在 config.json 的 bridge.secret 设一个 ≥16 位随机密钥。例如:');
  console.error('  ' + crypto.randomBytes(24).toString('base64url'));
  process.exit(1);
}

// ====================== 凭据文件(与 worker 共享) ======================
function pickCreds(o) { const c = {}; for (const k of ['cookie', 'token', 'uid', 'userAgent']) if (o && o[k]) c[k] = o[k]; return c; }
function writeCredsFile(creds) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch (e) {}
  Object.assign(cur, creds);
  fs.writeFileSync(CREDS_PATH, JSON.stringify(cur, null, 2), { mode: 0o600 });
}

// ====================== worker 管理 ======================
const workers = {};  // bill -> { child, meta }

function spawnWorker(task) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(task)], { cwd: __dirname, stdio: 'inherit' });
  workers[task.bill] = { child, meta: { name: task.name, fireAt: task.fireAt, pid: child.pid, since: Date.now() } };
  child.on('exit', (code, sig) => { log(`worker(${task.bill}) 退出 code=${code} sig=${sig || ''}`); delete workers[task.bill]; });
  child.on('error', (e) => { errlog(`worker(${task.bill}) 启动失败:${e.message}`); delete workers[task.bill]; });
  return child;
}

// ====================== HTTP ======================
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '', tooBig = false;
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => { if (tooBig) return reject(new Error('body too large')); try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress;
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
        workers: Object.entries(workers).map(([bill, w]) => ({ bill, ...w.meta })),
      });
    }

    if (req.method === 'POST' && url === '/sync') {
      const body = await readBody(req);
      const creds = pickCreds(body);
      if (!creds.cookie && !creds.token) return send(res, 400, { ok: false, error: 'no creds' });
      core.applyCreds(creds);      // 更新 bridge 自身(用于 /status 显示)
      writeCredsFile(creds);       // 落盘,供 worker 读取/热加载
      log(`🔄 /sync 来自 ${ip}(cookie=${mask(CFG.cookie)})`);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/task') {
      const body = await readBody(req);
      const creds = pickCreds(body);
      if (Object.keys(creds).length) { core.applyCreds(creds); writeCredsFile(creds); }

      const bill = body.bill;
      if (!bill) return send(res, 400, { ok: false, error: 'no bill' });
      if (isNaN(parseBeijing(body.fireAt))) return send(res, 400, { ok: false, error: 'bad fireAt(需北京时间,如 2026-06-05 20:00:00)' });
      let haveCreds = CFG.cookie || CFG.token;
      if (!haveCreds) { try { haveCreds = !!pickCreds(JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))).cookie; } catch (e) {} }
      if (!haveCreds) return send(res, 400, { ok: false, error: '尚未同步凭据,先 /sync' });

      if (workers[bill]) { try { workers[bill].child.kill('SIGTERM'); } catch (e) {} }   // 同号重发:替换
      const task = { bill, fireAt: body.fireAt, name: body.name || bill, expectPrice: body.expectPrice, priceTolerance: body.priceTolerance };
      log(`📥 /task 来自 ${ip}:${task.name} bill=${bill} 开抢 ${body.fireAt} → 启动 worker`);
      const child = spawnWorker(task);
      return send(res, 200, { ok: true, bill, fireAt: body.fireAt, pid: child.pid });
    }

    if (req.method === 'POST' && url === '/cancel') {
      const body = await readBody(req);
      const bill = body.bill;
      if (bill && workers[bill]) { try { workers[bill].child.kill('SIGTERM'); } catch (e) {} log(`🛑 已取消 ${bill}`); return send(res, 200, { ok: true }); }
      return send(res, 404, { ok: false, error: 'no such task' });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    errlog('处理请求出错:', e.message);
    return send(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`🌉 抢号桥已启动(常驻):监听 ${HOST}:${PORT}`);
  log('   接口:POST /sync · POST /task · GET /status · POST /cancel(均需 X-Sniper-Secret)');
  if (HOST === '0.0.0.0') warn('正在公网监听!请确认安全组已把该端口限制到你的 IP,且 secret 足够强。');
});
