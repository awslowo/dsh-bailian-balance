// 阿里云 BSS OpenAPI 请求构造与签名
// 复用自 dsh-aliyun-balance 的已验证实现（ACS3-HMAC-SHA256），MIT。
// 该算法的 CanonicalRequest 拼接对换行极其敏感，改动前先跑 test/sign.test.mjs 的黄金用例。
import { createHash, createHmac, randomBytes } from 'node:crypto'

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const BSS_VERSION = '2017-12-14'

const enc = (s) => encodeURIComponent(String(s))
  .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/%7E/g, '~')
const sha256hex = (s) => createHash('sha256').update(s).digest('hex')
const hmac256hex = (key, s) => createHmac('sha256', key).update(s).digest('hex')
const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const formEncode = (params) => Object.keys(params).sort()
  .map((k) => `${enc(k)}=${enc(params[k])}`).join('&')

export function buildSignedRequest(o) {
  const {
    ak, sk, action, params = {}, endpoint = 'business.aliyuncs.com',
    atMs = Date.now(), nonce = randomBytes(16).toString('hex'),
    paramLocation = 'query', method = 'POST', uri = '/',
  } = o

  const queryString = paramLocation === 'query' ? formEncode(params) : ''
  const body = paramLocation === 'body' && Object.keys(params).length ? formEncode(params) : ''
  const headers = {
    host: endpoint,
    'x-acs-action': action,
    'x-acs-version': BSS_VERSION,
    'x-acs-date': isoUtc(atMs),
    'x-acs-signature-nonce': String(nonce),
    'x-acs-content-sha256': sha256hex(body || ''),
  }
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded'
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers).sort().map((n) => `${n}:${String(headers[n]).trim()}\n`).join('')
  const canonicalRequest = [method, uri, queryString, canonicalHeaders, signedHeaders, headers['x-acs-content-sha256']].join('\n')
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`
  const signature = hmac256hex(sk, stringToSign)
  return {
    method, url: `https://${endpoint}${uri}`, queryString, body,
    headers: {
      ...headers,
      authorization: `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
  }
}

export async function callBss(o, fetchImpl = fetch) {
  const r = buildSignedRequest(o)
  const headers = { ...r.headers }
  delete headers.host
  let res
  try {
    res = await fetchImpl(r.url + (r.queryString ? `?${r.queryString}` : ''), {
      method: r.method, headers, body: r.body || undefined,
    })
  } catch (e) {
    return { ok: false, code: 'NetworkError', message: String((e && e.message) || e) }
  }
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  if (!res.ok || (json && json.Success === false)) {
    return { ok: false, code: (json && json.Code) || `HTTP ${res.status}`, message: (json && json.Message) || '', status: res.status }
  }
  return { ok: true, data: json }
}
