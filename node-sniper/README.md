# 雷霆抢号 · 服务器端 Node 版

把浏览器用户脚本(`../leiting-sniper.user.js`)的抢号逻辑搬到 ECS 上跑:keep-alive
长连接直调 `/buybill/buy`,公示期结束瞬间引爆,抢到/失败都发 Gmail 通知。

实测(北京 ECS → 上海服务器):单次请求 keep-alive 后 **~38ms**,服务器处理 **<1ms**,
瓶颈纯在网络。换上海 ECS 可压到 <5ms。

## 鉴权机制(实测结论)

- 真正的钥匙是两个 **cookie**:`SESSION` + `ltl_formal_account`
- `web-login-uid` / `web-login-token` 两个 header 也会带上
- 云 IP **没有**被风控,token **不**绑 IP

### 接口分两类(关键)

| 类型 | 例子 | 需要钱包解锁? |
|---|---|---|
| 公开数据 | `bill_detail`、`check_price` | 否,随时可调 |
| 涉财 | `get_my_money`、`buy`、`lock` | **是**,未解锁返回 `请先完成校验` |

### 钱包解锁(整个方案的核心约束)

- 抢号前必须在浏览器里**解锁钱包**(输一次支付密码)
- 解锁状态只维持 **~10 分钟**
- **不赌"解锁自动同步到服务器"**:解锁时浏览器可能种新 cookie。稳妥做法是
  **解锁后把当下完整凭据再同步一次到服务器**(用 `node sniper.js paste`)
- 校验/心跳/校时一律用 `bill_detail`(不需要解锁),只有 `buy` 那一下需要解锁

### 不要点「退出登录」

- **关浏览器**:无害,cookie 只是数据,服务器照用
- **点退出登录**:服务器主动作废 SESSION,服务器那份 cookie 立刻失效 —— 千万别点

## 部署(在 ECS 上)

```bash
git clone <repo> && cd leiting-account/node-sniper
npm install                      # 装 nodemailer
cp config.example.json config.json
vi config.json                   # 填 cookie / token / bill / fireAt / 邮箱
```

`config.json` 已被 `.gitignore` 忽略,**不会进仓库**。

### 怎么填凭据

1. 浏览器登录米源,**解锁钱包**
2. F12 → Network → 过滤 Fetch/XHR → 点任一 `fortunaapi` 请求 → 右键 **Copy as cURL (bash)**
3. 从里面抠出:
   - `-b '...'` 后整段 → `config.cookie`
   - `web-login-token:` 后的值 → `config.token`
   - `web-login-uid:` 后的值 → `config.uid`

### Gmail 应用专用密码

普通密码不行。开 Google 两步验证 → 「应用专用密码」生成 16 位 → 填 `config.email.pass`。

## 用法

```bash
node sniper.js check        # 校验凭据 + 看钱包解锁状态 + 测 RTT + 看校时偏差
node sniper.js detail       # 拉 bill_detail,尝试探测公示结束时间/价格
node sniper.js test-email   # 发测试邮件,确认通知通道
node sniper.js snipe        # 正式部署抢号(默认命令)
node sniper.js paste        # 从浏览器 Copy as cURL 更新凭据(贴完 Ctrl-D)
node sniper.js paste a.curl # 也可从文件读

# 命令行覆盖 config:
node sniper.js snipe --bill 19e1a036bb5ahzv --at "2026-06-05 20:00:00"
```

### `paste`:解锁后一键重贴凭据

`snipe` 运行时会监听 `config.json`。解锁钱包后:

1. 浏览器 F12 → Network → 任一 `fortunaapi` 请求 → **Copy as cURL (bash)**
2. 服务器上 `node sniper.js paste`,把整段粘上,Ctrl-D
3. 自动抠出 cookie/uid/token 写进 config → 正在跑的 `snipe` **1~2 秒内热加载**(不重启、不丢校时)

## 抢号流程(实操)

cookie 可**提前任意时间**搬到服务器并启动 `snipe`;**解锁 + 重贴凭据在开抢前 10 分钟内做一次**。

```
任意时刻  浏览器登录 → F12 复制 cURL → 填 ECS 上 config.json → node sniper.js snipe
         (脚本用 bill_detail 心跳/校时,挂着等;此时不需要解锁)
         浏览器可以关掉(但别点退出登录)

T-8/3/1min  脚本探测钱包是否解锁,若没解锁 → 发邮件催你
T-10min 内  ① 浏览器解锁钱包(输支付密码)
            ② 浏览器 Copy as cURL → 服务器 node sniper.js paste(重贴当下完整凭据)
            → 正在跑的 snipe 热加载,确保拿到的是解锁后的最新 cookie
         ├─ T-30s 起每 3s 预热连接 + 持续校时
         ├─ (可选)T-8s 价格守门,改价超容差则中止
         └─ T=0   忙等到点,引爆 /buybill/buy → 成功则 lock → 发邮件
抢到后    回浏览器,30 分钟内付款
```

> 若公示结束时间距现在不到 10 分钟,直接现在解锁再启动即可。

> 建议先用一个**冷门/便宜**的号实测一次,把日志贴出来,验证 `itype` / 订单号字段 /
> `lock` 行为,再上热门号。

## 桥接模式:浏览器一键下发(推荐,免手动搬数据)

`bridge.js` 是常驻 ECS 的守护进程;浏览器用户脚本(v3.2+)把凭据/任务自动推过来。
选号、登录、过验证、解锁都在浏览器(熟悉的界面),扣扳机在 ECS。

```
浏览器(用户脚本)                         ECS(bridge.js 守护)
  登录后 → 自动 POST /sync(凭据) ───────────►  存入内存
  解锁钱包 → 自动 POST /sync(凭据) ──────────►  热更新(确保拿到解锁后的 cookie)
  详情页点「🚀 下发到服务器抢号」→ POST /task ─►  部署抢号,到点引爆 → 邮件
                                            抢完无任务 → 空闲 40 分钟自动退出
```

### 服务端启动

```bash
cd node-sniper && npm install
cp config.example.json config.json     # 填 email + bridge.secret
# 生成强密钥:
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
node bridge.js                         # 前台跑;长期挂用 pm2 / systemd / nohup
```

接口(都需头 `X-Sniper-Secret: <secret>`):
`POST /sync` · `POST /task` · `GET /status` · `POST /cancel`

### 浏览器端

1. 装/更新用户脚本到 v3.2+
2. 油猴菜单「⚙️ 配置抢号服务器」→ 填 `http://你的ECS_IP:8787` + secret
3. 之后:**登录自动同步、解锁自动同步**;详情页菜单「🚀 把当前账号下发到服务器抢号」即部署
4. 开抢前 10 分钟内在浏览器解锁钱包 → 自动再同步一次(带上解锁后的最新 cookie)

### 安全(务必)

接收 cookie 的端口暴露在公网有风险。**三件事必须做**:

1. **强密钥**:`bridge.secret` 用上面生成的随机串,别用弱口令
2. **安全组锁 IP**:云控制台把该端口入方向**只放行你家宽带 IP**
   - 家宽 IP 会变,变了去改一下;**手机请连家里 WiFi**(4G/5G 是大内网,锁不住)
3. 不用时让它自动退出(`idleShutdownMin`,默认 40)

> 在线查自己当前公网 IP:浏览器搜「我的IP」。

### 更安全:SSH 隧道(可选)

不想开公网端口,就把 `bridge.host` 改成 `127.0.0.1`(只在本机监听),
然后在**你家电脑**上跑:

```bash
ssh -L 8787:localhost:8787 root@你的ECS_IP
```

它把"你电脑的 8787"经加密 SSH 接到"ECS 的 8787"。用户脚本服务器地址填
`http://localhost:8787`。ECS 端口不公开,流量加密。代价:同步时家里要挂着这条命令
(抢号本身不需要,ECS 自己会打)。

### 进程常驻

挑一个适合你的:

**(a) systemd 常驻服务(推荐,一键)**

```bash
cd node-sniper
sudo bash systemd/install.sh
```

会自动:`npm install --omit=dev` → 生成 unit 文件 → 注册 → 开机自启 → 立刻启动 → 崩了自动重启。
日志:`journalctl -u sniper-bridge -f`。修改代码后:`sudo systemctl restart sniper-bridge`。

**(b) 临时跑(关闭终端会断)**

```bash
node bridge.js
```

**(c) 后台跑(终端关了也不停,但开机不自启、崩了不重启)**

```bash
nohup node bridge.js > bridge.log 2>&1 &
```

> 推荐 (a)。bridge 闲置内存 ~60MB,2C2G 完全无感。配合 `idleShutdownMin: 0`(永不自退)
> 即可"永远有人监听"。`idleShutdownMin > 0` 仅适合手动一次性跑 (b)。

## 关键设计

- **校时**:HTTP `Date` 头只有秒精度,用「区间交集法」多采样把误差压到 ~RTT 量级
- **引爆精度**:`setTimeout` 粗等到剩 50ms,再忙等(busy-spin)收尾
- **提前量** `lead`:默认取实测 RTT 的一半,让请求**刚好在开抢瞬间到达**服务器
- **重试**:仅对网络错误/「请求过快」等瞬时错误重试;业务明确失败(已售/已购/下架)
  立即停,避免重复下单
- **价格守门**:`expectPrice` 填了就在抢号前核价,防被钓鱼改价

## 待实战验证(继承自用户脚本的 TODO)

- `itype:2` 的确切含义(支付方式?)——照搬抓包值即可
- buy 成功响应里订单号的真实字段名(现在猜 `id/orderId/buyId/orderNo`)
- `lock` 到底是不是"卡点核心接口"——首次实战抓 buy/lock 两个响应即可定论

## 安全

- `config.json` / `.env` / `*.secret` 全在 `.gitignore` 里,凭据不入库
- cookie/token 等同账号密码,贴日志求助时务必打码
