'use strict';

/*
 * 抢号核心:HTTP 客户端、校时、买/锁、通知、凭据解析、部署调度。
 * 被 CLI(sniper.js)和服务端守护(bridge.js)共用。
 *
 * 用法:core.configure(cfg) 注入配置对象(按引用持有,外部热改 cfg.cookie 等即时生效),
 *       然后调用 core.deploySnipe(task, hooks) / core.fire(...) 等。
 */

const fs = require('fs');
const https = require('https');
const { URL } = require('url');

// ====================== 配置(按引用持有) ======================
let CFG = {};
function configure(cfg) { CFG = cfg; return CFG; }
function getConfig() { return CFG; }

// 读取 config.json 并补默认值(不处理命令行)
function loadConfigFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`找不到配置文件:${p}（先 cp config.example.json config.json 并填写）`);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.apiBase = cfg.apiBase || 'https://fortunaapi.leitinggame.com.cn';
  cfg.gameCode = cfg.gameCode || 'xianP';
  cfg.itype = cfg.itype != null ? cfg.itype : 2;
  cfg.payType = cfg.payType != null ? cfg.payType : 2;
  cfg.maxBuyAttempts = cfg.maxBuyAttempts || 4;
  return cfg;
}

// ====================== 日志 ======================
function ts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] ⚠`, ...a);
const errlog = (...a) => console.error(`[${ts()}] ✖`, ...a);

// ====================== HTTP 客户端(keep-alive) ======================
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30 * 1000 });

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
      { method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers, agent, timeout: opts.timeout || 5000 },
      (res) => {
        const tHeaders = Date.now(); // 收到响应头瞬间(Date 头到手),校时上界用它排除 body 下载耗时
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t1 = Date.now();
          const raw = Buffer.concat(chunks).toString('utf8');
          const dateHdr = res.headers['date'];
          const dateHeaderMs = dateHdr ? new Date(dateHdr).getTime() : NaN;
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
          resolve({ status: res.statusCode, json, raw, dateHeaderMs, t0, tHeaders, t1, rtt: t1 - t0, ttfb: tHeaders - t0 });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const EP = {
  getMyMoney: '/user/get_my_money',
  billDetail: '/api/sellbill/bill_detail',
  checkPrice: '/api/sellbill/check_price',
  buyPrecheck: '/buybill/precheck',
  buyOrder: '/buybill/buy',
  buyLock: '/buybill/lock',
};

// ====================== 时间 ======================
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================== 价格/字段 ======================
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
  const out = { price: null, publicEnd: null };
  try {
    const r = await requestApi(EP.checkPrice, { billId });
    if (r.json && r.json.status === 0) { const p = pickPrice(normalize(r.json.data || {})); if (p != null) out.price = p; }
  } catch (e) { /* ignore */ }
  for (const part of ['basic', 'all', undefined]) {
    try {
      const r = await requestApi(EP.billDetail, part ? { billId, part } : { billId });
      if (r.json && r.json.status === 0) {
        const d = normalize(r.json.data);
        if (d) { if (out.price == null) out.price = pickPrice(d); if (!out.publicEnd) out.publicEnd = pickPublicEnd(d); }
        if (out.publicEnd) break;
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

// ====================== 探针/校时 ======================
function heartbeatProbe() {
  if (CFG.bill) return requestApi(EP.billDetail, { billId: CFG.bill, part: 'basic' }, { timeout: 4000 });
  return requestApi(EP.getMyMoney, null, { timeout: 4000 });
}
function probeBill(billId) {
  return requestApi(EP.billDetail, { billId, part: 'basic' }, { timeout: 4000 });
}
async function walletUnlocked() {
  try {
    const r = await requestApi(EP.getMyMoney, null, { timeout: 4000 });
    return { ok: !!(r.json && r.json.status === 0), message: r.json && r.json.message };
  } catch (e) { return { ok: false, message: e.message }; }
}
// 区间交集法校时(Date 头仅秒精度):serverSec - tHeaders <= offset < serverSec + 1000 - t0
async function syncClock(probe, samples = 12) {
  probe = probe || heartbeatProbe;
  let lower = -Infinity, upper = Infinity, rttMin = Infinity, got = 0;
  for (let i = 0; i < samples; i++) {
    try {
      const r = await probe();
      if (!isNaN(r.dateHeaderMs)) {
        lower = Math.max(lower, r.dateHeaderMs - r.tHeaders);
        upper = Math.min(upper, r.dateHeaderMs + 1000 - r.t0);
        rttMin = Math.min(rttMin, r.ttfb);
        got++;
      }
    } catch (e) { /* ignore */ }
    await sleep(120);
  }
  if (!got || lower === -Infinity || upper === Infinity) { warn('校时失败,offset=0'); return { offset: 0, precision: NaN, rttMin: NaN }; }
  return { offset: Math.round((lower + upper) / 2), precision: Math.round(upper - lower), rttMin };
}

// ====================== 通知 ======================
let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  const e = CFG.email;
  if (!e || !e.enabled) { transporter = false; return false; }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (err) { warn('未安装 nodemailer,邮件不可用(npm install)'); transporter = false; return false; }
  transporter = nodemailer.createTransport({
    host: e.host || 'smtp.gmail.com', port: e.port || 465, secure: e.secure !== false,
    auth: { user: e.user, pass: e.pass },
  });
  return transporter;
}
async function sendMail(subject, text) {
  const t = getTransporter();
  if (!t) { log(`(未发邮件)${subject} — ${text}`); return; }
  try {
    await t.sendMail({ from: CFG.email.user, to: CFG.email.to || CFG.email.user, subject, text });
    log(`📧 已发邮件:${subject}`);
  } catch (e) { errlog('发邮件失败:', e.message); }
}

// ====================== 凭据 ======================
function parseCurl(text) {
  const out = {};
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  out.cookie = pick(/(?:-b|--cookie)\s+'([^']*)'/i) || pick(/-H\s+'cookie:\s*([^']*)'/i);
  out.token = pick(/-H\s+'web-login-token:\s*([^']*)'/i);
  out.uid = pick(/-H\s+'web-login-uid:\s*([^']*)'/i);
  out.userAgent = pick(/-H\s+'user-agent:\s*([^']*)'/i);
  if (!out.uid && out.cookie) {
    const m = out.cookie.match(/ltl_formal_account=([^;]+)/);
    if (m) { try { const j = JSON.parse(decodeURIComponent(m[1])); if (j.uid) out.uid = String(j.uid); if (!out.token && j.token) out.token = String(j.token); } catch (e) {} }
  }
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  return out;
}
const mask = (s) => (s && s.length > 12 ? s.slice(0, 6) + '***' + s.slice(-4) : (s ? '***' : '(空)'));
// 把凭据合并进 CFG(热生效)
function applyCreds(creds) {
  let changed = false;
  for (const k of ['cookie', 'token', 'uid', 'userAgent']) {
    if (creds[k] && creds[k] !== CFG[k]) { CFG[k] = creds[k]; changed = true; }
  }
  return changed;
}

// ====================== 买/锁/引爆 ======================
async function doBuy(billId) {
  const body = { billId, itype: CFG.itype };
  let last = null;
  for (let attempt = 1; attempt <= CFG.maxBuyAttempts; attempt++) {
    try {
      const r = await requestApi(EP.buyOrder, body, { timeout: 4000 });
      last = r;
      log(`buy #${attempt} (${r.rtt}ms) → ${r.raw.slice(0, 300)}`);
      if (r.json && r.json.status === 0) return r;
      const msg = (r.json && r.json.message) || '';
      if (/已售|已购|下架|不存在|失效|结束|被锁/.test(msg)) return r;       // 明确失败:停,防重复下单
      if (!/过快|频繁|繁忙|稍后|重试|拥挤/.test(msg) && r.json) return r;     // 非瞬时错误:停
    } catch (e) { warn(`buy #${attempt} 异常:${e.message}`); last = { error: e.message }; }
    await sleep(60);
  }
  return last;
}
async function doLock(billId, orderId) {
  try { const r = await requestApi(EP.buyLock, { billId, id: orderId, payType: CFG.payType }); log(`lock → ${r.raw.slice(0, 200)}`); return r; }
  catch (e) { warn('lock 异常:', e.message); return null; }
}
async function fire(billId, name) {
  const t0 = Date.now();
  log(`🚀 fire ${billId}`);
  const r = await doBuy(billId);
  const elapsed = Date.now() - t0;
  if (!r || !r.json || r.json.status !== 0) {
    const msg = (r && r.json && r.json.message) || (r && r.error) || '未知错误';
    errlog(`抢购失败(${elapsed}ms):${msg}`);
    await sendMail('❌ 雷霆抢购失败', `${name || billId}\nbillId=${billId}\n原因:${msg}\n耗时:${elapsed}ms\n时间:${fmtBeijing(Date.now())}`);
    return { success: false, message: msg };
  }
  const data = r.json.data || {};
  const orderId = data.id || data.orderId || data.buyId || data.orderNo;
  log(`🎉 抢购成功(${elapsed}ms)订单号 ${orderId}`);
  let lockNote = '';
  if (CFG.autoLock && orderId) {
    const lr = await doLock(billId, orderId);
    lockNote = lr && lr.json ? `\nlock: ${lr.json.message || lr.json.status}` : '\nlock: (无响应)';
  }
  await sendMail('🎉 雷霆抢购成功',
    `${name || billId}\nbillId=${billId}\n订单号:${orderId}\n耗时:${elapsed}ms\n时间:${fmtBeijing(Date.now())}\n` +
    `请在 30 分钟内回浏览器完成支付。${lockNote}\n\nbuy 原始响应:\n${r.raw.slice(0, 800)}`);
  return { success: true, orderId, raw: r.raw };
}

// ====================== 部署调度 ======================
// task: { bill, fireAtMs, name, expectPrice, priceTolerance }
// hooks: { onComplete(success, task) }
// 返回 handle:{ cancel() }
async function deploySnipe(task, hooks = {}) {
  const handle = { timers: [], cancelled: false, bill: task.bill, status: 'deploying' };
  const cancel = () => { handle.cancelled = true; handle.timers.forEach(clearTimeout); handle.status = 'cancelled'; };
  handle.cancel = cancel;

  const clk = await syncClock(() => probeBill(task.bill));
  const lead = CFG.fireLeadMs != null ? CFG.fireLeadMs : (isFinite(clk.rttMin) ? Math.round(clk.rttMin / 2) : 20);
  const targetLocal = task.fireAtMs - clk.offset - lead;
  const remain = targetLocal - Date.now();
  log(`🎯 ${task.name || task.bill}: 目标(服务器) ${fmtBeijing(task.fireAtMs)} | 本地引爆 ${fmtBeijing(targetLocal)} | lead=${lead}ms offset=${clk.offset}ms(±${Math.round(clk.precision / 2)}ms) | 倒计时 ${(remain / 1000).toFixed(1)}s`);

  const done = (success) => { handle.status = success ? 'success' : 'failed'; if (hooks.onComplete) hooks.onComplete(success, task); };

  if (remain <= 0) { warn('已过开抢时间,立即尝试一次'); const r = await fire(task.bill, task.name); done(r.success); return handle; }

  // 解锁看守
  let nag = false;
  for (const l of [8 * 60000, 3 * 60000, 60000]) {
    const at = remain - l;
    if (at <= 0) continue;
    handle.timers.push(setTimeout(async () => {
      if (handle.cancelled) return;
      const w = await walletUnlocked();
      if (w.ok) log(`🔓 钱包已解锁(剩 ${l / 60000}min)`);
      else {
        warn(`🔒 钱包未解锁(剩 ${l / 60000}min):${w.message || ''} —— 快去浏览器解锁并重新同步!`);
        if (!nag) { nag = true; sendMail('🔒 雷霆抢号提醒:钱包未解锁', `距开抢约 ${l / 60000} 分钟,钱包还锁着,buy 会失败!\n请立刻在浏览器解锁并重新同步。${task.name || ''} billId=${task.bill}\n开抢:${fmtBeijing(task.fireAtMs)}`); }
      }
    }, at));
  }

  // 价格守门
  if (task.expectPrice != null) {
    const at = Math.max(0, remain - 8000);
    handle.timers.push(setTimeout(async () => {
      if (handle.cancelled) return;
      const info = await fetchBillInfo(task.bill);
      if (info.price != null && Math.abs(info.price - task.expectPrice) > (task.priceTolerance || 0)) {
        errlog(`价格已变 ¥${task.expectPrice} → ¥${info.price},超容差,中止!`);
        await sendMail('❌ 雷霆抢号已中止(改价)', `${task.name || task.bill}\n期望 ¥${task.expectPrice},当前 ¥${info.price}`);
        cancel(); if (hooks.onComplete) hooks.onComplete(false, task);
      } else if (info.price != null) log(`价格校验通过:¥${info.price}`);
    }, at));
  }

  // 连接预热(最后 30s 每 3s)
  const warmStart = Math.max(0, remain - 30000);
  handle.timers.push(setTimeout(function warm() {
    if (handle.cancelled) return;
    if (targetLocal - Date.now() <= 200) return;
    heartbeatProbe().catch(() => {});
    handle.timers.push(setTimeout(warm, 3000));
  }, warmStart));

  // 引爆:粗等到剩 50ms,再忙等收尾
  handle.status = 'scheduled';
  handle.timers.push(setTimeout(() => {
    if (handle.cancelled) return;
    handle.status = 'firing';
    while (Date.now() < targetLocal) { /* busy spin ≤50ms */ }
    fire(task.bill, task.name).then((r) => done(r.success));
  }, Math.max(0, targetLocal - 50 - Date.now())));

  return handle;
}

module.exports = {
  configure, getConfig, loadConfigFile,
  log, warn, errlog, ts,
  requestApi, EP,
  parseBeijing, fmtBeijing, sleep,
  pickPrice, pickPublicEnd, normalize, fetchBillInfo,
  heartbeatProbe, probeBill, walletUnlocked, syncClock,
  getTransporter, sendMail,
  parseCurl, mask, applyCreds,
  doBuy, doLock, fire, deploySnipe,
};
