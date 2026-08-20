// 单元测试:cron 匹配与下次运行时间 (R5 骨架)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 HOME,避免污染真实 ~/.dsh/vm-sandbox
process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { cronPartMatch, cronMatch, nextCronRun } = __vmsb

test('cronPartMatch: 基本匹配', () => {
  assert.equal(cronPartMatch(5, '*'), true)
  assert.equal(cronPartMatch(0, '*'), true)
  assert.equal(cronPartMatch(5, '*/5'), true)
  assert.equal(cronPartMatch(7, '*/5'), false)
  assert.equal(cronPartMatch(3, '1,3,5'), true)
  assert.equal(cronPartMatch(2, '1,3,5'), false)
  assert.equal(cronPartMatch(4, '2-6'), true)
  assert.equal(cronPartMatch(7, '2-6'), false)
  assert.equal(cronPartMatch(10, '*/10'), true)
  assert.equal(cronPartMatch(25, '*/10'), false)
  assert.equal(cronPartMatch(4, '4'), true)
  assert.equal(cronPartMatch(5, '4'), false)
})

test('cronMatch: 完整 5 字段表达式', () => {
  // 每分钟
  assert.equal(cronMatch(new Date('2026-01-01T10:15:00'), '* * * * *'), true)
  // 每小时整点
  assert.equal(cronMatch(new Date('2026-01-01T10:00:00'), '0 * * * *'), true)
  assert.equal(cronMatch(new Date('2026-01-01T10:05:00'), '0 * * * *'), false)
  // 每周一 9:30
  // 2026-01-05 是周一
  assert.equal(cronMatch(new Date('2026-01-05T09:30:00'), '30 9 * * 1'), true)
  assert.equal(cronMatch(new Date('2026-01-06T09:30:00'), '30 9 * * 1'), false)
  // 非法表达式(字段数不对)
  assert.equal(cronMatch(new Date(), '* * * *'), false)
})

test('nextCronRun: 返回下一个匹配时刻', () => {
  const next = nextCronRun('*/5 * * * *', new Date('2026-01-01T10:00:03'))
  assert.ok(next !== null)
  // 应在 5 分钟内(下一分钟刻度起扫描)
  assert.equal(next.getMinutes() % 5, 0)
  assert.ok(next.getTime() > new Date('2026-01-01T10:00:03').getTime())

  const daily = nextCronRun('0 9 * * *', new Date('2026-01-01T10:00:00'))
  assert.ok(daily !== null)
  assert.equal(daily.getHours(), 9)
  assert.ok(daily.getTime() > new Date('2026-01-01T10:00:00').getTime())

  // 疯狂表达式 2/29 在 7 天窗口内可能无匹配 -> 返回 null 而非异常
  const feb29 = nextCronRun('0 0 29 2 *', new Date('2026-01-01T00:00:00'))
  assert.equal(feb29, null)
})
