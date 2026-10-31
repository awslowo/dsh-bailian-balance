// 冒烟测试：用替身凭据 + 替身 fetch，验证 HTTP 层与响应契约，不触网、不碰真实 AK/SK。
// 运行：ELECTRON_RUN_AS_NODE=1 "<DSH exe>" test/smoke.mjs
import http from 'node:http'
import { apply } from '../lib/index.js'

const PORT = 18766

globalThis.fetch = async (url, opts = {}) => {
  // action 走 x-acs-action 头，不在 URL 里 —— 第一版测试就是在这里判错的。
  const action = String((opts.headers && opts.headers['x-acs-action']) || '')
  const body = action === 'QueryCashCoupons'
    ? { Success: true, Data: { CashCoupon: [{ Balance: '20.00', Status: 'Available' }, { Balance: '5.00', Status: 'Used' }] } }
    : { Success: true, Data: { AvailableAmount: '123.45', AvailableCashAmount: '100.00', CreditAmount: '23.45', Currency: 'CNY' } }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const ctx = {
  credentials: { resolve: async () => ({ value: 'dummy-credential' }) },
  on: () => {},
}

apply(ctx, { port: PORT, includeCoupons: true })

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
  }).on('error', reject)
})

await new Promise((r) => setTimeout(r, 400))

const bal = await get('/balance.json')
const health = await get('/health')
const miss = await get('/nope')

const ok = bal.status === 200
  && bal.body.ok === true
  && bal.body.data.balance === '123.45'
  && bal.body.data.coupon === '20.00'
  && bal.body.data.total === '143.45'

console.log(JSON.stringify({ balance: bal.body, health: health.body, notFound: miss.status, pass: ok }, null, 2))
process.exit(ok ? 0 : 1)
