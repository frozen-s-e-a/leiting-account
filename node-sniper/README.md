# 雷霆抢号 · 服务器端 Node 版

把浏览器用户脚本(`../leiting-sniper.user.js`)的抢号逻辑搬到 ECS 上跑:keep-alive
长连接直调 `/buybill/buy`,公示期结束瞬间引爆,抢到/失败都发 Gmail 通知。

实测(北京 ECS → 上海服务器):单次请求 keep-alive 后 **~38ms**,服务器处理 **<1ms**,
瓶颈纯在网络。换上海 ECS 可压到 <5ms。

## 鉴权机制(实测结论)

- 真正的钥匙是两个 **cookie**:`SESSION` + `ltl_formal_account`
- `web-login-uid` / `web-login-token` 两个 header 也会带上
- 云 IP **没有**被风控,token **不**绑 IP
- 抢号前必须先在浏览器里**解锁钱包**(输一次支付密码),解锁状态绑在 SESSION 上

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
node sniper.js check        # 校验凭据 + 看钱包 + 测 RTT + 看校时偏差
node sniper.js detail       # 拉 bill_detail,尝试探测公示结束时间/价格
node sniper.js test-email   # 发测试邮件,确认通知通道
node sniper.js snipe        # 正式部署抢号(默认命令)

# 命令行覆盖 config:
node sniper.js snipe --bill 19e1a036bb5ahzv --at "2026-06-05 20:00:00"
```

## 抢号流程(实操)

```
T-10min  浏览器登录 → 解锁钱包(输支付密码)
T-8min   F12 复制 cURL → 更新 ECS 上 config.json 的 cookie/token
T-7min   node sniper.js check     # 确认绿:钱包能读、offset 合理
T-5min   node sniper.js snipe     # 部署,脚本自己等
         ├─ T-30s 起每 3s 预热连接 + 持续校时
         ├─ (可选)T-8s 价格守门,改价超容差则中止
         └─ T=0   忙等到点,引爆 /buybill/buy → 成功则 lock → 发邮件
抢到后    回浏览器,30 分钟内付款
```

> 建议先用一个**冷门/便宜**的号实测一次,把日志贴出来,验证 `itype` / 订单号字段 /
> `lock` 行为,再上热门号。

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
