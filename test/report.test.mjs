// 单元测试:D2 用量报表聚合(aggregateReport)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-report-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { aggregateReport, state, metricsStore } = __vmsb
const SID = 's-report'

test('aggregateReport: 空会话返回 0 台', () => {
  state.machines[SID] = []
  const r = aggregateReport(SID, null)
  assert.equal(r.ok, true)
  assert.equal(r.totals.machines, 0)
  assert.equal(r.createdTotal, 0)
  assert.equal(r.queueSize, 0)
  delete state.machines[SID]
})

test('aggregateReport: 汇总规格与平均指标', () => {
  state.machines[SID] = [
    { name: 'a', distro: 'debian', createdAt: 1, lastUsedAt: 2, spec: { cpus: '2', memory: '2G' } },
    { name: 'b', distro: 'alpine', createdAt: 3, lastUsedAt: 3, spec: { cpus: '4', memory: '4G' } },
  ]
  metricsStore.set('a', [
    { ts: 100, cpuPercent: 20, memory: { totalBytes: 1000, availableBytes: 500 } },
    { ts: 200, cpuPercent: 30, memory: { totalBytes: 1000, availableBytes: 300 } },
  ])
  const r = aggregateReport(SID, null)
  assert.equal(r.rows.length, 2)
  assert.equal(r.totals.machines, 2)
  assert.equal(r.totals.cpus, 6)
  assert.equal(r.totals.memoryMiB, 6 * 1024)
  const a = r.rows.find((x) => x.name === 'a')
  assert.equal(a.avgCpuPct, 25)
  assert.equal(a.avgMemPct, 60)
  assert.equal(a.samplePoints, 2)
  assert.equal(a.sampledSpanMs, 100)
  // 单机过滤
  const rb = aggregateReport(SID, 'b')
  assert.equal(rb.rows.length, 1)
  assert.equal(rb.rows[0].name, 'b')
  delete state.machines[SID]
  metricsStore.delete('a')
})
