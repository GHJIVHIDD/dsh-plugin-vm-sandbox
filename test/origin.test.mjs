// 单元测试:S1 — 同源校验 + CSRF token 校验
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { sameOriginOk, checkCsrf, csrfTokens } = __vmsb

test('sameOriginOk: 同源请求通过', () => {
  assert.equal(sameOriginOk({
    headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    method: 'POST',
  }), true)
  assert.equal(sameOriginOk({
    headers: { 'sec-fetch-site': 'none', origin: 'http://localhost:3080', host: 'localhost:3080' },
  }), true)
  // 无 origin / 无 sec-fetch-site(curl/本地工具)-> 放行
  assert.equal(sameOriginOk({ headers: { host: '127.0.0.1:3080' } }), true)
})

test('sameOriginOk: 跨源请求拒绝', () => {
  // <img>/<script> 触发(不带 Origin 但带 sec-fetch-site: cross-site)
  assert.equal(sameOriginOk({ headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginOk({ headers: { 'sec-fetch-site': 'same-site', host: '127.0.0.1:3080' } }), false)
  // Origin 与 Host 不一致
  assert.equal(sameOriginOk({ headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginOk({ headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' } }), false)
})

test('checkCsrf: token 匹配/不匹配/过期', () => {
  const far = Date.now() + 60 * 60 * 1000
  csrfTokens.set('s1', { token: 'tok-1', exp: far })
  assert.equal(checkCsrf('s1', 'tok-1'), true)
  assert.equal(checkCsrf('s1', 'tok-2'), false)
  assert.equal(checkCsrf('s2', 'tok-1'), false)
  assert.equal(checkCsrf('s1', ''), false)
  assert.equal(checkCsrf('s1', null), false)

  // 过期 token 失效并被清理
  csrfTokens.set('expired', { token: 'x', exp: Date.now() - 1 })
  assert.equal(checkCsrf('expired', 'x'), false)
  assert.equal(csrfTokens.has('expired'), false)
  csrfTokens.clear()
})
