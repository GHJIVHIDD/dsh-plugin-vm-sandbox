// 单元测试:R1 — 原子写入 + 备份回退
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { atomicWriteJson, readJsonRobust } = __vmsb

test('atomicWriteJson: 写入后可读,且产生 .bak 备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsb-aw-'))
  const file = join(dir, 'state.json')
  atomicWriteJson(file, { a: 1 })
  assert.equal(existsSync(file), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 })
  // 第二次写入应生成 .bak
  atomicWriteJson(file, { a: 2 })
  assert.equal(existsSync(file + '.bak'), true)
  assert.deepEqual(JSON.parse(readFileSync(file + '.bak', 'utf8')), { a: 1 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 })
  // 目录里不应残留 tmp 文件
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
  rmSync(dir, { recursive: true, force: true })
})

test('readJsonRobust: 主文件损坏时回退 .bak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsb-rr-'))
  const file = join(dir, 'state.json')
  atomicWriteJson(file, { ok: 1 })
  atomicWriteJson(file, { ok: 2 })
  // 损坏主文件
  writeFileSync(file, '{broken json!!')
  const r = readJsonRobust(file)
  assert.equal(r.recovered, true)
  assert.deepEqual(r.data, { ok: 1 })
  // 都坏 -> 回退失败
  writeFileSync(file + '.bak', 'also broken')
  const r2 = readJsonRobust(file)
  assert.equal(r2.recovered, false)
  assert.equal(r2.data, null)
  rmSync(dir, { recursive: true, force: true })
})

test('readJsonRobust: 正常文件不触发回退', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsb-ok-'))
  const file = join(dir, 'state.json')
  atomicWriteJson(file, { a: 1 })
  const r = readJsonRobust(file)
  assert.equal(r.recovered, false)
  assert.deepEqual(r.data, { a: 1 })
  rmSync(dir, { recursive: true, force: true })
})
