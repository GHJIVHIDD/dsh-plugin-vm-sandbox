// 单元测试:S2 — network allowlist 输入校验(拒绝 shell 元字符)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { validateAllowlist, ALLOWLIST_RE } = __vmsb

const valid = ['8.8.8.8', '10.0.0.0/8', '2001:db8::1', 'evil.example.com', 'my-host.local', '1.1.1.1']
const invalid = [
  '1.1.1.1; reboot',
  'x)$(touch /pwn)',
  '%0a reboot',
  '*.example.com',
  'a b',
  'a|b',
  'a&b',
  'a"b',
  'a\'b',
  'a`b',
  'a,b',
  'a\tb',
  ';whoami',
  '1.1.1.1\nwhoami',
]

test('ALLOWLIST_RE 只允许 IP/CIDR/域名字符', () => {
  for (const v of valid) assert.equal(ALLOWLIST_RE.test(v), true, 'should accept ' + v)
  for (const v of invalid) assert.equal(ALLOWLIST_RE.test(v), false, 'should reject ' + JSON.stringify(v))
})

test('validateAllowlist: 返回清洗后的数组,非法项抛错', () => {
  assert.deepEqual(validateAllowlist([' 8.8.8.8 ', '', null]), ['8.8.8.8'])
  assert.deepEqual(validateAllowlist([]), [])
  assert.deepEqual(validateAllowlist(undefined), [])
  for (const v of invalid) {
    assert.throws(() => validateAllowlist(['8.8.8.8', v]), new RegExp('allowlist'), 'should throw for ' + JSON.stringify(v))
  }
})

test('validateAllowlist: 超长项拒绝', () => {
  assert.throws(() => validateAllowlist(['a'.repeat(300)]), /allowlist/)
})
