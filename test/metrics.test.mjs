// 单元测试:C1 增强指标解析 + 阈值告警求值
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-metrics-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { parseProbeOutput, metricValueOf, evalAlert, PROBE_CMD } = __vmsb

test('PROBE_CMD 包含增强探针字段', () => {
  for (const probe of ['uptime', 'load', 'mem', 'disk', 'cpu=', 'net=', 'io=', 'tops=']) {
    assert.ok(PROBE_CMD.includes(probe), 'missing ' + probe)
  }
})

test('parseProbeOutput: 解析基础/增强字段', () => {
  const sample = [
    'uptime=up 3 hours, 4 minutes',
    'load=0.42 0.30 0.20',
    'mem=2097152000 1048576000 1048576000',
    'disk=17179869184 3145728000 14034141184',
    'cpu=1234 5678 6912',
    'net=1024 2048',
    'io=100 200',
    'tops=',
    ' 1.2  3.4 bash',
    ' 0.5  1.0 sshd',
  ].join('\n')
  const p = parseProbeOutput(sample)
  assert.equal(p.uptime, 'up 3 hours, 4 minutes')
  assert.equal(p.load, '0.42 0.30 0.20')
  assert.deepEqual(p.memory, { totalBytes: 2097152000, usedBytes: 1048576000, availableBytes: 1048576000 })
  assert.deepEqual(p.cpu, { busy: 1234, idle: 5678, total: 6912, cores: null })
  assert.deepEqual(p.net, { rx: 1024, tx: 2048 })
  assert.deepEqual(p.io, { r: 100, w: 200 })
  assert.deepEqual(p.tops, [{ cpu: 1.2, mem: 3.4, cmd: 'bash' }, { cpu: 0.5, mem: 1.0, cmd: 'sshd' }])
})

test('metricValueOf: 映射各度量', () => {
  const p = {
    cpuPercent: 87.5,
    load: '1.50 0.80 0.40',
    memory: { totalBytes: 1000, availableBytes: 500 },
    rootFs: { totalBytes: 1000, availableBytes: 750 },
    netRxBps: 512,
    ioOps: 42,
  }
  assert.equal(metricValueOf(p, 'cpu'), 87.5)
  assert.equal(metricValueOf(p, 'load'), 1.5)
  assert.equal(metricValueOf(p, 'mem'), 50)
  assert.equal(metricValueOf(p, 'disk'), 25)
  assert.equal(metricValueOf(p, 'netRx'), 512)
  assert.equal(metricValueOf(p, 'io'), 42)
  assert.equal(metricValueOf(p, 'netTx'), null)
  assert.equal(metricValueOf(null, 'cpu'), null)
})

test('evalAlert: 各比较操作与缺值', () => {
  const p = { cpuPercent: 90.1 }
  assert.equal(evalAlert({ metric: 'cpu', op: 'gt', value: 90 }, p), true)
  assert.equal(evalAlert({ metric: 'cpu', op: 'gte', value: 90.1 }, p), true)
  assert.equal(evalAlert({ metric: 'cpu', op: 'lt', value: 90 }, p), false)
  assert.equal(evalAlert({ metric: 'cpu', op: 'eq', value: 90.1 }, p), true)
  assert.equal(evalAlert({ metric: 'cpu', op: 'gt', value: 95 }, p), false)
  // 缺度量 -> false(不误报)
  assert.equal(evalAlert({ metric: 'netTx', op: 'gt', value: 1 }, p), false)
})
