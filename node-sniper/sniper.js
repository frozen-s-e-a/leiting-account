#!/usr/bin/env node
'use strict';

/*
 * 雷霆抢号 CLI（命令行单机版）。重逻辑都在 core.js。
 *
 * 抢号前置:先在浏览器登录并「解锁钱包」(输支付密码),解锁状态绑在 SESSION 上、
 * 只活 ~10 分钟。把 cookie/token 填进 config.json(或用 paste 命令),趁解锁有效启动。
 *
 *   node sniper.js check        校验凭据 / 看钱包解锁状态 / 测 RTT / 看校时偏差
 *   node sniper.js detail       拉 bill_detail,尝试探测公示结束时间/价格
 *   node sniper.js snipe        部署抢号(默认)
 *   node sniper.js paste [文件]  从浏览器 Copy as cURL 更新凭据(无文件则读 stdin)
 *   node sniper.js test-email   发测试邮件
 */

const fs = require('fs');
const path = require('path');
const core = require('./core');
const { log, warn, errlog, fmtBeijing, parseBeijing, mask } = core;

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  let cfg;
  try { cfg = core.loadConfigFile(CONFIG_PATH); }
  catch (e) { console.error(e.message); process.exit(1); }
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bill') cfg.bill = args[++i];
    else if (args[i] === '--at') cfg.fireAt = args[++i];
    else if (args[i] === '--lead') cfg.fireLeadMs = Number(args[++i]);
  }
  return cfg;
}

let CFG;

// 运行中热加载凭据(配合 paste / 手改 config.json)
function reloadCreds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const creds = {};
    for (const k of ['cookie', 'token', 'uid', 'userAgent']) if (cfg[k]) creds[k] = cfg[k];
    if (core.applyCreds(creds)) log(`🔄 凭据已热更新(cookie=${mask(CFG.cookie)})`);
  } catch (e) { /* 文件可能正写一半 */ }
}

function saveCredsToConfig(creds) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  Object.assign(cfg, creds);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ====================== 命令 ======================
async function cmdCheck() {
  log('校验凭据 + 测速 + 校时…');
  if (!CFG.bill) warn('config 里没有 bill,校验退化用 get_my_money(需钱包已解锁)');
  const r = await core.heartbeatProbe();
  if (!r.json) { errlog('响应非 JSON:', r.raw.slice(0, 200)); return; }
  if (r.json.status !== 0) {
    errlog(`凭据无效:status=${r.json.status} message=${r.json.message}`);
    errlog('→ 多半是 cookie/token 过期或被登出,回浏览器重新复制 cookie。');
    return;
  }
  log('✅ 凭据有效(cookie 没过期、没登出)');
  const w = await core.walletUnlocked();
  if (w.ok) log('🔓 钱包当前已解锁,可立即抢号');
  else log(`🔒 钱包当前未解锁(${w.message || ''})—— 正常,开抢前 10 分钟内去浏览器解锁即可`);
  const clk = await core.syncClock(() => (CFG.bill ? core.probeBill(CFG.bill) : core.heartbeatProbe()));
  log(`⏱ 校时 offset=${clk.offset}ms(精度±${Math.round(clk.precision / 2)}ms),最快 RTT=${clk.rttMin}ms`);
  log(`服务器当前时间约:${fmtBeijing(Date.now() + clk.offset)}`);
}

async function cmdDetail() {
  if (!CFG.bill) { errlog('config 里没有 bill'); return; }
  const info = await core.fetchBillInfo(CFG.bill);
  log('探测结果:', info);
  if (info.publicEnd) log(`公示结束时间 → ${info.publicEnd}(可填进 config.fireAt)`);
  else warn('未能自动探测公示结束时间,请手动在 config.fireAt 填写。');
}

async function cmdTestEmail() {
  await core.sendMail('✅ 雷霆抢号机测试邮件', `这是一封测试邮件。\n时间:${fmtBeijing(Date.now())}`);
}

async function cmdPaste() {
  const fileArg = process.argv[3];
  let text;
  if (fileArg && fs.existsSync(fileArg)) text = fs.readFileSync(fileArg, 'utf8');
  else {
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) console.log('粘贴浏览器 Copy as cURL 的整段,然后回车按 Ctrl-D 结束:');
    text = await new Promise((resolve) => { let buf = ''; process.stdin.on('data', (d) => (buf += d)); process.stdin.on('end', () => resolve(buf)); });
  }
  const creds = core.parseCurl(text);
  if (!creds.cookie && !creds.token) { errlog('没解析到 cookie/token。请确认贴的是「Copy as cURL (bash)」完整内容。'); process.exit(1); }
  saveCredsToConfig(creds);
  log('✅ 已更新凭据 → config.json');
  log(`   cookie=${mask(creds.cookie)}  uid=${creds.uid || '(未变)'}  token=${mask(creds.token)}`);
  log('   若 snipe 正在运行,它会在 1~2 秒内自动热加载。');
}

async function cmdSnipe() {
  if (!CFG.bill) { errlog('config 里没有 bill'); process.exit(1); }
  const chk = await core.heartbeatProbe();
  if (!chk.json || chk.json.status !== 0) {
    errlog(`凭据无效:${chk.json ? chk.json.message : chk.raw.slice(0, 120)}。请回浏览器重新复制 cookie(别点退出登录)。`);
    process.exit(1);
  }
  log('✅ 凭据有效(cookie 没过期)');

  fs.watchFile(CONFIG_PATH, { interval: 1000 }, reloadCreds);
  log('👀 已监听 config.json,解锁后 `node sniper.js paste` 重贴凭据会自动热加载');

  let fireAt = parseBeijing(CFG.fireAt);
  if (isNaN(fireAt)) {
    log('config.fireAt 为空,尝试自动探测…');
    const info = await core.fetchBillInfo(CFG.bill);
    if (info.publicEnd) { fireAt = parseBeijing(info.publicEnd); log(`探测到公示结束:${info.publicEnd}`); }
  }
  if (isNaN(fireAt)) { errlog('无法确定开抢时间。请在 config.fireAt 填北京时间,如 "2026-06-05 20:00:00"。'); process.exit(1); }

  await core.deploySnipe(
    { bill: CFG.bill, fireAtMs: fireAt, name: CFG.bill, expectPrice: CFG.expectPrice, priceTolerance: CFG.priceTolerance },
    { onComplete: (_result) => { fs.unwatchFile(CONFIG_PATH); setTimeout(() => process.exit(0), 500); } }
  );
  log('部署完成,等待引爆…(Ctrl-C 取消)');
}

// ====================== 入口 ======================
(async function main() {
  CFG = loadConfig();
  core.configure(CFG);
  const cmd = process.argv[2] || 'snipe';
  try {
    if (cmd === 'check') await cmdCheck();
    else if (cmd === 'detail') await cmdDetail();
    else if (cmd === 'test-email') await cmdTestEmail();
    else if (cmd === 'paste') await cmdPaste();
    else if (cmd === 'snipe') await cmdSnipe();
    else { console.error(`未知命令:${cmd}(可用:check | detail | snipe | paste | test-email)`); process.exit(1); }
  } catch (e) { errlog('致命错误:', e && e.stack ? e.stack : e); process.exit(1); }
})();
