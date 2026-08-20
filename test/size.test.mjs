// 单元测试:资源大小解析 (R5 骨架)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { sizeToBytes, sizeToMiB } = __vmsb

test('sizeToBytes: 各类单位', () => {
  assert.equal(sizeToBytes('1G'), 1024 ** 3)
  assert.equal(sizeToBytes('2GiB'), 2 * 1024 ** 3)
  assert.equal(sizeToBytes('512M'), 512 * 1024 ** 2)
  assert.equal(sizeToBytes('1.5K'), Math.round(1.5 * 1024))
  assert.equal(sizeToBytes('4096MiB'), 4096 * 1024 ** 2)
  assert.equal(sizeToBytes('100'), 100) // 无单位视为字节
  assert.equal(sizeToBytes(''), null)
  assert.equal(sizeToBytes('abc'), null)
  assert.equal(sizeToBytes(null), null)
})

test('sizeToMiB: 向上取整到 MiB', () => {
  assert.equal(sizeToMiB('1G'), 1024)
  assert.equal(sizeToMiB('2G'), 2048)
  assert.equal(sizeToMiB('1K'), 1)
})
