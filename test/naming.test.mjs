// 单元测试:机器/标识命名 (R5 骨架)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { sanitizeName, abbreviate, codepointLetter } = __vmsb

test('sanitizeName: 只保留小写字母数字,截断到 8 位', () => {
  assert.equal(sanitizeName('MyVM-01'), 'myvm01')
  assert.equal(sanitizeName('a b.c!d'), 'abcd')
  assert.equal(sanitizeName('ABCDEFGHIJKLMN'), 'abcdefgh')
  assert.equal(sanitizeName(''), '')
  assert.equal(sanitizeName(null), '')
  assert.equal(sanitizeName('中文名称'), '')
})

test('abbreviate: 生成 3-8 位可读前缀', () => {
  const a = abbreviate('Python Backend Agent', 's-abc')
  assert.ok(a.length >= 3 && a.length <= 8)
  assert.equal(a, 'pythonba')

  const b = abbreviate('数据流水线', 's-xyz')
  assert.ok(b.length >= 3 && b.length <= 8)
  assert.ok(/^[a-z0-9]+$/.test(b))

  const c = abbreviate('', 's-abc')
  assert.ok(c.length >= 3)
})

test('codepointLetter: 确定性映射到 a-z', () => {
  const L = () => { let s = ''; for (let i = 0; i < 64; i++) s += codepointLetter(String.fromCharCode(i * 37 + 30)); return s }
  assert.equal(L(), L()) // 确定性
  assert.equal(/^[a-z]+$/.test(L()), true) // 全部落在 a-z
  assert.equal(codepointLetter('中'), codepointLetter('中'))
})
