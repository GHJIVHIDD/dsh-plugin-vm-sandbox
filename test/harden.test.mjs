// 单元测试:B1 安全基线(vm_harden) — 脚本内容 + 输出解析
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-harden-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { HARDEN_SCRIPT, HARDEN_CHECK, parseHardenOutput } = __vmsb

test('HARDEN_SCRIPT 包含关键加固规则', () => {
  assert.ok(HARDEN_SCRIPT.includes('PasswordAuthentication no'))
  assert.ok(HARDEN_SCRIPT.includes('PermitRootLogin prohibit-password'))
  assert.ok(HARDEN_SCRIPT.includes('/etc/dsh/hardened-on'))
  assert.ok(HARDEN_SCRIPT.includes('sshd_config'))
})

test('HARDEN_CHECK 覆盖核心检查项(含无 sshd 的 na 分支)', () => {
  for (const probe of ['sshd.password_auth', 'sshd.root_login', 'listening_nonloopback', 'baseline_marker', 'bin.sed', 'sshd.running']) {
    assert.ok(HARDEN_CHECK.includes(probe) || HARDEN_CHECK.includes(probe.split('.')[0]), 'missing probe for ' + probe)
  }
  assert.ok(HARDEN_CHECK.includes('no-sshd'))
})

test('parseHardenOutput: 解析 ok/fail/info/na 行', () => {
  const out = [
    'ok sshd.password_auth ',
    'fail sshd.root_login yes',
    'info listening_nonloopback 3',
    'na sshd.running no-sshd x',
    'ok baseline_marker ',
  ].join('\n')
  const checks = parseHardenOutput(out, '')
  assert.equal(checks.length, 5)
  const by = Object.fromEntries(checks.map((c) => [c.name, c]))
  assert.equal(by['sshd.password_auth'].status, 'ok')
  assert.equal(by['sshd.root_login'].status, 'fail')
  assert.equal(by['sshd.root_login'].detail, 'yes')
  assert.equal(by['listening_nonloopback'].status, 'info')
  assert.equal(by['sshd.running'].status, 'na')
  assert.ok(by['sshd.running'].detail.includes('no-sshd'))
})

test('parseHardenOutput: 无输出时报 guest_probe 错误', () => {
  const checks = parseHardenOutput('', 'boom')
  assert.equal(checks.length, 1)
  assert.equal(checks[0].status, 'error')
  assert.equal(checks[0].name, 'guest_probe')
  assert.ok(checks[0].detail.includes('boom') || checks[0].detail.length > 0)
})
