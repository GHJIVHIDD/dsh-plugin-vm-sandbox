// 单元测试:D4 累计配额(CPU/内存)判定
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-quota-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { state, quotaState, sessionResourceUsage, sessionPolicy } = __vmsb
const SID = 's-quota'

test('默认无配额时不受限(fits)', () => {
  state.machines[SID] = []
  const q = quotaState(SID, 2, 2048)
  assert.equal(q.fits, true)
  assert.equal(q.countOk, true)
  assert.equal(q.cpuOk, true)
  assert.equal(q.memOk, true)
})

test('台数上限生效', () => {
  state.policies[SID] = { maxMachines: 2 }
  state.machines[SID] = [{ name: 'a', spec: { cpus: '2', memory: '2G' } }, { name: 'b', spec: { cpus: '2', memory: '2G' } }]
  const q = quotaState(SID, 2, 2048)
  assert.equal(q.countOk, false)
  assert.equal(q.fits, false)
})

test('累计 CPU 配额生效', () => {
  state.policies[SID] = { cpuQuota: 4 }
  state.machines[SID] = [{ name: 'a', spec: { cpus: '2', memory: '2G' } }]
  // 已有 2 核 + 再要 2 核 = 4 <= 4 -> 通过
  assert.equal(quotaState(SID, 2, 2048).fits, true)
  // 已有 2 核 + 再要 4 核 = 6 > 4 -> 拒绝
  assert.equal(quotaState(SID, 4, 2048).fits, false)
})

test('累计内存配额生效', () => {
  state.policies[SID] = { memoryQuotaMiB: 4096 }
  state.machines[SID] = [{ name: 'a', spec: { cpus: '2', memory: '2G' } }]
  // 2G 已用 + 1G 新增 = 3G <= 4G -> 通过
  assert.equal(quotaState(SID, 2, 1024).fits, true)
  // 2G 已用 + 4G 新增 = 6G > 4G -> 拒绝
  assert.equal(quotaState(SID, 2, 4096).fits, false)
})

test('sessionResourceUsage 累计正确', () => {
  state.machines[SID] = [
    { name: 'a', spec: { cpus: '2', memory: '2G' } },
    { name: 'b', spec: { cpus: '4', memory: '4G' } },
  ]
  const u = sessionResourceUsage(SID)
  assert.equal(u.machines, 2)
  assert.equal(u.cpus, 6)
  assert.equal(u.memoryMiB, 6 * 1024)
  assert.equal(sessionPolicy(SID).maxMachines, 8)
  delete state.machines[SID]
  delete state.policies[SID]
})
