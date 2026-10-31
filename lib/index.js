// dsh-bailian-balance —— 阿里云百炼余额桥
//
// 为什么需要它：百炼消耗的是阿里云账户余额 / 代金券，查询必须走 BSS OpenAPI 的
// AK/SK 签名；而 dsh-whale-widget 的「自定义 HTTP」厂商只支持 `URL + Bearer key +
// JSON 字段路径`，不会签名。所以这里把签名留在宿主侧，把结果暴露成一个普通的
// 本机 JSON 接口，让鲸鱼挂件当普通 HTTP 余额源来读。
//
// 设计取舍：
// - 绑定 127.0.0.1 且只监听回环，不对外网暴露；端口固定（默认 18765），因为 DSH
//   每次启动的 Web 端口是随机的，固定端口才能被鲸鱼配置一次长期复用。
// - 懒刷新 + 5 分钟缓存 + 单飞，避免每个请求都打 BSS。
// - 凭据只从 DSH 凭据服务读（与 dsh-aliyun-balance 共用 ALIYUN_BILLING_AK/SK），
//   不落盘、不出现在日志里。
// - 插件形态与 dsh-aliyun-balance 保持一致：导出 apply，内部 root.inject 等
//   credentials 就绪后再启动，并返回 cleanup（重复激活时靠它释放旧端口）。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { callBss } from './bss-client.js'

export const name = 'dsh-bailian-balance'

const DEFAULTS = {
  host: '127.0.0.1',
  port: 18765,
  refreshMs: 60_000,
  akRef: 'ALIYUN_BILLING_AK',
  skRef: 'ALIYUN_BILLING_SK',
  endpoint: 'business.aliyuncs.com',
  includeCoupons: true,
}

/** 端口被旧实例占用时的重试上限：20×1.5s + 600×3s ≈ 30 分钟。 */
const MAX_LISTEN_ATTEMPTS = 600

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function logPath() {
  return path.join(homeDir(), '.dsh-bailian-balance.log')
}

/**
 * 运行期可改的设置：`~/.dsh/.dsh-bailian-balance-settings.json`。
 *
 * 存在的意义是「改刷新频率不用重新发布插件」—— refreshMs 写在代码里的话，每次
 * 调频率都要改代码 + 重新安装一遍。优先级：环境变量 > 设置文件 > 代码默认值。
 */
function loadSettings() {
  const out = {}
  try {
    const file = path.join(homeDir(), '.dsh-bailian-balance-settings.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      const n = Number(raw.refreshMs)
      if (Number.isFinite(n) && n >= 5_000) out.refreshMs = n
      if (typeof raw.includeCoupons === 'boolean') out.includeCoupons = raw.includeCoupons
      const p = Number(raw.port)
      if (Number.isFinite(p) && p > 0 && p < 65_536) out.port = p
    }
  } catch { /* 没有设置文件就是默认值 */ }
  const fromEnv = Number(process.env.DSH_BAILIAN_REFRESH_MS)
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) out.refreshMs = fromEnv
  return out
}

// 只记事件与错误码，绝不记 AK/SK。
function logLine(obj) {
  try {
    const file = logPath()
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch { /* 首次运行 */ }
    lines.push(JSON.stringify({ ts: Date.now(), ...obj }))
    if (lines.length > 200) lines = lines.slice(-200)
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch { /* 记日志失败不影响主流程 */ }
}

const money = (v) => {
  const n = Number(v)
  return (Number.isFinite(n) ? n : 0).toFixed(2)
}
const cents = (v) => Math.round((Number.isFinite(Number(v)) ? Number(v) : 0) * 100)
const centsToMoney = (c) => `${Math.floor(c / 100)}.${String(Math.abs(c % 100)).padStart(2, '0')}`

/** 可用券余额求和：只累加 Status=Available。 */
function couponSum(res) {
  const d = (res && (res.Data || res.data)) || {}
  const candidates = [d, d.CashCoupon, res.CashCoupon, d.CashCoupon && d.CashCoupon.CashCoupon, d.CashCouponList, d.CashCoupons]
  let list = []
  for (const c of candidates) if (Array.isArray(c)) { list = c; break }
  let total = 0
  for (const it of list) {
    const status = String((it && it.Status) || '').trim().toLowerCase()
    if (status === 'available' || status === 'availabletouse') total += cents(it.Balance)
  }
  return centsToMoney(total)
}

async function resolveCreds(ctx, cfg) {
  const svc = ctx && ctx.credentials
  if (!svc || typeof svc.resolve !== 'function') return { error: { code: 'NoCredentialService', message: 'DSH 凭据服务不可用' } }
  try {
    const ak = await svc.resolve(cfg.akRef)
    const sk = await svc.resolve(cfg.skRef)
    if (!ak || !ak.value || !sk || !sk.value) {
      return { error: { code: 'NoCredentials', message: `未配置 ${cfg.akRef} / ${cfg.skRef}` } }
    }
    return { ak: String(ak.value), sk: String(sk.value) }
  } catch (err) {
    return { error: { code: 'CredentialError', message: String((err && err.message) || err).slice(0, 200) } }
  }
}

async function fetchBalance(ctx, cfg) {
  const creds = await resolveCreds(ctx, cfg)
  if (creds.error) return { ok: false, error: creds.error }

  const bal = await callBss({
    ak: creds.ak, sk: creds.sk, action: 'QueryAccountBalance',
    endpoint: cfg.endpoint, paramLocation: 'query', method: 'POST',
  })
  if (!bal.ok) return { ok: false, error: { code: bal.code, message: bal.message } }

  const d = (bal.data && (bal.data.Data || bal.data.data)) || {}
  const available = money(d.AvailableAmount)
  const cash = money(d.AvailableCashAmount)
  const credit = money(d.CreditAmount)

  let coupon = '0.00'
  if (cfg.includeCoupons) {
    const c = await callBss({
      ak: creds.ak, sk: creds.sk, action: 'QueryCashCoupons',
      // 阿里云要求 yyyy-MM-ddTHH:mm:ssZ（不带毫秒）。发 yyyy-MM-dd 会得到
      // InvalidParameter "Some parameter sare not valid."，券就永远是 0。
      params: { ExpiryTimeStart: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
      endpoint: cfg.endpoint, paramLocation: 'query', method: 'POST',
    })
    if (c.ok) coupon = couponSum(c.data)
    else logLine({ event: 'coupon-fail', code: c.code, message: String(c.message || '').slice(0, 120) })
  }

  return {
    ok: true,
    currency: d.Currency || 'CNY',
    data: { balance: available, cash, credit, coupon, total: centsToMoney(cents(available) + cents(coupon)) },
  }
}

export function apply(root, config = {}) {
  // 优先级：插件 config（cordis.patch.yml） > 运行期设置文件 > 环境变量 > 代码默认值
  const cfg = { ...DEFAULTS, ...loadSettings(), ...(config || {}) }
  let context = root
  let cache = null
  let inflight = null
  let server = null
  let started = false
  let listenAttempts = 0
  let retryTimer = null

  async function refresh(force) {
    if (!force && cache && Date.now() - cache.at < cfg.refreshMs) return cache.body
    if (inflight) return inflight
    inflight = (async () => {
      const startedAt = Date.now()
      let body
      try {
        body = await fetchBalance(context, cfg)
      } catch (err) {
        body = { ok: false, error: { code: 'InternalError', message: String((err && err.message) || err).slice(0, 200) } }
      }
      const payload = {
        ...body,
        // 鲸鱼读固定路径；失败时也给 null，让挂件显示 "—" 而不是整块报错。
        data: body.ok ? body.data : { balance: null, cash: null, credit: null, coupon: null, total: null },
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
      }
      cache = { at: Date.now(), body: payload }
      logLine({ event: body.ok ? 'refresh-ok' : 'refresh-fail', ok: body.ok, code: body.ok ? '' : body.error.code, elapsedMs: payload.elapsedMs })
      return payload
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  const send = (res, code, obj) => {
    const text = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function start(ctx) {
    if (started) return
    started = true
    context = ctx || root

    server = http.createServer(async (req, res) => {
      const url = (req.url || '/').split('?')[0]
      try {
        if (req.method === 'GET' && (url === '/balance.json' || url === '/')) {
          return send(res, 200, await refresh(false))
        }
        if (req.method === 'GET' && url === '/health') {
          const body = cache ? cache.body : null
          return send(res, 200, {
            ok: !!(body && body.ok),
            port: cfg.port,
            refreshMs: cfg.refreshMs,
            cachedAt: cache ? new Date(cache.at).toISOString() : null,
            lastError: body && !body.ok ? body.error : null,
            upstream: `${cfg.endpoint} · QueryAccountBalance`,
          })
        }
        if (req.method === 'GET' && url === '/refresh.json') {
          return send(res, 200, await refresh(true))
        }
        return send(res, 404, { ok: false, error: { code: 'NotFound', message: 'GET /balance.json | /health | /refresh.json' } })
      } catch (err) {
        return send(res, 500, { ok: false, error: { code: 'HandlerError', message: String((err && err.message) || err).slice(0, 200) } })
      }
    })

    server.on('error', (err) => {
      const code = (err && err.code) || ''
      logLine({ event: 'server-error', code, message: String((err && err.message) || err).slice(0, 160) })
      // 插件热更新时新实例会先起来、旧实例后释放，端口会被占一段时间。实测旧实例
      // 可以占上好几分钟才释放，所以这里不能只等 30 秒：退避重试到 30 分钟，
      // 期间每隔 10 次记一行日志。放弃之后钩子仍然有效 —— 下次请求会照常报错，
      // 但不会再无声无息地永久失去这个桥。
      if (code === 'EADDRINUSE') {
        listenAttempts += 1
        if (listenAttempts % 10 === 1) {
          logLine({ event: 'port-busy', port: cfg.port, attempt: listenAttempts, hint: '旧实例还没释放端口；最多重试 30 分钟' })
        }
        if (listenAttempts <= MAX_LISTEN_ATTEMPTS) {
          const delay = listenAttempts <= 20 ? 1_500 : 3_000
          retryTimer = setTimeout(() => { retryTimer = null; tryListen() }, delay)
          if (retryTimer.unref) retryTimer.unref()
          return
        }
      }
    })

    function tryListen() {
      if (!started) return
      try {
        server.listen(cfg.port, cfg.host, () => {
          listenAttempts = 0
          logLine({ event: 'listening', host: cfg.host, port: cfg.port, refreshMs: cfg.refreshMs, includeCoupons: cfg.includeCoupons })
        })
      } catch (err) {
        logLine({ event: 'listen-throw', message: String((err && err.message) || err).slice(0, 160) })
      }
    }

    tryListen()

    refresh(false).catch(() => {})
  }

  // 与 dsh-aliyun-balance 同样的注入方式：等 credentials 就绪再 start，
  // 并把 inject 返回的 fiber 一起纳入 cleanup，避免重复激活时两个 server 抢端口。
  let cancel = null
  if (typeof root.inject === 'function') {
    const fiber = root.inject(['credentials'], start)
    cancel = typeof fiber === 'function' ? fiber
      : (fiber && typeof fiber.dispose === 'function') ? () => fiber.dispose()
        : null
  } else {
    start(root)
  }

  return () => {
    if (cancel) { try { cancel() } catch { /* 已释放 */ } }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    if (server) { try { server.close() } catch { /* 已关闭 */ } }
    server = null
    started = false
    listenAttempts = 0
  }
}
