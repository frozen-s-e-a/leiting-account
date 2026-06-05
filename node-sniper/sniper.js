#!/usr/bin/env node
'use strict';

/*
 * 雷霆交易平台 · 账号抢购（服务器端 Node 版）
 * ------------------------------------------------------------------
 * 移植自浏览器用户脚本 leiting-sniper.user.js v3.1，去掉 DOM / 油猴依赖，
 * 改为在 ECS 上用 keep-alive 长连接直调 /buybill/buy，公示期结束瞬间引爆。
 *
 * 抢号前置（务必）：先在浏览器里登录并「解锁钱包」（输一次支付密码），
 * 解锁状态绑定在 SESSION cookie 上。然后把 cookie/token 填进 config.json，
 * 趁解锁未过期（一般 5~30 分钟）启动本脚本。
 *
 * 用法：
 *   node sniper.js check        校验凭据 / 看钱包 / 测 RTT / 看校时偏差
 *   node sniper.js detail       拉 bill_detail，尝试探测公示结束时间与价格
 *   node sniper.js snipe        部署抢号（默认命令）
 *   node sniper.js test-email   发一封测试邮件
 *
 * 凭据与密钥只放在 config.json（已被 .gitignore 忽略），不要写进代码或提交。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// ====================== 配置 ======================
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('找不到 config.json。请先 `cp config.example.json config.json` 并填写。');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('config.json 不是合法 JSON：', e.message);
    process.exit(1);
  }
  // 命令行覆盖：--bill xxx --at "2026-06-05 20:00:00"
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bill') cfg.bill = args[++i];
    else if (args[i] === '--at') cfg.fireAt = args[++i];
    else if (args[i] === '--lead') cfg.fireLeadMs = Number(args[++i]);
  }
  cfg.apiBase = cfg.apiBase || 'https://fortunaapi.leitinggame.com.cn';
  cfg.gameCode = cfg.gameCode || 'xianP';
  cfg.itype = cfg.itype != null ? cfg.itype : 2;
  cfg.payType = cfg.payType != null ? cfg.payType : 2;
  cfg.maxBuyAttempts = cfg.maxBuyAttempts || 4;
  return cfg;
}

// ====================== 日志 ======================
function ts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间显示
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] ⚠`, ...a);
const errlog = (...a) => console.error(`[${ts()}] ✖`, ...a);

// ====================== HTTP 客户端（keep-alive 长连接） ======================
// 复用 TCP/TLS 连接，避免每次请求重新握手（冷启动握手约 110ms，复用后只剩 ~1 个 RTT）。
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  keepAliveMsecs: 30 * 1000,
});

let CFG = null; // 全局，requestApi 用

/**
 * 调用一个 API。返回 { status(http), json, raw, dateHeaderMs, t0, t1, rtt }。
 */
function requestApi(pathname, bodyObj, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, CFG.apiBase);
    const body = bodyObj == null ? '' : JSON.stringify(bodyObj);
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Origin': 'https://www.leitinggame.com.cn',
      'Referer': 'https://www.leitinggame.com.cn/',
      'gamecode': CFG.gameCode,
      'web-login-uid': CFG.uid || '',
      'web-login-token': CFG.token || '',
      'User-Agent': CFG.userAgent || 'Mozilla/5.0',
    };
    if (CFG.cookie) headers['Cookie'] = CFG.cookie;

    const t0 = Date.now();
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        agent,
        timeout: opts.timeout || 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t1 = Date.now();
          const raw = Buffer.concat(chunks).toString('utf8');
          const dateHdr = res.headers['date'];
          const dateHeaderMs = dateHdr ? new Date(dateHdr).getTime() : NaN;
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
          resolve({ status: res.statusCode, json, raw, dateHeaderMs, t0, t1, rtt: t1 - t0 });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 接口路径（与抓包一致）
const EP = {
  getMyMoney: '/user/get_my_money',
  billDetail: '/api/sellbill/bill_detail',
  checkPrice: '/api/sellbill/check_price',
  buyPrecheck: '/buybill/precheck',
  buyOrder: '/buybill/buy',
  buyLock: '/buybill/lock',
};

// ====================== 时间工具 ======================
// 北京时间字符串 → epoch ms
function parseBeijing(s) {
  if (!s || typeof s !== 'string') return NaN;
  const t = new Date(s.trim().replace(' ', 'T') + '+08:00').getTime();
  return isNaN(t) ? NaN : t;
}
function fmtBeijing(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

// ====================== 服务器校时 ======================
// HTTP Date 头只有「秒」精度，单点采样最差会偏 1 秒。这里用区间交集法：
// 每个样本给出 offset 的一个 [下界, 上界) 约束，多样本求交集把误差压到 ~RTT 量级。
//   设服务器盖戳时刻 S，对应本地时刻在 [t0, t1]，offset = S - 本地。
//   Date 头取整到秒得 serverSec，故 serverSec <= S < serverSec+1000。
//   推得：  serverSec - t1  <=  offset  <  serverSec + 1000 - t0
async function syncClock(samples = 12) {
  let lower = -Infinity, upper = Infinity;
  let rttMin = Infinity;
  let got = 0;
  for (let i = 0; i < samples; i++) {
    try {
      const r = await requestApi(EP.getMyMoney, null, { timeout: 4000 });
      if (!isNaN(r.dateHeaderMs)) {
        const lo = r.dateHeaderMs - r.t1;
        const hi = r.dateHeaderMs + 1000 - r.t0;
        if (lo > lower) lower = lo;
        if (hi < upper) upper = hi;
        rttMin = Math.min(rttMin, r.rtt);
        got++;
      }
    } catch (e) { /* 单次失败忽略 */ }
    await sleep(120);
  }
  if (!got || lower === -Infinity || upper === Infinity) {
    warn('校时失败，offset 视为 0');
    return { offset: 0, precision: NaN, rttMin: NaN };
  }
  const offset = Math.round((lower + upper) / 2);
  const precision = Math.round(upper - lower); // 区间宽度，越小越准
  return { offset, precision, rttMin };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================== 价格守门 ======================
function pickPrice(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['price', 'currentPrice', 'sellPrice', 'salePrice']) {
    if (obj[k] != null && !isNaN(Number(obj[k]))) return Number(obj[k]);
  }
  return null;
}
function pickPublicEnd(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['publicEndDate', 'publicEndTime', 'publicEnd', 'publicTime', 'publicEndAt']) {
    if (obj[k]) return obj[k];
  }
  return null;
}
// 兼容双层 JSON / 数组 / 嵌套
function normalize(raw) {
  let d = raw;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return null; } }
  if (Array.isArray(d)) d = d[0];
  if (d && typeof d === 'object') {
    if (!pickPublicEnd(d) && !pickPrice(d)) {
      for (const k of ['detail', 'bill', 'data', 'sellbill']) {
        if (d[k] && typeof d[k] === 'object') { d = d[k]; break; }
      }
    }
    return d;
  }
  return null;
}

async function fetchBillInfo(billId) {
  // 试 check_price 拿当前价；再试 bill_detail 探测公示结束时间
  const out = { price: null, publicEnd: null };
  try {
    const r = await requestApi(EP.checkPrice, { billId });
    if (r.json && r.json.status === 0) {
      const d = normalize(r.json.data || {});
      const p = pickPrice(d);
      if (p != null) out.price = p;
    }
  } catch (e) { /* ignore */ }
  for (const part of ['basic', 'all', undefined]) {
    try {
      const body = part ? { billId, part } : { billId };
      const r = await requestApi(EP.billDetail, body);
      if (r.json && r.json.status === 0) {
        const d = normalize(r.json.data);
        if (d) {
          if (out.price == null) out.price = pickPrice(d);
          if (!out.publicEnd) out.publicEnd = pickPublicEnd(d);
        }
        if (out.publicEnd) break;
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

// ====================== 邮件通知 ======================
let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  const e = CFG.email;
  if (!e || !e.enabled) { transporter = false; return false; }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (err) {
    warn('未安装 nodemailer，邮件通知不可用。请在 node-sniper 目录跑 `npm install`。');
    transporter = false;
    return false;
  }
  transporter = nodemailer.createTransport({
    host: e.host || 'smtp.gmail.com',
    port: e.port || 465,
    secure: e.secure !== false,
    auth: { user: e.user, pass: e.pass },
  });
  return transporter;
}
async function sendMail(subject, text) {
  const t = getTransporter();
  if (!t) { log(`（未发邮件）${subject} — ${text}`); return; }
  try {
    await t.sendMail({
      from: CFG.email.user,
      to: CFG.email.to || CFG.email.user,
      subject,
      text,
    });
    log(`📧 已发邮件：${subject}`);
  } catch (e) {
    errlog('发邮件失败：', e.message);
  }
}

// ====================== 抢号核心 ======================
async function doBuy(billId) {
  const body = { billId, itype: CFG.itype };
  let last = null;
  for (let attempt = 1; attempt <= CFG.maxBuyAttempts; attempt++) {
    try {
      const r = await requestApi(EP.buyOrder, body, { timeout: 4000 });
      last = r;
      log(`buy #${attempt} (${r.rtt}ms) → ${r.raw.slice(0, 300)}`);
      if (r.json && r.json.status === 0) return r; // 成功
      const msg = (r.json && r.json.message) || '';
      // 业务明确失败：不再重试（避免重复下单）
      if (/已售|已购|下架|不存在|失效|结束|被锁/.test(msg)) return r;
      // 仅对疑似瞬时错误重试
      if (!/过快|频繁|繁忙|稍后|重试|拥挤/.test(msg) && r.json) return r;
    } catch (e) {
      warn(`buy #${attempt} 异常：${e.message}`);
      last = { error: e.message };
    }
    await sleep(60);
  }
  return last;
}

async function doLock(billId, orderId) {
  try {
    const r = await requestApi(EP.buyLock, { billId, id: orderId, payType: CFG.payType });
    log(`lock → ${r.raw.slice(0, 200)}`);
    return r;
  } catch (e) {
    warn('lock 异常：', e.message);
    return null;
  }
}

async function fire(billId) {
  const t0 = Date.now();
  log(`🚀 fire ${billId}`);
  const r = await doBuy(billId);
  const elapsed = Date.now() - t0;

  if (!r || !r.json || r.json.status !== 0) {
    const msg = (r && r.json && r.json.message) || (r && r.error) || '未知错误';
    errlog(`抢购失败（${elapsed}ms）：${msg}`);
    await sendMail('❌ 雷霆抢购失败', `billId=${billId}\n原因：${msg}\n耗时：${elapsed}ms\n时间：${fmtBeijing(Date.now())}`);
    return false;
  }

  const data = r.json.data || {};
  const orderId = data.id || data.orderId || data.buyId || data.orderNo;
  log(`🎉 抢购成功（${elapsed}ms）订单号 ${orderId}`);

  let lockNote = '';
  if (CFG.autoLock && orderId) {
    const lr = await doLock(billId, orderId);
    lockNote = lr && lr.json ? `\nlock: ${lr.json.message || lr.json.status}` : '\nlock: (无响应)';
  }
  await sendMail(
    '🎉 雷霆抢购成功',
    `billId=${billId}\n订单号：${orderId}\n耗时：${elapsed}ms\n时间：${fmtBeijing(Date.now())}\n` +
    `请在 30 分钟内回浏览器完成支付。${lockNote}\n\nbuy 原始响应：\n${r.raw.slice(0, 800)}`
  );
  return true;
}

// 高精度等待到目标本地时刻后引爆：setTimeout 粗等到剩 50ms，再忙等收尾。
function spinFireAt(targetLocalMs, billId) {
  return new Promise((resolve) => {
    const coarse = targetLocalMs - 50 - Date.now();
    const run = () => {
      while (Date.now() < targetLocalMs) { /* busy spin，最多约 50ms */ }
      fire(billId).then(resolve);
    };
    if (coarse > 0) setTimeout(run, coarse);
    else run();
  });
}

// ====================== 命令 ======================
async function cmdCheck() {
  log('校验凭据 + 测速 + 校时…');
  const r = await requestApi(EP.getMyMoney, null);
  if (!r.json) { errlog('响应非 JSON：', r.raw.slice(0, 200)); return; }
  if (r.json.status !== 0) {
    errlog(`凭据无效：status=${r.json.status} message=${r.json.message}`);
    errlog('→ 多半是 cookie/token 过期，回浏览器重新复制。');
    return;
  }
  const money = (r.json.data && (r.json.data.amount != null ? r.json.data.amount : JSON.stringify(r.json.data)));
  log(`✅ 凭据有效。钱包：${money}`);
  const clk = await syncClock();
  log(`⏱ 校时 offset=${clk.offset}ms（精度±${Math.round(clk.precision / 2)}ms），最快 RTT=${clk.rttMin}ms`);
  log(`服务器当前时间约：${fmtBeijing(Date.now() + clk.offset)}`);
}

async function cmdDetail() {
  if (!CFG.bill) { errlog('config 里没有 bill'); return; }
  const info = await fetchBillInfo(CFG.bill);
  log('探测结果：', info);
  if (info.publicEnd) log(`公示结束时间 → ${info.publicEnd}（可填进 config.fireAt）`);
  else warn('未能自动探测公示结束时间，请手动在 config.fireAt 填写。');
}

async function cmdTestEmail() {
  await sendMail('✅ 雷霆抢号机测试邮件', `这是一封测试邮件。\n时间：${fmtBeijing(Date.now())}`);
}

async function cmdSnipe() {
  if (!CFG.bill) { errlog('config 里没有 bill'); process.exit(1); }

  // 1) 校验凭据
  const chk = await requestApi(EP.getMyMoney, null);
  if (!chk.json || chk.json.status !== 0) {
    errlog(`凭据无效：${chk.json ? chk.json.message : chk.raw.slice(0, 120)}。请刷新 cookie/token。`);
    process.exit(1);
  }
  log('✅ 凭据有效');

  // 2) 确定开抢时间
  let fireAt = parseBeijing(CFG.fireAt);
  if (isNaN(fireAt)) {
    log('config.fireAt 为空，尝试自动探测…');
    const info = await fetchBillInfo(CFG.bill);
    if (info.publicEnd) { fireAt = parseBeijing(info.publicEnd); log(`探测到公示结束：${info.publicEnd}`); }
  }
  if (isNaN(fireAt)) {
    errlog('无法确定开抢时间。请在 config.fireAt 手动填写北京时间，如 "2026-06-05 20:00:00"。');
    process.exit(1);
  }

  // 3) 校时
  const clk = await syncClock();
  log(`⏱ offset=${clk.offset}ms（精度±${Math.round(clk.precision / 2)}ms）最快 RTT=${clk.rttMin}ms`);

  const lead = CFG.fireLeadMs != null ? CFG.fireLeadMs
    : (isFinite(clk.rttMin) ? Math.round(clk.rttMin / 2) : 20); // 单程延迟补偿
  const targetLocal = fireAt - clk.offset - lead;
  const remain = targetLocal - Date.now();
  log(`🎯 目标(服务器)：${fmtBeijing(fireAt)}`);
  log(`   本地引爆点：${fmtBeijing(targetLocal)}（提前量 lead=${lead}ms）`);
  log(`   倒计时：${(remain / 1000).toFixed(1)}s`);

  if (remain <= 0) {
    warn('已过开抢时间，立即尝试一次。');
    await fire(CFG.bill);
    return;
  }

  // 4) 可选：价格守门（提前 ~8s 检查改价）
  if (CFG.expectPrice != null) {
    const checkAt = Math.max(0, remain - 8000);
    setTimeout(async () => {
      const info = await fetchBillInfo(CFG.bill);
      if (info.price != null) {
        const diff = Math.abs(info.price - CFG.expectPrice);
        if (diff > (CFG.priceTolerance || 0)) {
          errlog(`价格已变 ¥${CFG.expectPrice} → ¥${info.price}，超过容差，中止抢号！`);
          await sendMail('❌ 雷霆抢号已中止（改价）', `期望 ¥${CFG.expectPrice}，当前 ¥${info.price}`);
          process.exit(0);
        }
        log(`价格校验通过：¥${info.price}`);
      } else warn('价格校验取价失败，继续抢号。');
    }, checkAt);
  }

  // 5) 连接预热：最后 30s 每 3s 发一次轻请求，保持 socket 热 + 持续校时
  const warmStart = Math.max(0, remain - 30000);
  setTimeout(function warmLoop() {
    const left = targetLocal - Date.now();
    if (left <= 200) return;
    requestApi(EP.getMyMoney, null).catch(() => {});
    setTimeout(warmLoop, 3000);
  }, warmStart);

  // 6) 引爆
  log('部署完成，等待引爆…（Ctrl-C 取消）');
  await spinFireAt(targetLocal, CFG.bill);
}

// ====================== 入口 ======================
(async function main() {
  CFG = loadConfig();
  const cmd = process.argv[2] || 'snipe';
  try {
    if (cmd === 'check') await cmdCheck();
    else if (cmd === 'detail') await cmdDetail();
    else if (cmd === 'test-email') await cmdTestEmail();
    else if (cmd === 'snipe') await cmdSnipe();
    else { console.error(`未知命令：${cmd}（可用：check | detail | snipe | test-email）`); process.exit(1); }
  } catch (e) {
    errlog('致命错误：', e && e.stack ? e.stack : e);
    process.exit(1);
  }
  // snipe 走到这里若还有定时器会继续等；其他命令自然退出
})();
