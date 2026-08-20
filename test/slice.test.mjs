// 单元测试:D3 分片导出(sliceFileByChunks)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-slice-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { sliceFileByChunks } = __vmsb

test('sliceFileByChunks: 切成 N 份且可无损拼接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsb-slice-src-'))
  const file = join(dir, 'img.raw')
  const bytes = Buffer.alloc(3 * 1024 * 1024) // 3MB
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
  writeFileSync(file, bytes)

  const outDir = join(dir, 'parts')
  const s = sliceFileByChunks(file, 1, outDir) // 1MB 每片 -> 3 片
  assert.equal(s.parts.length, 3)
  assert.equal(s.size, bytes.length)
  const names = readdirSync(outDir).filter((f) => f.endsWith('.img')).sort()
  assert.equal(names.length, 3)
  assert.deepEqual(names, ['part-0000.img', 'part-0001.img', 'part-0002.img'])

  // 拼接还原
  const merged = Buffer.concat(names.map((n) => readFileSync(join(outDir, n))))
  assert.equal(Buffer.compare(merged, bytes), 0)
  rmSync(dir, { recursive: true, force: true })
})

test('sliceFileByChunks: 小于单片则 1 片', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmsb-slice1-'))
  const file = join(dir, 'small.img')
  writeFileSync(file, 'tiny')
  const s = sliceFileByChunks(file, 8, join(dir, 'out'))
  assert.equal(s.parts.length, 1)
  assert.equal(readFileSync(s.parts[0], 'utf8'), 'tiny')
  rmSync(dir, { recursive: true, force: true })
})
