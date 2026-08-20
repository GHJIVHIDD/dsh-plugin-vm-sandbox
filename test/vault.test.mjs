// 单元测试:B2 密钥库(vm_secret) — 加解密/占位符注入/脱敏/持久化
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-vault-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { vaultSet, vaultGet, vaultList, vaultRemove, vaultEncrypt, vaultDecrypt, injectVaultText, redactVaultText, redactDeep, VAULT_FILE, VAULT_KEY_FILE, atomicWriteJson, readJsonRobust } = __vmsb

test('vault: set/get 往返 + 密文不落盘明文', () => {
  vaultSet('db_pass', 's3cr3t!@', 'secret')
  assert.equal(vaultGet('db_pass'), 's3cr3t!@')
  const raw = readFileSync(VAULT_FILE, 'utf8')
  assert.equal(raw.includes('s3cr3t!@'), false, 'vault 文件不得存明文')
  assert.equal(raw.includes('db_pass'), true, '不过 name 仍需可索引')
  assert.equal(existsSync(VAULT_KEY_FILE), true)
  assert.equal(readFileSync(VAULT_KEY_FILE, 'utf8').trim().length, 64)
})

test('vault: 加密是可逆且随机(两次密文不同)', () => {
  vaultSet('a', 'zzz', 'secret')
  const c1 = vaultEncrypt('unique-value')
  const c2 = vaultEncrypt('unique-value')
  assert.notEqual(c1, c2)
  assert.equal(vaultDecrypt(c1), 'unique-value')
  assert.equal(vaultDecrypt('garbage:garbage:garbage'), null)
})

test('vault: list 不含值, remove 删除', () => {
  vaultSet('tmp1', 'v1', 'env')
  vaultSet('tmp2', 'v2', 'secret')
  const list = vaultList()
  assert.ok(list.some((s) => s.name === 'tmp1' && s.kind === 'env'))
  assert.ok(list.some((s) => s.name === 'tmp2' && s.kind === 'secret'))
  assert.equal(list.some((s) => s.value !== undefined), false)
  assert.equal(vaultRemove('tmp1'), true)
  assert.equal(vaultGet('tmp1'), null)
})

test('vault: {{secret:name}}/{{env:name}} 占位符注入', () => {
  vaultSet('tok', 'ghp_TOKEN123', 'secret')
  const out = injectVaultText('curl -H "Authorization: token {{secret:tok}}" https://api.example')
  assert.equal(out, 'curl -H "Authorization: token ghp_TOKEN123" https://api.example')
  // 未知占位符原样保留
  assert.equal(injectVaultText('x={{secret:nope}}'), 'x={{secret:nope}}')
  // env 同样支持(未设置时保留)
  assert.equal(injectVaultText('a={{env:notset}}'), 'a={{env:notset}}')
})

test('vault: 审计/文本脱敏命中密文', () => {
  vaultSet('pw', 'hunter2', 'secret')
  assert.equal(redactVaultText('password is hunter2 now'), 'password is *** now')
})

test('vault: 原子写产生 .bak', () => {
  vaultSet('p1', 'one', 'secret')
  vaultSet('p2', 'two', 'secret')
  assert.equal(existsSync(VAULT_FILE + '.bak'), true)
  const r = readJsonRobust(VAULT_FILE)
  assert.equal(r.recovered, false)
  assert.ok(r.data && r.data.items && r.data.items.p2)
  const leftovers = readdirSync(join(process.env.HOME, '.dsh', 'vm-sandbox')).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('redactDeep 完整性(独立验证)', () => {
  vaultSet('deep', 'hunter2', 'secret')
  const obj = { cmd: 'echo hunter2', nested: [{ x: 'hunter2' }], keep: 'not-secret' }
  const out = redactDeep(obj, 0)
  assert.equal(out.cmd, 'echo ***')
  assert.equal(out.nested[0].x, '***')
  assert.equal(out.keep, 'not-secret')
})

// 隔离 HOME 目录清理由操作系统清理,留空即可
