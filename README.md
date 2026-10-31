# dsh-bailian-balance

阿里云百炼余额桥（DSH 插件）。用 AK/SK 签名查询阿里云 BSS OpenAPI，把结果暴露成一个本机
回环 HTTP 接口，供 **dsh-whale-widget** 的「自定义 HTTP」厂商直接读取 —— 于是在鲸鱼挂件上
就能看到百炼（= 阿里云账户）余额。

## 为什么需要中间这一层

| | 能力 | 限制 |
| --- | --- | --- |
| 百炼计费 | 消耗阿里云账户余额 / 代金券 | 查询必须走 BSS OpenAPI 的 **AK/SK 签名**（ACS3-HMAC-SHA256） |
| 鲸鱼挂件「自定义 HTTP」 | `URL + Bearer key + JSON 字段路径` | **不会签名**，只认普通 JSON |

把签名留在宿主侧、结果变成普通 JSON，是这个桥存在的全部理由。

## 数据契约

`GET http://127.0.0.1:18765/balance.json`

```json
{
  "ok": true,
  "currency": "CNY",
  "data": {
    "balance": "123.45",   // 可用额度（现金 + 信控）
    "cash": "100.00",      // 可用现金
    "credit": "23.45",     // 信控额度
    "coupon": "20.00",     // 可用代金券合计
    "total": "143.45"      // 券 + 余额
  },
  "fetchedAt": "2026-10-31T03:28:44.481Z",
  "elapsedMs": 3
}
```

失败时 `ok:false` 且 `data.*` 全为 `null`，鲸鱼会显示 `—` 而不是报错。

其它端点：

- `GET /health` —— 缓存时间、最后一次错误、上游地址
- `GET /refresh.json` —— 强制刷新（绕过 5 分钟缓存）
- `GET /` —— 等同 `/balance.json`

## 安装

```powershell
# 方式一：DSH CLI（推荐）
dsh plugin --profile desktop add link:C:\DSH\dsh-bailian-balance

# 方式二：手工（CLI 拒绝 desktop profile 时）
#   1) 把本目录复制到 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-bailian-balance
#   2) 在 profile 的 package.json 里加依赖 "dsh-bailian-balance": "file:./dsh-bailian-balance"
#   3) 在 dsh.profile.bundles 数组末尾加 "dsh-bailian-balance"
#   4) 重启 DSH
```

装完确认：`curl http://127.0.0.1:18765/health`

## 配置鲸鱼挂件

菜单 → 小鲸鱼记账 → 模型 → 新增，厂商模板选 **「自定义 HTTP」**：

| 字段 | 填什么 |
| --- | --- |
| 接口地址 | `http://127.0.0.1:18765/balance.json` |
| 密钥 | 留空（若面板强制必填，随便填一个，桥不校验） |
| 余额字段路径 | `data.balance`（想显示券+余额就用 `data.total`） |
| 币种 | CNY |
| 探活地址 | `http://127.0.0.1:18765/health` |

保存后泡泡里可用 `{balance}` / `{today}`，并自动获得「余额·<模型名>」模块。

## 排错

| 现象 | 查什么 |
| --- | --- |
| 鲸鱼显示 `—` | `curl http://127.0.0.1:18765/health` 看 `lastError` |
| `NoCredentials` | DSH 凭据里没有 `ALIYUN_BILLING_AK` / `ALIYUN_BILLING_SK`（和 dsh-aliyun-balance 共用） |
| 端口占用 | 日志里的 `server-error` / `port-busy`，改插件 `config.port` |
| 签名错误 | 不要在 `bss-client.js` 里调换 CanonicalRequest 的行序；换行多一个都会 `SignatureDoesNotMatch` |

日志：`%USERPROFILE%\.dsh\.dsh-bailian-balance.log`（200 行环形，只记事件与错误码，**不记密钥**）。

## 安全边界

- 只绑定 `127.0.0.1`，不监听外网；端口固定（默认 18765）是因为 DSH 每次启动的 Web 端口随机。
- AK/SK 只从 DSH 凭据服务读取，不落盘、不进日志、不经 HTTP 返回。
- 只读接口：只调用 `QueryAccountBalance` 与 `QueryCashCoupons`，不做任何写操作。

## 速率

默认 5 分钟缓存（`refreshMs: 300000`），懒刷新 + 单飞。DSH 启动时预热一次。

## 许可

MIT。BSS 签名实现复用自 [dsh-aliyun-balance](https://github.com/wai549077/dsh-aliyun-balance)（MIT）。
