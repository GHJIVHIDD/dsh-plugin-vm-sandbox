/**
 * Host loader entry for the deployment-level VM sandbox plugin.
 *
 * v0.3.0 upgrade — panel API hardening (same-origin + POST-only mutations + per-session CSRF token), allowlist shell-injection guard, atomic state writes with .bak fallback, workspace-restricted template reads, debounced + partitioned persistence (audit.json / metrics.json), and a node:test unit-test seam (__vmsb):
 *  Also retains all v0.2.1 capability:
 *   1. 快照与回滚 vm_snapshot / vm_restore / vm_snapshot_delete / vm_snapshot_list
 *   2. 文件传输 vm_upload / vm_download (OrbStack official orb push/pull)
 *   3. 生命周期管理 vm_start / vm_stop / vm_restart / vm_status
 *   4. 端口转发 vm_port_forward / vm_port_forward_list / vm_port_forward_stop
 *   5. 后台任务管理 vm_job_submit / vm_job_list / vm_job_status / vm_job_stop / vm_job_output
 *   6. 操作日志与审计 vm_audit
 *   7. 共享协作 vm_share / vm_unshare / vm_policy (归属、权限、配额、回收)
 *   8. 网络策略 vm_network
 *   9. 自定义资源规格 vm_create(cpus, memory, disk)
 *  10. 模板/初始化脚本 vm_create(init_script, cloud_init)
 *  11. 多机并行执行 vm_exec(machines)
 *  12. 状态查询增强 vm_status(IP/uptime/CPU/内存/磁盘/最近记录)
 *
 * Underlying operations use OrbStack's official CLI commands:
 *   orb list / info / create / start / stop / restart / delete
 *   orb run / push / pull / clone / config set
 *   ssh MACHINE@orb for port forwarding
 */

import { execFile, spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const ORB = '/usr/local/bin/orb'
const HOME = process.env.HOME || ''
const STATE_DIR = join(HOME, '.dsh', 'vm-sandbox')
const STATE_FILE = join(STATE_DIR, 'state.json')
const AUDIT_FILE = join(STATE_DIR, 'audit.json')
const METRICS_FILE = join(STATE_DIR, 'metrics.json')
const VAULT_FILE = join(STATE_DIR, 'secrets.vault.json')
const VAULT_KEY_FILE = join(STATE_DIR, 'vault.key')
const PY_TABLE_FILE = join(STATE_DIR, 'pinyin-initials.json')
const SAVE_DEBOUNCE_MS = 300
const CSRF_TTL_MS = 30 * 60 * 1000

const MAX_RUNNING = 25
const MAX_PER_SESSION = 8
const MAX_SNAPSHOTS = 32
const MAX_SNAPSHOTS_PER_SESSION = 8
const MAX_JOBS_PER_SESSION = 32
const MAX_TUNNELS = 32
const MAX_AUDIT = 2000
const IDLE_SLEEP_MS = 30 * 60 * 1000
const ACTIVE_WINDOW_MS = 15 * 60 * 1000
const IDLE_SWEEP_MS = 5 * 60 * 1000
const CREATE_ARGS = ['--cpus', '2', '--memory', '2G', '--disk', '16G']
const VM_JOBS_DIR = '/root/.dsh/jobs'
const SHELL_LOG_LIMIT = 200
const CRON_INTERVAL_MS = 30 * 1000
const METRICS_INTERVAL_MS = 30 * 1000
const MAX_METRICS_POINTS = 1440
const TEMPLATE_FILE = join(STATE_DIR, 'templates.json')
// ---------- 状态持久化 ----------
// machines[sessionId] = [{name,distro,createdAt,lastUsedAt,spec,createdWith}]
// snapshots[name] = {name,source,distro,sessionId,createdAt,note}
// shares[name] = [{sessionId,mode,sharedAt}]
// policies[sessionId] = {maxMachines,idleSleepMinutes,idleDeleteDays}
// network[name] = {publicAccess,internalAccess,isolated,isolateNetwork,updatedAt,appliedAt}
// jobs[] = [{id,machine,sessionId,command,pid,dir,startTime,endTime,status,exitCode,error}]
// tunnels[] = [{id,machine,vmPort,hostPort,bindHost,pid,sessionId,createdAt}]
// audit[] = [{id,ts,sessionId,machine,operation,params,ok,error,durationMs}]
function normalizeMachines(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const sid of Object.keys(raw)) {
    const val = raw[sid]
    if (Array.isArray(val)) {
      const list = val.filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name)
      if (list.length > 0) out[sid] = list
    } else if (val && typeof val === 'object' && typeof val.name === 'string' && val.name) {
      out[sid] = [{ ...val }]
    }
  }
  return out
}
function loadStateFile() {
  let parsed = null
  let recovered = false
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch (e) {
    // 主文件缺失或损坏:尝试从 .bak 回退
    try {
      parsed = JSON.parse(readFileSync(STATE_FILE + '.bak', 'utf8'))
      recovered = true
    } catch (e2) { parsed = null }
  }
  const empty = { version: 4, machines: {}, snapshots: {}, shares: {}, policies: {}, network: {}, jobs: [], tunnels: [], cron: [], templates: {}, services: {}, alerts: [] }
  if (!parsed || typeof parsed !== 'object' || !parsed.machines || typeof parsed.machines !== 'object') {
    return { core: empty, legacy: { audit: [], metrics: {} } }
  }
  if (recovered) {
    try { console.error('[vmsb] state.json 损坏,已从 state.json.bak 回退') } catch (e) { /* ignore */ }
  }
  return {
    core: {
      version: 4,
      machines: normalizeMachines(parsed.machines),
      snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
      shares: parsed.shares && typeof parsed.shares === 'object' ? parsed.shares : {},
      policies: parsed.policies && typeof parsed.policies === 'object' ? parsed.policies : {},
      network: parsed.network && typeof parsed.network === 'object' ? parsed.network : {},
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      tunnels: Array.isArray(parsed.tunnels) ? parsed.tunnels : [],
      cron: Array.isArray(parsed.cron) ? parsed.cron : [],
      templates: parsed.templates && typeof parsed.templates === 'object' ? parsed.templates : {},
      services: parsed.services && typeof parsed.services === 'object' ? parsed.services : {},
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    },
    legacy: {
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      metrics: parsed.metrics && typeof parsed.metrics === 'object' ? parsed.metrics : {},
    },
  }
}

// ---- 原子写入 + 备份回退 ----
function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const text = JSON.stringify(obj)
  writeFileSync(tmp, text, 'utf8')
  try {
    if (existsSync(file)) copyFileSync(file, file + '.bak')
  } catch (e) { /* 备份失败不影响主写 */ }
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch (e2) { /* ignore */ }
    throw e
  }
}
function readJsonRobust(file) {
  for (const f of [file, file + '.bak']) {
    try {
      return { data: JSON.parse(readFileSync(f, 'utf8')), recovered: f !== file }
    } catch (e) { /* 尝试下一个候选 */ }
  }
  return { data: null, recovered: false }
}

const loadedState = loadStateFile()
let state = loadedState.core

// ---- 独立存储:审计 / 指标(从主 state.json 拆出,避免文件无限膨胀与频繁整写) ----
let auditStore = []
let metricsStore = new Map()
function loadAuditStore() {
  const { data } = readJsonRobust(AUDIT_FILE)
  return Array.isArray(data) ? data : []
}
function loadMetricsStore() {
  const { data } = readJsonRobust(METRICS_FILE)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}
function migrateLegacySplits(legacyAudit, legacyMetrics) {
  try {
    if (Array.isArray(legacyAudit) && legacyAudit.length > 0 && !existsSync(AUDIT_FILE)) atomicWriteJson(AUDIT_FILE, legacyAudit)
  } catch (e) { /* ignore */ }
  try {
    if (legacyMetrics && typeof legacyMetrics === 'object' && Object.keys(legacyMetrics).length > 0 && !existsSync(METRICS_FILE)) atomicWriteJson(METRICS_FILE, legacyMetrics)
  } catch (e) { /* ignore */ }
}
migrateLegacySplits(loadedState.legacy.audit, loadedState.legacy.metrics)
auditStore = loadAuditStore()
metricsStore = new Map(Object.entries(loadMetricsStore()))

let knownArchived = new Set()
const inFlight = new Map()
const shellLogs = new Map()
const csrfTokens = new Map()
let sweeping = false

// ---- 保存:去抖 + 汇聚,单点控制原子性 ----
let dirty = false
let saveTimer = null
function saveState() { scheduleSave() }
function scheduleSave() {
  dirty = true
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushStateNow()
  }, SAVE_DEBOUNCE_MS)
  if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
}
function flushStateNow() {
  if (!dirty) return
  dirty = false
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    atomicWriteJson(STATE_FILE, state)
    atomicWriteJson(AUDIT_FILE, auditStore)
    atomicWriteJson(METRICS_FILE, Object.fromEntries(metricsStore))
  } catch (e) {
    try { console.error('[vmsb] state save failed:', e && e.message || e) } catch (e2) { /* ignore */ }
  }
}

// ---------- 拼音首字母表 ----------
let pyTable = undefined
function loadPyTable() {
  if (pyTable !== undefined) return pyTable
  pyTable = null
  try {
    const parsed = JSON.parse(readFileSync(PY_TABLE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') pyTable = parsed
  } catch (e) { /* 缺失时降级 */ }
  return pyTable
}

function codepointLetter(ch) {
  return String.fromCharCode(97 + ((ch.codePointAt(0) || 0) % 26))
}

// ---------- orb 命令执行 ----------
async function orb(args, opts) {
  opts = opts || {}
  const timeout = opts.timeoutMs || 120000
  try {
    const { stdout, stderr } = await execFileP(ORB, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      ...(opts.signal != null ? { signal: opts.signal } : {}),
    })
    return { exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (err) {
    return {
      exitCode: typeof err.code === 'number' ? err.code : -1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || (err && err.message) || ''),
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()
const nowMs = () => Date.now()
const genId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
// ---------- Shell 执行记录 ----------
function pushShellLog(name, entry) {
  if (!shellLogs.has(name)) shellLogs.set(name, [])
  const list = shellLogs.get(name)
  list.push(entry)
  if (list.length > SHELL_LOG_LIMIT) list.splice(0, list.length - SHELL_LOG_LIMIT)
}

function shellLogView(name) {
  return { ok: true, name, entries: shellLogs.get(name) || [] }
}

// ---------- 会话信息 ----------
async function sessionTitleOf(ctx, sessionId) {
  if (!sessionId) return null
  const sessionsSvc = ctx.get('sessions')
  const st = ctx.get('sessionTitle')
  if (sessionsSvc && st) {
    const session = sessionsSvc.get(sessionId)
    if (session) {
      const snap = st.get(session)
      if (snap && snap.title) return snap.title
    }
  }
  const sq = ctx.get('sessionQuery')
  if (sq && typeof sq.readTitle === 'function') {
    try {
      const snap = await sq.readTitle(sessionId)
      if (snap && snap.title) return snap.title
    } catch (err) { /* 忽略 */ }
  }
  return null
}

// ---------- 命名 ----------
function abbreviate(title, sessionId) {
  const text = String(title || '').trim()
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (ascii.length >= 3) return ascii.slice(0, 8)
  const table = loadPyTable()
  let initials = ''
  for (const ch of text) {
    if (initials.length >= 8) break
    if (/[a-z0-9]/i.test(ch)) {
      initials += ch.toLowerCase()
    } else {
      const code = ch.codePointAt(0)
      if (code && code >= 0x4E00 && code <= 0x9FFF) {
        initials += (table && table[ch]) || codepointLetter(ch)
      } else if (code) {
        initials += codepointLetter(ch)
      }
    }
  }
  const padSrc = text || String(sessionId || 'vm')
  let i = 0
  while (initials.length < 3) {
    const ch = padSrc[i % padSrc.length] || 'v'
    initials += codepointLetter(ch)
    i++
  }
  return initials.slice(0, 8)
}

function sanitizeName(hint) {
  const clean = String(hint || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  return clean.slice(0, 8)
}

async function uniqueMachineName(title, sessionId, hint) {
  let existing = new Set()
  try {
    existing = new Set((await listMachines()).map((m) => m.name))
  } catch (err) { /* 忽略 */ }
  const hintClean = sanitizeName(hint)
  const stem = hintClean || abbreviate(title, sessionId)
  if (stem && !existing.has(stem)) return stem
  for (let n = 1; n < 1000; n++) {
    const digits = String(n)
    const base = stem.slice(0, Math.max(3, 8 - digits.length))
    const cand = base + digits
    if (!existing.has(cand)) return cand
  }
  return (stem.slice(0, 5) + String(Date.now()).slice(-3)).slice(0, 8)
}

async function uniqueSnapshotName() {
  let existing = new Set()
  try {
    existing = new Set((await listMachines()).map((m) => m.name))
  } catch (err) { /* 忽略 */ }
  for (let i = 0; i < 100; i++) {
    const cand = 's' + Math.random().toString(36).slice(2, 9).replace(/[^a-z0-9]/g, '').slice(0, 7).padEnd(7, '0')
    if (!existing.has(cand)) return cand
  }
  return 's' + String(Date.now()).slice(-7)
}
// ---------- 会话 / 机器记录 ----------
function sessionMachines(sessionId) {
  const list = state.machines[sessionId]
  return Array.isArray(list) ? list : []
}

function byRecent(a, b) {
  return (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)
}

function defaultSessionMachine(sessionId) {
  const list = sessionMachines(sessionId)
  if (list.length === 0) return null
  return list.slice().sort(byRecent)[0]
}

function recordOfMachine(name) {
  for (const sid of Object.keys(state.machines)) {
    const list = state.machines[sid]
    if (!Array.isArray(list)) continue
    const found = list.find((r) => r.name === name)
    if (found) return { sessionId: sid, record: found, type: 'machine' }
  }
  const snap = state.snapshots[name]
  if (snap && typeof snap === 'object') return { sessionId: snap.sessionId, record: snap, type: 'snapshot' }
  return null
}

function ownerOfMachine(name) {
  const found = recordOfMachine(name)
  return found ? found.sessionId : null
}

function touchMachine(sessionId, name) {
  const list = state.machines[sessionId]
  if (!Array.isArray(list) || list.length === 0) return
  let rec = name ? list.find((r) => r.name === name) : null
  if (!rec) rec = list.slice().sort(byRecent)[0]
  if (!rec) return
  rec.lastUsedAt = Date.now()
  saveState()
}

// ---------- 权限模型 ----------
function sessionPolicy(sessionId) {
  return Object.assign(
    { maxMachines: MAX_PER_SESSION, idleSleepMinutes: 30, idleDeleteDays: 0, snapshotIntervalHours: 0, snapshotRetention: 0, cpuQuota: 0, memoryQuotaMiB: 0 },
    (state.policies && state.policies[sessionId]) || {},
  )
}

// D4: 每会话累计资源用量与配额
function sessionResourceUsage(sessionId) {
  let cpus = 0
  let memoryMiB = 0
  for (const rec of sessionMachines(sessionId)) {
    const c = Number(rec.spec && rec.spec.cpus) || 0
    if (c > 0) cpus += c
    const m = sizeToMiB(rec.spec && rec.spec.memory) || 0
    if (m > 0) memoryMiB += m
  }
  return { cpus, memoryMiB, machines: sessionMachines(sessionId).length }
}
function quotaState(sessionId, reqCpus, reqMemMiB) {
  const policy = sessionPolicy(sessionId)
  const usage = sessionResourceUsage(sessionId)
  const req = { cpus: Number(reqCpus) || 0, memoryMiB: Number(reqMemMiB) || 0 }
  const countOk = usage.machines + 1 <= policy.maxMachines
  const cpuOk = policy.cpuQuota > 0 ? usage.cpus + req.cpus <= policy.cpuQuota : true
  const memOk = policy.memoryQuotaMiB > 0 ? usage.memoryMiB + req.memoryMiB <= policy.memoryQuotaMiB : true
  const fits = countOk && cpuOk && memOk
  return { fits, countOk, cpuOk, memOk, usage, policy, req }
}
// D4: 处理排队中的创建请求(FIFO;每当有释放空间时推进)
async function processQueuedCreations(ctx) {
  for (const sid of Object.keys(state.queue || {})) {
    const q = state.queue[sid]
    if (!Array.isArray(q) || q.length === 0) { delete state.queue[sid]; continue }
    while (q.length) {
      const item = q[0]
      if (!item || item.status === 'processing') break
      const req = item.req || {}
      const reqCpus = Number(req.cpus) || 2
      const reqMemMiB = sizeToMiB(req.memory) || 2048
      const qs = quotaState(sid, reqCpus, reqMemMiB)
      if (!qs.fits) break
      item.status = 'processing'
      saveState()
      try {
        const rec = await createMachineForSession(ctx, sid, req.distro || 'debian', null, req.hint || null, { ...req })
        item.status = 'done'; item.machine = rec.name; item.doneAt = Date.now()
        saveState()
        pushAudit(sid, rec.name, 'vm_create_queued_done', { id: item.id }, true, null)
      } catch (e) {
        item.status = 'error'; item.error = String((e && e.message) || e); item.doneAt = Date.now()
        saveState()
        pushAudit(sid, null, 'vm_create_queued_fail', { id: item.id }, false, String((e && e.message) || e))
        break
      }
    }
    const remaining = q.filter((i) => i.status !== 'done' && i.status !== 'error')
    if (remaining.length === 0) delete state.queue[sid]
    else state.queue[sid] = remaining
  }
}

function sharesOf(name) {
  return (state.shares && state.shares[name]) || []
}

function shareMode(name, sessionId) {
  if (!sessionId) return null
  const found = sharesOf(name).find((s) => s.sessionId === sessionId)
  return found ? found.mode : null
}

function canExec(sessionId, name) {
  const found = recordOfMachine(name)
  if (!found) return false
  if (found.sessionId === sessionId) return true
  const mode = shareMode(name, sessionId)
  return mode === 'exec' || mode === 'manage'
}

function canManage(sessionId, name) {
  const found = recordOfMachine(name)
  if (!found) return false
  if (found.sessionId === sessionId) return true
  return shareMode(name, sessionId) === 'manage'
}

function canOwner(sessionId, name) {
  const found = recordOfMachine(name)
  return !!found && found.sessionId === sessionId
}

// ---------- 审计 ----------
function pushAudit(sessionId, machine, operation, params, ok, error, durationMs) {
  try {
    const entry = {
      id: genId('audit'),
      ts: nowMs(),
      iso: nowIso(),
      sessionId: sessionId || null,
      machine: machine || null,
      operation,
      params: redactDeep(params || {}, 0),
      ok: !!ok,
      error: error ? redactVaultText(String(error).slice(0, 1000)) : null,
      durationMs: typeof durationMs === 'number' ? durationMs : null,
    }
    auditStore.push(entry)
    if (auditStore.length > MAX_AUDIT) auditStore.splice(0, auditStore.length - MAX_AUDIT)
    saveState()
    return entry
  } catch (e) {
    return null
  }
}

function auditView(ctx, filter, limit) {
  const rows = auditStore.slice().reverse().filter((a) => {
    if (filter && filter.sessionId && a.sessionId !== filter.sessionId) return false
    if (filter && filter.machine && a.machine !== filter.machine) return false
    if (filter && filter.operation && a.operation !== filter.operation) return false
    return true
  })
  const out = rows.slice(0, Math.max(1, Number(limit) || 100)).map((a) => ({ ...a }))
  return Promise.all(out.map(async (a) => {
    if (a.sessionId && !a.title) a.title = await sessionTitleOf(ctx, a.sessionId)
    return a
  }))
}
// ---------- OrbStack 机器清单/状态 ----------
async function listMachines() {
  const res = await orb(['list', '-f', 'json'], { timeoutMs: 60000 })
  if (res.exitCode !== 0) {
    throw new Error('orb list 失败: ' + String(res.stderr || res.stdout || res.exitCode).slice(0, 300))
  }
  const text = res.stdout.trim()
  if (!text) return []
  let arr
  try {
    arr = JSON.parse(text)
  } catch (err) {
    throw new Error('orb list 输出解析失败: ' + text.slice(0, 200))
  }
  if (!Array.isArray(arr)) return []
  return arr.map((m) => ({
    id: String((m && m.id) || ''),
    name: String((m && m.name) || ''),
    distro: String(((m && m.image) || {}).distro || ''),
    version: String(((m && m.image) || {}).version || ''),
    arch: String(((m && m.image) || {}).arch || ''),
    state: String((m && m.state) || ''),
  }))
}

async function machineStateOf(name) {
  try {
    const machines = await listMachines()
    return machines.find((x) => x.name === name) || null
  } catch (err) {
    return null
  }
}

async function ensureRunning(name) {
  const m = await machineStateOf(name)
  if (m && m.state === 'running') {
    await ensureNetworkApplied(name)
    return
  }
  const res = await orb(['start', name], { timeoutMs: 300000 })
  if (res.exitCode !== 0) {
    throw new Error('orb start 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
  await ensureNetworkApplied(name)
}

async function waitRunning(name) {
  let machines = []
  for (let i = 0; i < 15; i++) {
    try {
      machines = await listMachines()
      if (machines.some((m) => m.name === name && m.state === 'running')) break
    } catch (err) { /* 重试 */ }
    await sleep(2000)
  }
  return machines.find((m) => m.name === name) || null
}

async function createMachineWithName(ctx, sessionId, name, distro, signal, opts) {
  opts = opts || {}
  const policy = sessionPolicy(sessionId)
  if (sessionMachines(sessionId).length >= policy.maxMachines) {
    throw new Error('本会话虚拟机已达上限(' + policy.maxMachines + ' 台),请先删除不再使用的机器或调整 vm_policy')
  }
  const key = 'create:' + name
  if (inFlight.has(key)) return inFlight.get(key)
  const task = (async () => {
    const args = ['create']
    if (opts.cpus != null && String(opts.cpus).trim() !== '') args.push('--cpus', String(opts.cpus))
    else args.push('--cpus', '2')
    if (opts.memory != null && String(opts.memory).trim() !== '') args.push('--memory', String(opts.memory))
    else args.push('--memory', '2G')
    if (opts.disk != null && String(opts.disk).trim() !== '') args.push('--disk', String(opts.disk))
    else args.push('--disk', '16G')
    if (opts.arch != null && String(opts.arch).trim() !== '') args.push('--arch', String(opts.arch))
    const isolated = !!opts.isolated || !!opts.isolateNetwork
    if (isolated) args.push('--isolated')
    if (opts.isolateNetwork) args.push('--isolate-network')
    let userDataPath = null
    const init = injectVaultText(String(opts.cloudInit || opts.initScript || '').trim())
    if (init) {
      userDataPath = join(STATE_DIR, 'init-' + name + '-' + Date.now() + '.yml')
      let text = init
      if (opts.initScript && !/^#cloud-config/m.test(String(opts.initScript))) {
        const lines = String(opts.initScript).trimEnd().split('\n').map((l) => '      ' + l)
        text = '#cloud-config\nruncmd:\n  - sh -c |\n' + lines.join('\n') + '\n'
      }
      try {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(userDataPath, text)
        args.push('-c', userDataPath)
      } catch (e) {
        userDataPath = null
      }
    }
    args.push(distro, name)
    const res = await orb(args, { timeoutMs: 900000, signal })
    if (userDataPath) {
      try { rmSync(userDataPath, { force: true }) } catch (e) { /* ignore */ }
    }
    if (res.exitCode !== 0) {
      throw new Error('orb create 失败 (' + String(res.exitCode) + '): ' + String(res.stderr || res.stdout || '').slice(0, 500))
    }
    const found = await waitRunning(name)
    const list = sessionMachines(sessionId)
    list.push({
      name,
      distro,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      spec: {
        cpus: opts.cpus != null ? String(opts.cpus) : '2',
        memory: opts.memory != null ? String(opts.memory) : '2G',
        disk: opts.disk != null ? String(opts.disk) : '16G',
      },
      createdWith: {
        isolated: !!isolated,
        isolateNetwork: !!opts.isolateNetwork,
        init: opts.initScript ? 'init_script' : (opts.cloudInit ? 'cloud_init' : null),
      },
    })
    state.machines[sessionId] = list
    saveState()
    await enforceRunningCap(name)
    await ensureNetworkApplied(name)
    // B1: 默认创建后进行安全基线加固(幂等,失败不阻断创建)
    if (opts.harden !== false && found && found.state === 'running') {
      try {
        await applyHardenBaseline(name)
        const rec = list.find((r) => r.name === name)
        if (rec) { rec.security = Object.assign(rec.security || {}, { hardenedAt: Date.now() }); saveState() }
      } catch (err) {
        try { console.error('[vmsb] 安全基线加固失败(创建继续), machine=' + name + ' ' + String((err && err.message) || err)) } catch (e) { /* ignore */ }
      }
    }
    return { name, distro, state: found ? found.state : 'starting' }
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

async function createMachineForSession(ctx, sessionId, distro, signal, hint, opts) {
  const title = await sessionTitleOf(ctx, sessionId)
  const name = await uniqueMachineName(title, sessionId, hint)
  return createMachineWithName(ctx, sessionId, name, distro, signal, opts)
}

async function ensureSessionMachine(ctx, sessionId, distro, signal, opts) {
  let liveNames = null
  try {
    liveNames = new Set((await listMachines()).map((m) => m.name))
  } catch (err) { /* orb 不可用时不判断存活 */ }
  const list = sessionMachines(sessionId)
  if (list.length > 0) {
    const alive = liveNames === null ? list : list.filter((r) => liveNames.has(r.name))
    if (alive.length > 0) {
      const def = alive.slice().sort(byRecent)[0]
      if (alive.length < list.length) {
        state.machines[sessionId] = alive
        saveState()
      }
      touchMachine(sessionId, def.name)
      const m = await machineStateOf(def.name)
      return { name: def.name, distro: def.distro, state: m ? m.state : 'unknown', sessionId, existing: true, crossSession: false }
    }
    delete state.machines[sessionId]
    saveState()
  }
  const rec = await createMachineForSession(ctx, sessionId, distro, signal, null, opts)
  return { ...rec, sessionId, existing: false, crossSession: false }
}

async function resolveMachineByName(ctx, sessionId, name, distro, signal, opts) {
  const owner = ownerOfMachine(name)
  if (owner) {
    const found = recordOfMachine(name)
    touchMachine(owner, name)
    const rec = found.record
    const m = await machineStateOf(name)
    return { name: rec.name, distro: rec.distro, state: m ? m.state : 'unknown', sessionId: owner, existing: true, crossSession: owner !== sessionId, type: found.type || 'machine' }
  }
  const rec = await createMachineWithName(ctx, sessionId, name, distro, signal, opts)
  return { ...rec, sessionId, existing: false, crossSession: false, type: 'machine' }
}

async function resolveExistingMachineByName(ctx, sessionId, name) {
  const found = recordOfMachine(name)
  if (!found) throw new Error('未找到虚拟机: ' + name)
  touchMachine(found.sessionId, name)
  const m = await machineStateOf(name)
  return { name: found.record.name, distro: found.record.distro, state: m ? m.state : 'unknown', sessionId: found.sessionId, crossSession: found.sessionId !== sessionId, type: found.type || 'machine' }
}

async function resolveDefaultMachine(ctx, sessionId) {
  const def = defaultSessionMachine(sessionId)
  if (!def) throw new Error('本会话没有虚拟机，请先 vm_create 或通过 vm_exec 自动创建')
  return resolveExistingMachineByName(ctx, sessionId, def.name)
}

async function deleteMachineByName(name) {
  const res = await orb(['delete', '-f', name], { timeoutMs: 180000 })
  if (res.exitCode === 0) {
    shellLogs.delete(name)
    metricsStore.delete(name)
    stopMachineTunnels(name)
    invalidateMachineJobs(name)
  }
  return res.exitCode === 0
}

async function removeMachineByName(name) {
  let ok = false
  try {
    ok = await deleteMachineByName(name)
  } catch (err) {
    try { console.error('[vmsb] 删除机器失败', name, err) } catch (e) { /* ignore */ }
  }
  let changed = false
  for (const sid of Object.keys(state.machines)) {
    const list = state.machines[sid]
    if (!Array.isArray(list)) continue
    const next = list.filter((r) => r.name !== name)
    if (next.length === list.length) continue
    changed = true
    if (next.length === 0) delete state.machines[sid]
    else state.machines[sid] = next
  }
  if (changed) saveState()
  return ok
}

async function removeSessionMachines(sessionId) {
  const list = sessionMachines(sessionId)
  if (list.length === 0) return false
  for (const rec of list) {
    try {
      await deleteMachineByName(rec.name)
    } catch (err) {
      try { console.error('[vmsb] 删除机器失败', err) } catch (e) { /* ignore */ }
    }
  }
  delete state.machines[sessionId]
  saveState()
  return true
}
// ---------- B1: 安全基线 / 加固(vm_harden) ----------
const HARDEN_SCRIPT = [
  '#!/bin/sh',
  '# DSH VM baseline hardening (idempotent, B1)',
  'set -e',
  'SSHD=/etc/ssh/sshd_config',
  'if [ -f "$SSHD" ]; then',
  '  sed -i "s/^#\\?PasswordAuthentication.*/PasswordAuthentication no/" "$SSHD" 2>/dev/null || true',
  '  grep -q "^PasswordAuthentication " "$SSHD" || echo "PasswordAuthentication no" >> "$SSHD"',
  '  sed -i "s/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/" "$SSHD" 2>/dev/null || true',
  '  grep -q "^PermitRootLogin " "$SSHD" || echo "PermitRootLogin prohibit-password" >> "$SSHD"',
  '  if command -v systemctl >/dev/null 2>&1; then systemctl reload sshd 2>/dev/null || true',
  '  elif command -v service >/dev/null 2>&1; then (service ssh reload 2>/dev/null || service sshd reload 2>/dev/null) || true',
  '  elif command -v rc-service >/dev/null 2>&1; then (rc-service sshd restart 2>/dev/null || rc-service ssh restart 2>/dev/null) || true',
  '  fi',
  'fi',
  'mkdir -p /etc/dsh',
  'echo "$(date +%s)" > /etc/dsh/hardened-on',
].join('\n')

const HARDEN_CHECK = [
  '#!/bin/sh',
  'if command -v sshd >/dev/null 2>&1; then',
  '  pa=$(sshd -T 2>/dev/null | sed -n "s/^passwordauthentication[[:space:]]*//p" | head -1 | tr -d "\\r\\n")',
  '  case "$pa" in no|NO|false|False) echo "ok sshd.password_auth ";; *) [ -n "$pa" ] && echo "fail sshd.password_auth $pa" || echo "na sshd.password_auth undetermined";; esac',
  '  rl=$(sshd -T 2>/dev/null | sed -n "s/^permitrootlogin[[:space:]]*//p" | head -1 | tr -d "\\r\\n")',
  '  case "$rl" in no|prohibit-password) echo "ok sshd.root_login ";; *) [ -n "$rl" ] && echo "fail sshd.root_login $rl" || echo "na sshd.root_login undetermined";; esac',
  '  pgrep -x sshd >/dev/null 2>&1 && echo "ok sshd.running " || echo "fail sshd.running "',
  'else',
  '  echo "na sshd.password_auth no-sshd(OrbStack agent,无暴露面)"',
  '  echo "na sshd.root_login no-sshd(OrbStack agent,无暴露面)"',
  '  echo "na sshd.running no-sshd(OrbStack agent,无暴露面)"',
  'fi',
  'nl=$(ss -tln 2>/dev/null | awk "NR>1 && \\$4 !~ /^(127\\.|::1|\\[::1)/" | wc -l | tr -d " ")',
  'echo "info listening_nonloopback $nl"',
  '[ -f /etc/dsh/hardened-on ] && echo "ok baseline_marker " || echo "fail baseline_marker "',
  'for b in sed awk; do command -v $b >/dev/null 2>&1 && echo "ok bin.$b " || echo "fail bin.$b "; done',
].join('\n')

function runGuestScript(machine, script, timeoutMs) {
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  return orb(['run', '-m', machine, '-u', 'root', 'sh', '-lc', "printf '%s' '" + b64 + "' | base64 -d | sh"], { timeoutMs: timeoutMs || 120000 })
}
function parseHardenOutput(stdout, stderr) {
  const checks = []
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(ok|fail|info|na)\s+(\S+)(?:\s+(.*))?$/)
    if (m) checks.push({ status: m[1], name: m[2], detail: (m[3] || '').trim() || null })
  }
  if (checks.length) return checks
  return [{ status: 'error', name: 'guest_probe', detail: String(stderr || '').slice(0, 200) || 'orb run 无输出' }]
}
async function applyHardenBaseline(machine) {
  const res = await runGuestScript(machine, HARDEN_SCRIPT, 120000)
  if (res.exitCode !== 0) throw new Error('加固脚本失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  return true
}
async function hardenScan(machine) {
  const res = await runGuestScript(machine, HARDEN_CHECK, 90000)
  return parseHardenOutput(res.stdout, res.stderr)
}
// ---------- B2: 密钥库(vm_secret, AES-256-GCM at rest) ----------
let vaultKey = null
let vaultCache = null
function loadVaultKey() {
  if (vaultKey) return vaultKey
  try {
    const b = readFileSync(VAULT_KEY_FILE, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(b)) { vaultKey = Buffer.from(b, 'hex'); return vaultKey }
  } catch (e) { /* 键缺失 → 生成 */ }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const k = randomBytes(32)
    writeFileSync(VAULT_KEY_FILE, k.toString('hex'), { mode: 0o600 })
    vaultKey = k
  } catch (e) { vaultKey = null }
  return vaultKey
}
function loadVault() {
  if (vaultCache) return vaultCache
  const { data } = readJsonRobust(VAULT_FILE)
  vaultCache = { version: 1, items: (data && data.items) || {} }
  return vaultCache
}
function saveVault() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    atomicWriteJson(VAULT_FILE, vaultCache)
  } catch (e) { /* ignore */ }
}
function vaultEncrypt(plain) {
  const key = loadVaultKey()
  if (!key) throw new Error('密钥库不可用(无法读写 vault.key)')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(String(plain == null ? '' : plain), 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc.toString('hex')
}
function vaultDecrypt(payload) {
  const key = loadVaultKey()
  if (!key) return null
  try {
    const parts = String(payload || '').split(':')
    if (parts.length !== 3) return null
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'))
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8')
  } catch (e) { return null }
}
function vaultGet(name) {
  const item = loadVault().items[name]
  return item ? vaultDecrypt(item.enc) : null
}
function vaultSet(name, value, kind) {
  const vault = loadVault()
  vault.items[name] = { kind: kind || 'secret', enc: vaultEncrypt(value), updatedAt: Date.now() }
  saveVault()
  return true
}
function vaultList() {
  const vault = loadVault()
  return Object.keys(vault.items).map((n) => ({ name: n, kind: vault.items[n].kind, updatedAt: vault.items[n].updatedAt }))
}
function vaultRemove(name) {
  const vault = loadVault()
  if (!(name in vault.items)) return false
  delete vault.items[name]
  saveVault()
  return true
}
// init_script / cloud_init 内占位符注入({{secret:name}} / {{env:name}})
function injectVaultText(text) {
  return String(text || '').replace(/\{\{\s*(secret|env):([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, kind, name) => {
    const v = vaultGet(name)
    return v != null ? v : m
  })
}
// 审计/日志脱敏:把命中的密文替换为 ***
function redactVaultText(text) {
  let out = String(text || '')
  for (const entry of vaultList()) {
    if (entry.kind !== 'secret') continue
    const v = vaultGet(entry.name)
    if (v && out.includes(v)) out = out.split(v).join('***')
  }
  return out
}
function redactDeep(value, depth) {
  if (depth > 6) return value
  if (typeof value === 'string') return redactVaultText(value)
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, depth + 1))
  if (value && typeof value === 'object') {
    const o = {}
    for (const k of Object.keys(value)) o[k] = redactDeep(value[k], depth + 1)
    return o
  }
  return value
}
// ---------- 资源治理:全局运行上限 + 闲置自动休眠/回收 + 孤儿清理 ----------
async function enforceRunningCap(excludeName) {
  let machines = []
  try {
    machines = await listMachines()
  } catch (err) {
    return
  }
  const running = machines.filter((m) => m.state === 'running')
  if (running.length <= MAX_RUNNING) return
  const now = Date.now()
  const ranked = running.map((m) => {
    const owner = ownerOfMachine(m.name)
    const rec = owner ? recordOfMachine(m.name).record : null
    return {
      name: m.name,
      age: rec ? rec.createdAt : Number.MAX_SAFE_INTEGER,
      lastUsed: rec ? (rec.lastUsedAt || rec.createdAt || 0) : 0,
      snapshot: !!state.snapshots[m.name],
    }
  }).sort((a, b) => a.age - b.age)
  const toSleep = []
  for (const item of ranked) {
    if (running.length - toSleep.length <= MAX_RUNNING) break
    if (item.name === excludeName) continue
    if (item.lastUsed && now - item.lastUsed < ACTIVE_WINDOW_MS) continue
    if (item.snapshot) continue
    toSleep.push(item.name)
  }
  for (const name of toSleep) {
    try {
      await orb(['stop', name], { timeoutMs: 120000 })
      try { console.log('[vmsb] 超过上限(' + MAX_RUNNING + '),休眠最旧机器 ' + name) } catch (e) { /* ignore */ }
    } catch (err) {
      try { console.error('[vmsb] 上限休眠失败', name, err) } catch (e) { /* ignore */ }
    }
  }
}

async function idleSweep(ctx) {
  if (sweeping) return
  sweeping = true
  try {
    let machines = []
    try {
      machines = await listMachines()
    } catch (err) {
      return
    }
    const now = Date.now()
    const wr = ctx.get('workspaceRegistry')
    const archived = wr && Array.isArray(wr.archivedSessionIds) ? new Set(wr.archivedSessionIds) : new Set()
    for (const m of machines) {
      if (m.state !== 'running') continue
      const owner = ownerOfMachine(m.name)
      if (!owner || state.snapshots[m.name]) continue
      const rec = recordOfMachine(m.name).record
      const lastUsed = rec.lastUsedAt || rec.createdAt || 0
      const idleMs = Math.max(0, now - lastUsed)
      const policy = sessionPolicy(owner)
      const sleepMs = (policy.idleSleepMinutes || 0) * 60 * 1000
      const deleteMs = (policy.idleDeleteDays || 0) * 24 * 60 * 60 * 1000
      if (deleteMs > 0 && idleMs >= deleteMs) {
        try { console.log('[vmsb] 策略:闲置 ' + Math.round(idleMs / 3600000) + ' 小时,自动删除 ' + m.name) } catch (e) { /* ignore */ }
        await removeMachineByName(m.name)
      } else if (sleepMs > 0 && idleMs >= sleepMs) {
        try {
          await orb(['stop', m.name], { timeoutMs: 120000 })
          try { console.log('[vmsb] 闲置 ' + Math.round(idleMs / 60000) + ' 分钟,自动休眠 ' + m.name) } catch (e) { /* ignore */ }
        } catch (err) {
          try { console.error('[vmsb] 闲置休眠失败', m.name, err) } catch (e) { /* ignore */ }
        }
      }
    }
    // 孤儿清理:会话已不存在(被删除)且未归档 -> 删除其全部机器
    for (const sid of Object.keys(state.machines)) {
      if (archived.has(sid)) continue
      if (wr && typeof wr.sessionKnown === 'function') {
        const known = await wr.sessionKnown(sid).catch(() => true)
        if (!known) {
          try { console.log('[vmsb] 会话已删除,清理机器 ' + sessionMachines(sid).map((r) => r.name).join(',') || sid) } catch (e) { /* ignore */ }
          await removeSessionMachines(sid)
        }
      }
    }
  } finally {
    sweeping = false
  }
}

function loadArchived(ctx) {
  const wr = ctx.get('workspaceRegistry')
  if (wr && Array.isArray(wr.archivedSessionIds)) {
    knownArchived = new Set(wr.archivedSessionIds)
  }
}

async function reconcile(ctx) {
  loadArchived(ctx)
  for (const id of Array.from(knownArchived)) {
    await removeSessionMachines(id)
  }
  try {
    const machines = await listMachines()
    const names = new Set(machines.map((m) => m.name))
    for (const key of Array.from(shellLogs.keys())) {
      if (!names.has(key)) shellLogs.delete(key)
    }
    let changed = false
    for (const sid of Object.keys(state.machines)) {
      const list = state.machines[sid]
      if (!Array.isArray(list)) continue
      const next = list.filter((r) => names.has(r.name))
      if (next.length === list.length) continue
      changed = true
      if (next.length === 0) delete state.machines[sid]
      else state.machines[sid] = next
    }
    if (changed) saveState()
    reconcileTunnels()
    reconcileJobs()
  } catch (err) { /* orb 不可用时忽略 */ }
}

async function handleDisposed(ctx, sessionId) {
  if (!state.machines[sessionId]) return
  const wr = ctx.get('workspaceRegistry')
  if (wr && typeof wr.sessionKnown === 'function') {
    const known = await wr.sessionKnown(sessionId).catch(() => true)
    if (known) return
  }
  await removeSessionMachines(sessionId)
}
// ---------- 快照与回滚(使用 OrbStack 官方 orb clone 实现) ----------
function snapshotRecord(name) {
  return state.snapshots[name] || null
}

function countSessionSnapshots(sessionId) {
  return Object.values(state.snapshots).filter((s) => s.sessionId === sessionId).length
}

async function createSnapshot(ctx, sessionId, name, note) {
  const target = await resolveExistingMachineByName(ctx, sessionId, name)
  if (target.type === 'snapshot') throw new Error('不能对快照再创建快照')
  if (!canManage(sessionId, name)) throw new Error('没有权限对该虚拟机执行快照(' + name + ')')
  const resourceName = name
  const latest = await machineStateOf(resourceName)
  const wasRunning = !!(latest && latest.state === 'running')
  if (countSessionSnapshots(sessionId) >= MAX_SNAPSHOTS_PER_SESSION) {
    throw new Error('本会话快照数量已达上限(' + MAX_SNAPSHOTS_PER_SESSION + ' 个),请先删除旧快照')
  }
  if (Object.keys(state.snapshots).length >= MAX_SNAPSHOTS) {
    throw new Error('全局快照数量已达上限(' + MAX_SNAPSHOTS + ' 个)')
  }
  const snapName = await uniqueSnapshotName()
  const res = await orb(['clone', resourceName, snapName], { timeoutMs: 900000 })
  if (res.exitCode !== 0) {
    throw new Error('orb clone 快照失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
  const rec = state.snapshots[snapName] = {
    name: snapName,
    source: resourceName,
    distro: target.distro,
    sessionId,
    createdAt: Date.now(),
    wasRunning,
    note: String(note || '').slice(0, 500),
  }
  saveState()
  return { ok: true, snapshot: rec, state: 'stopped', note: '快照为 OrbStack clone，数据按需复制，不占用双倍磁盘' }
}

async function restoreSnapshot(ctx, sessionId, snapshotName) {
  const snap = snapshotRecord(snapshotName)
  if (!snap) throw new Error('未找到快照: ' + snapshotName)
  const srcName = snap.source
  if (!canManage(sessionId, srcName)) {
    if (!canManage(sessionId, snapshotName)) throw new Error('没有权限恢复该快照')
  }
  const current = await machineStateOf(srcName)
  const wasRunning = !!(current && current.state === 'running')
  if (current) {
    stopMachineTunnels(srcName)
    invalidateMachineJobs(srcName)
    const del = await orb(['delete', '-f', srcName], { timeoutMs: 180000 })
    if (del.exitCode !== 0) {
      throw new Error('恢复前删除当前机器失败: ' + String(del.stderr || del.stdout || '').slice(0, 300))
    }
    shellLogs.delete(srcName)
    metricsStore.delete(srcName)
  }
  const cl = await orb(['clone', snapshotName, srcName], { timeoutMs: 900000 })
  if (cl.exitCode !== 0) {
    throw new Error('orb clone 恢复失败: ' + String(cl.stderr || cl.stdout || '').slice(0, 300))
  }
  if (wasRunning) {
    const st = await orb(['start', srcName], { timeoutMs: 300000 })
    if (st.exitCode !== 0) {
      throw new Error('恢复后启动失败: ' + String(st.stderr || st.stdout || '').slice(0, 300))
    }
    await ensureNetworkApplied(srcName)
  }
  const found = recordOfMachine(srcName)
  if (found && found.type === 'machine') {
    touchMachine(found.sessionId, srcName)
  }
  // 快照记录保留,可再次回滚
  return { ok: true, machine: srcName, snapshot: snapshotName, state: wasRunning ? 'running' : 'stopped' }
}

async function deleteSnapshot(ctx, sessionId, snapshotName) {
  const snap = snapshotRecord(snapshotName)
  if (!snap) throw new Error('未找到快照: ' + snapshotName)
  if (!canOwner(sessionId, snapshotName)) throw new Error('只有快照归属会话可以删除')
  const res = await orb(['delete', '-f', snapshotName], { timeoutMs: 180000 })
  if (res.exitCode !== 0) {
    throw new Error('删除快照机器失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
  delete state.snapshots[snapshotName]
  saveState()
  return { ok: true, snapshot: snapshotName }
}

function listSnapshots() {
  return Object.values(state.snapshots).slice().sort((a, b) => b.createdAt - a.createdAt).map((s) => ({ ...s }))
}
// ---------- 文件传输(OrbStack 官方 orb push / orb pull) ----------
function workspaceRootOf(ctx) {
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp && sp.workspaceRoot) return sp.workspaceRoot
  } catch (e) { /* ignore */ }
  return process.cwd()
}

function resolveLocalPath(ctx, p) {
  const root = workspaceRootOf(ctx)
  const full = resolve(root, String(p || '').replace(/^~/, HOME))
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('本地路径必须位于工作区内: ' + root)
  }
  return full
}

async function uploadToMachine(ctx, sessionId, machineName, localPath, remotePath) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canExec(sessionId, target.name)) throw new Error('没有权限向该虚拟机上传文件(' + target.name + ')')
  await ensureRunning(target.name)
  const local = resolveLocalPath(ctx, localPath)
  if (!existsSync(local)) throw new Error('本地文件不存在: ' + local)
  const remote = String(remotePath || '')
  if (!remote.trim()) throw new Error('remote_path 不能为空')
  const res = await orb(['push', '-m', target.name, local, remote], { timeoutMs: 600000 })
  if (res.exitCode !== 0) {
    throw new Error('orb push 失败: ' + String(res.stderr || res.stdout || '').slice(0, 500))
  }
  return { ok: true, machine: target.name, localPath: local, remotePath: remote, operation: 'upload' }
}

async function downloadFromMachine(ctx, sessionId, machineName, remotePath, localPath) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canExec(sessionId, target.name)) throw new Error('没有权限从该虚拟机下载文件(' + target.name + ')')
  await ensureRunning(target.name)
  const local = resolveLocalPath(ctx, localPath)
  const remote = String(remotePath || '')
  if (!remote.trim()) throw new Error('remote_path 不能为空')
  if ((localPath.endsWith('/') || localPath.endsWith(sep)) && !existsSync(local)) {
    try { mkdirSync(local, { recursive: true }) } catch (e) { /* ignore */ }
  }
  const res = await orb(['pull', '-m', target.name, remote, local], { timeoutMs: 600000 })
  if (res.exitCode !== 0) {
    throw new Error('orb pull 失败: ' + String(res.stderr || res.stdout || '').slice(0, 500))
  }
  return { ok: true, machine: target.name, remotePath: remote, localPath: local, operation: 'download' }
}
// ---------- 后台任务管理 ----------
function jobById(id) {
  return state.jobs.find((j) => j.id === id) || null
}

function sessionJobs(sessionId) {
  return state.jobs.filter((j) => j.sessionId === sessionId)
}

function invalidateMachineJobs(machine) {
  const now = Date.now()
  let changed = false
  for (const j of state.jobs) {
    if (j.machine === machine && j.status !== 'done' && j.status !== 'error' && j.status !== 'stopped') {
      j.status = 'error'
      j.endTime = now
      j.error = '虚拟机已删除或恢复，任务被终止'
      changed = true
    }
  }
  if (changed) saveState()
}

function reconcileJobs() {
  const names = new Set()
  try {
    listMachines().then((machines) => {
      const live = new Set(machines.map((m) => m.name))
      let changed = false
      for (const j of state.jobs) {
        if (!live.has(j.machine) && j.status !== 'done' && j.status !== 'error' && j.status !== 'stopped') {
          j.status = 'error'
          j.error = '虚拟机不存在'
          j.endTime = Date.now()
          changed = true
        }
      }
      if (changed) saveState()
    }).catch(() => {})
  } catch (e) { /* ignore */ }
}

async function submitJob(ctx, sessionId, machineName, command) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canExec(sessionId, target.name)) throw new Error('没有权限在该虚拟机提交任务(' + target.name + ')')
  await ensureRunning(target.name)
  if (sessionJobs(sessionId).filter((j) => j.status === 'running').length >= MAX_JOBS_PER_SESSION) {
    throw new Error('本会话后台任务数量已达上限(' + MAX_JOBS_PER_SESSION + ')')
  }
  const id = genId('job')
  const dir = VM_JOBS_DIR + '/' + id
  const commandB64 = Buffer.from(command, 'utf8').toString('base64')
  const runScript = [
    '#!/bin/sh',
    'cd ' + dir + ' || exit 125',
    'sh ./cmd.sh',
    'code=$?',
    "printf '%s\\n' \"$code\" > ./status",
    "date +%s%3N > ./end",
  ].join('\n')
  const runB64 = Buffer.from(runScript, 'utf8').toString('base64')
  const setup = [
    'set -e',
    'mkdir -p ' + dir,
    "printf '%s' '" + commandB64 + "' | base64 -d > " + dir + '/cmd.sh',
    "printf '%s' '" + runB64 + "' | base64 -d > " + dir + '/run.sh',
    'chmod +x ' + dir + '/run.sh ' + dir + '/cmd.sh',
    'rm -f ' + dir + '/status ' + dir + '/end',
    'setsid sh ' + dir + '/run.sh > ' + dir + '/out.log 2>&1 &',
    'echo $!',
  ].join('\n')
  const res = await orb(['run', '-m', target.name, '-u', 'root', 'sh', '-lc', setup], { timeoutMs: 30000 })
  if (res.exitCode !== 0) {
    throw new Error('提交后台任务失败: ' + String(res.stderr || res.stdout || '').slice(0, 500))
  }
  const pid = String(res.stdout || '').trim().split('\n').pop()
  const job = {
    id,
    machine: target.name,
    sessionId,
    command,
    pid: pid ? Number(pid) : null,
    dir,
    startTime: Date.now(),
    endTime: null,
    status: 'running',
    exitCode: null,
    error: null,
  }
  state.jobs.push(job)
  saveState()
  const status = await readJobStatus(job)
  return { ok: true, job: { ...job, ...status } }
}

async function readJobStatus(job) {
  const probe = [
    'D=' + job.dir + '; P=' + (job.pid || 0) + '; [ "$P" -gt 0 ] 2>/dev/null || P=0',
    'if [ -f "$D/status" ]; then echo "state=done"; echo "exit=$(cat "$D/status")"; echo "end=$(cat "$D/end" 2>/dev/null || true)"; else if [ "$P" -gt 0 ] 2>/dev/null && kill -0 "$P" 2>/dev/null; then echo "state=running"; else echo "state=dead"; fi; fi',
    'echo "tail="',
    'tail -c 8192 "$D/out.log" 2>/dev/null || true',
  ].join('; ')
  const res = await orb(['run', '-m', job.machine, '-u', 'root', 'sh', '-lc', probe], { timeoutMs: 30000 })
  const text = String(res.stdout || '')
  let stateText = 'unknown'
  let exitCode = null
  let endTime = null
  let tail = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('state=')) stateText = line.slice(6).trim()
    else if (line.startsWith('exit=')) exitCode = Number(line.slice(5).trim())
    else if (line.startsWith('end=')) endTime = Number(line.slice(4).trim()) || null
    else if (line.startsWith('tail=')) tail = ''
  }
  const idx = text.indexOf('tail=')
  if (idx >= 0) tail = text.slice(idx + 5).trim()
  if (stateText === 'done' && job.status === 'running') {
    job.status = 'done'
    job.exitCode = exitCode
    job.endTime = endTime || Date.now()
    saveState()
  } else if (stateText === 'dead' && job.status === 'running') {
    job.status = 'error'
    job.error = '进程不存在或已退出'
    job.endTime = Date.now()
    saveState()
  }
  return { status: stateText, exitCode: exitCode === null && job.status === 'done' ? job.exitCode : exitCode, endTime, tail, stdout: tail, stderr: '' }
}

async function stopJob(ctx, sessionId, jobId) {
  const job = jobById(jobId)
  if (!job) throw new Error('未找到后台任务: ' + jobId)
  if (job.sessionId !== sessionId && !canManage(sessionId, job.machine)) throw new Error('没有权限停止该任务')
  if (job.status !== 'running') return { ok: true, job: { ...job }, alreadyFinished: true }
  const killCmd = 'D=' + job.dir + '; P=' + job.pid + '; [ "$P" -gt 0 ] 2>/dev/null || P=0; kill -TERM -- -"$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null || true; for i in 1 2 3 4 5; do [ "$P" -gt 0 ] 2>/dev/null && kill -0 "$P" 2>/dev/null || exit 0; sleep 1; done; kill -KILL -- -"$P" 2>/dev/null || kill -KILL "$P" 2>/dev/null || true'
  const res = await orb(['run', '-m', job.machine, '-u', 'root', 'sh', '-lc', killCmd], { timeoutMs: 30000 })
  if (res.exitCode !== 0 && !String(res.stderr || '').includes('No such process')) {
    throw new Error('停止任务失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
  job.status = 'stopped'
  job.endTime = Date.now()
  saveState()
  return { ok: true, job: { ...job } }
}

async function jobFullOutput(jobId, maxBytes) {
  const job = jobById(jobId)
  if (!job) throw new Error('未找到后台任务: ' + jobId)
  const limit = Math.max(1024, Number(maxBytes) || 1024 * 1024)
  const res = await orb(['run', '-m', job.machine, '-u', 'root', 'sh', '-lc', 'tail -c ' + limit + ' ' + job.dir + '/out.log 2>/dev/null || true'], { timeoutMs: 30000 })
  return { ok: true, id: job.id, machine: job.machine, command: job.command, log: String(res.stdout || '') }
}
async function jobLogRotate(jobId) {
  const job = jobById(jobId)
  if (!job) throw new Error('未找到后台任务: ' + jobId)
  const ts = Date.now()
  const archived = job.dir + '/out.log.' + ts + '.archived'
  const res = await orb(['run', '-m', job.machine, '-u', 'root', 'sh', '-lc', 'if [ -f ' + job.dir + '/out.log ]; then mv ' + job.dir + '/out.log ' + archived + '; : > ' + job.dir + '/out.log; echo ' + archived + '; else echo none; fi'], { timeoutMs: 30000 })
  return { ok: true, id: job.id, machine: job.machine, archived: String(res.stdout || '').trim(), exitCode: res.exitCode }
}

async function jobLogArchives(jobId) {
  const job = jobById(jobId)
  if (!job) throw new Error('未找到后台任务: ' + jobId)
  const res = await orb(['run', '-m', job.machine, '-u', 'root', 'sh', '-lc', 'ls -1 ' + job.dir + '/*.archived 2>/dev/null || true'], { timeoutMs: 30000 })
  const files = String(res.stdout || '').trim().split('\n').filter(Boolean)
  return { ok: true, id: job.id, machine: job.machine, archives: files }
}
// ---------- P1/P2/P3: 定时任务、模板、指标、调整、导入导出、服务发现 ----------

// ---- Cron 定时任务 ----
function cronPartMatch(value, expr) {
  const v = Number(value)
  if (expr === '*' || expr === '*/1') return true
  if (expr.startsWith('*/')) {
    const step = Number(expr.slice(2))
    return step > 0 && v % step === 0
  }
  if (expr.includes(',')) return expr.split(',').some((p) => cronPartMatch(v, p.trim()))
  if (expr.includes('-')) {
    const [a, b] = expr.split('-').map(Number)
    return v >= a && v <= b
  }
  if (expr.includes('/')) {
    const [base, step] = expr.split('/')
    if (base === '*') return v % Number(step) === 0
    return v % Number(step) === 0 && cronPartMatch(v, base)
  }
  return v === Number(expr)
}

function cronMatch(date, expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minute, hour, day, month, weekday] = parts
  if (!cronPartMatch(date.getMinutes(), minute)) return false
  if (!cronPartMatch(date.getHours(), hour)) return false
  if (!cronPartMatch(date.getDate(), day)) return false
  if (!cronPartMatch(date.getMonth() + 1, month)) return false
  if (!cronPartMatch(date.getDay(), weekday)) return false
  return true
}

function nextCronRun(expr, fromDate) {
  const start = new Date(fromDate || Date.now())
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  // 向后扫描 7 天，足以覆盖绝大多数常见表达式
  const limit = start.getTime() + 7 * 24 * 60 * 60 * 1000
  const probe = new Date(start)
  while (probe.getTime() <= limit) {
    if (cronMatch(probe, expr)) return new Date(probe)
    probe.setMinutes(probe.getMinutes() + 1)
  }
  return null
}

async function runCronTick(ctx) {
  const now = new Date()
  for (const job of state.cron || []) {
    if (!job.enabled) continue
    const last = job.lastRunAt ? new Date(job.lastRunAt) : null
    if (last && now.getTime() - last.getTime() < 60 * 1000) continue
    if (!cronMatch(now, job.expr)) continue
    try {
      const out = await submitJob(ctx, job.sessionId, job.machine, job.command)
      job.lastRunAt = Date.now()
      job.nextRunAt = nextCronRun(job.expr, new Date(Date.now() + 1000))?.getTime() || null
      job.lastJobId = out.job ? out.job.id : null
      saveState()
      pushAudit(job.sessionId, job.machine, 'vm_cron_run', { cronId: job.id, jobId: job.lastJobId }, true, null)
    } catch (e) {
      pushAudit(job.sessionId, job.machine, 'vm_cron_run', { cronId: job.id }, false, e && e.message || e)
    }
  }
}

async function autoSnapshotTick(ctx) {
  const now = Date.now()
  for (const sid of Object.keys(state.machines)) {
    const policy = sessionPolicy(sid)
    const interval = Number(policy.snapshotIntervalHours || 0)
    const retention = Number(policy.snapshotRetention || 0)
    if (!(interval > 0)) continue
    for (const rec of sessionMachines(sid)) {
      const key = rec.name
      const last = rec.lastSnapshotAt || rec.createdAt || 0
      if (now - last < interval * 3600 * 1000) continue
      try {
        const out = await createSnapshot(ctx, sid, rec.name, 'auto-snapshot')
        rec.lastSnapshotAt = Date.now()
        saveState()
        if (retention > 0) {
          const snaps = Object.values(state.snapshots)
            .filter((s) => s.source === rec.name && s.sessionId === sid)
            .sort((a, b) => b.createdAt - a.createdAt)
          const remove = snaps.slice(retention)
          for (const s of remove) {
            await orb(['delete', '-f', s.name], { timeoutMs: 180000 })
            delete state.snapshots[s.name]
            saveState()
          }
        }
        pushAudit(sid, rec.name, 'auto_snapshot', { snapshot: out.snapshot && out.snapshot.name }, true, null)
      } catch (e) {
        pushAudit(sid, rec.name, 'auto_snapshot', {}, false, e && e.message || e)
      }
    }
  }
}
// ---------- 端口转发(ssh -N -L, OrbStack 官方 ssh MACHINE@orb) ----------
function tunnelStartupArgs(machine, bindHost, hostPort, vmPort) {
  return [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-L', bindHost + ':' + hostPort + ':127.0.0.1:' + vmPort,
    machine + '@orb',
  ]
}

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.once('error', () => resolvePromise(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolvePromise(true))
    })
  })
}

function findFreePort() {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolvePromise(port))
    })
    srv.once('error', (err) => resolvePromise(0))
  })
}

async function startPortForward(ctx, sessionId, machineName, vmPort, hostPort, bindHost) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canExec(sessionId, target.name)) throw new Error('没有权限对该虚拟机创建端口转发(' + target.name + ')')
  await ensureRunning(target.name)
  const vp = Number(vmPort)
  if (!Number.isInteger(vp) || vp < 1 || vp > 65535) throw new Error('vm_port 必须是 1-65535 的整数')
  const bh = String(bindHost || '127.0.0.1').trim()
  if (bh !== 'localhost' && bh !== '127.0.0.1' && bh !== '::1') throw new Error('bind_host 仅支持 localhost / 127.0.0.1 / ::1')
  const stateTunnels = state.tunnels.filter((t) => t.machine === target.name && t.status === 'running')
  if (stateTunnels.length >= MAX_TUNNELS) throw new Error('该虚拟机端口转发数量已达上限(' + MAX_TUNNELS + ')')
  let hp = Number(hostPort)
  if (!hp) {
    hp = await findFreePort()
    if (!hp) throw new Error('找不到可用的本地端口')
  }
  if (!Number.isInteger(hp) || hp < 1 || hp > 65535) throw new Error('host_port 必须是 1-65535 的整数')
  if (!(await isPortFree(hp))) throw new Error('本地端口已被占用: ' + hp)
  const child = spawn('ssh', tunnelStartupArgs(target.name, bh, hp, vp), {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  await sleep(700)
  if (child.exitCode !== null) {
    throw new Error('SSH 端口转发进程提前退出(exit=' + child.exitCode + '),请确认 VM 内端口可访问')
  }
  const id = genId('tun')
  const tunnel = { id, machine: target.name, vmPort: vp, hostPort: hp, bindHost: bh, pid: child.pid, sessionId, createdAt: Date.now(), status: 'running' }
  state.tunnels.push(tunnel)
  saveState()
  return { ok: true, tunnel }
}

function stopTunnelById(idOrPort) {
  const tunnels = state.tunnels.filter((t) => t.id === idOrPort || String(t.hostPort) === String(idOrPort))
  if (tunnels.length === 0) return { ok: false, reason: '未找到对应转发' }
  for (const t of tunnels) {
    try {
      if (t.pid) process.kill(t.pid, 'SIGTERM')
      t.status = 'stopped'
      t.stoppedAt = Date.now()
    } catch (e) { /* already gone */ }
  }
  saveState()
  return { ok: true, stopped: tunnels.map((t) => t.id) }
}

function stopMachineTunnels(machine) {
  for (const t of state.tunnels) {
    if (t.machine !== machine || t.status !== 'running') continue
    try {
      if (t.pid) process.kill(t.pid, 'SIGTERM')
      t.status = 'stopped'
      t.stoppedAt = Date.now()
    } catch (e) { /* ignore */ }
  }
  if (state.tunnels.some((t) => t.machine === machine)) saveState()
}

function reconcileTunnels() {
  let changed = false
  for (const t of state.tunnels) {
    if (t.status !== 'running') continue
    if (!t.pid) { t.status = 'stopped'; changed = true; continue }
    try {
      process.kill(t.pid, 0)
    } catch (e) {
      t.status = 'stopped'
      t.stoppedAt = Date.now()
      changed = true
    }
  }
  if (changed) saveState()
}

function tunnelView() {
  reconcileTunnels()
  return state.tunnels.slice().reverse().map((t) => ({ ...t }))
}
// ---------- 网络策略 ----------
function networkPolicyOf(name) {
  const p = state.network[name]
  if (!p) return null
  return { publicAccess: p.publicAccess !== false, internalAccess: p.internalAccess !== false, isolated: !!p.isolated, isolateNetwork: !!p.isolateNetwork, allowlist: Array.isArray(p.allowlist) ? p.allowlist : [], updatedAt: p.updatedAt || 0, appliedAt: p.appliedAt || null }
}

async function ensureNetworkApplied(name) {
  const p = state.network[name]
  if (!p) return
  await applyNetworkPolicyToMachine(name)
}

const ALLOWLIST_RE = /^[0-9a-zA-Z.:\-_/]+$/
function validateAllowlist(entries) {
  const out = []
  for (const raw of entries || []) {
    if (raw === null || raw === undefined) continue
    const item = String(raw).trim()
    if (!item) continue
    if (item.length > 253 || !ALLOWLIST_RE.test(item)) {
      throw new Error('allowlist 仅支持 IP / CIDR / 域名(仅允许字母数字 . : - _ /),非法项: ' + item.slice(0, 40))
    }
    out.push(item)
  }
  return out
}

async function applyNetworkPolicyToMachine(name) {
  const p = state.network[name]
  if (!p) return
  // 二次校验(纵深防御):即使策略已被写入,应用前也拒绝注入 shell 的项
  const allowlist = validateAllowlist(p.allowlist || [])
  const m = await machineStateOf(name)
  if (!m || m.state !== 'running') return
  const publicAccess = p.publicAccess !== false
  const internalAccess = p.internalAccess !== false
  const script = [
    "if ! command -v iptables >/dev/null 2>&1; then",
    "  if [ -f /etc/alpine-release ]; then apk add --no-cache iptables >/dev/null 2>&1; else apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null 2>&1; fi",
    "fi",
    "command -v iptables >/dev/null 2>&1 || exit 20",
    "iptables -N DSH_VM 2>/dev/null || iptables -F DSH_VM",
    "iptables -C INPUT -j DSH_VM 2>/dev/null || iptables -I INPUT 1 -j DSH_VM",
    "iptables -C OUTPUT -j DSH_VM 2>/dev/null || iptables -I OUTPUT 1 -j DSH_VM",
    "iptables -F DSH_VM",
    "iptables -A DSH_VM -i lo -j RETURN",
    "iptables -A DSH_VM -o lo -j RETURN",
    "iptables -A DSH_VM -m state --state ESTABLISHED,RELATED -j RETURN",
    "GW=$(ip route | awk '/default/{print $3; exit}')",
    "[ -n \"$GW\" ] && iptables -A DSH_VM -d \"$GW\" -j RETURN && iptables -A DSH_VM -s \"$GW\" -j RETURN",
  ]
  for (const item of allowlist) {
    if (/[a-zA-Z]/.test(item)) {
      script.push("H=$(getent ahostsv4 " + item + " 2>/dev/null | awk 'NR==1{print $1}'); [ -n \"$H\" ] && iptables -A DSH_VM -d \"$H\" -j RETURN && iptables -A DSH_VM -s \"$H\" -j RETURN")
    } else {
      script.push('iptables -A DSH_VM -d ' + item + ' -j RETURN')
      script.push('iptables -A DSH_VM -s ' + item + ' -j RETURN')
    }
  }
  if (!internalAccess) {
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
      script.push('iptables -A DSH_VM -d ' + cidr + ' -j DROP')
      script.push('iptables -A DSH_VM -s ' + cidr + ' -j DROP')
    }
  }
  if (!publicAccess) {
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
      script.push('iptables -A DSH_VM -d ' + cidr + ' -j RETURN')
      script.push('iptables -A DSH_VM -s ' + cidr + ' -j RETURN')
    }
    script.push('iptables -A DSH_VM -j DROP')
  }
  script.push('iptables -A DSH_VM -j RETURN')
  const b64 = Buffer.from(script.join('\n'), 'utf8').toString('base64')
  const res = await orb(['run', '-m', name, '-u', 'root', 'sh', '-lc', "printf '%s' '" + b64 + "' | base64 -d | sh"], { timeoutMs: 180000 })
  if (res.exitCode !== 0) {
    const err = String(res.stderr || res.stdout || '').slice(0, 300)
    throw new Error('应用网络策略失败: ' + err)
  }
  p.appliedAt = Date.now()
  saveState()
}

async function setNetworkPolicy(ctx, sessionId, machineName, publicAccess, internalAccess, isolated, isolateNetwork, allowlist) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canManage(sessionId, target.name)) throw new Error('没有权限修改网络策略(' + target.name + ')')
  const now = Date.now()
  const p = state.network[target.name] = Object.assign(
    { publicAccess: true, internalAccess: true, isolated: false, isolateNetwork: false, allowlist: [] },
    state.network[target.name] || {},
  )
  if (publicAccess !== undefined) p.publicAccess = !!publicAccess
  if (internalAccess !== undefined) p.internalAccess = !!internalAccess
  if (isolated !== undefined) p.isolated = !!isolated
  if (isolateNetwork !== undefined) p.isolateNetwork = !!isolateNetwork
  if (p.isolateNetwork) p.isolated = true
  if (Array.isArray(allowlist)) p.allowlist = validateAllowlist(allowlist)
  p.updatedAt = now
  p.appliedAt = null
  saveState()
  await ensureRunning(target.name)
  await applyNetworkPolicyToMachine(target.name)
  return { ok: true, machine: target.name, policy: networkPolicyOf(target.name) }
}

async function networkStatusOf(ctx, sessionId, machineName) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canExec(sessionId, target.name)) throw new Error('没有权限查看网络策略(' + target.name + ')')
  const info = await orb(['info', '-f', 'json', target.name], { timeoutMs: 30000 })
  let official = {}
  if (info.exitCode === 0) {
    try {
      const parsed = JSON.parse(info.stdout)
      official = parsed.record ? parsed.record.config : parsed.config || {}
    } catch (e) { /* ignore */ }
  }
  return { ok: true, machine: target.name, official, policy: networkPolicyOf(target.name) || { publicAccess: true, internalAccess: true, isolated: !!official.isolated, isolateNetwork: !!official.isolate_network } }
}
// ---------- 面板数据 / 状态详情 ----------
async function machineConfigOf(name) {
  const res = await orb(['config', 'list'], { timeoutMs: 30000 })
  if (res.exitCode !== 0) return {}
  const out = {}
  const prefix = 'machine.' + name + '.'
  for (const line of res.stdout.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key.indexOf(prefix) === 0) {
      out[key.slice(prefix.length)] = value
    }
  }
  return out
}

const PROBE_CMD = [
  '#!/bin/sh',
  'echo "uptime=$(uptime -p 2>/dev/null || uptime 2>/dev/null || true)"',
  'echo "load=$(cat /proc/loadavg 2>/dev/null || true)"',
  "mem=$(free -b 2>/dev/null | awk 'NR==2{print $2, $3, $7}')",
  'echo "mem=$mem"',
  'disk=$(df -B1 / 2>/dev/null | awk \'NR==2{print $2, $3, $4}\')',
  'echo "disk=$disk"',
  'cpu_busy=$(awk \'NR==1{print $2+$3+$4+$6+$7+$8, $5, $2+$3+$4+$5+$6+$7+$8}\' /proc/stat 2>/dev/null)',
  'cpu_cores=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0)',
  'echo "cpu=$cpu_busy $cpu_cores"',
  'echo "cpu=$cpu"',
  "net=$(awk '$1 ~ /^(eth|ens|enp|en|wl|wlan)/ {rx += $2; tx += $10} END {print rx+0, tx+0}' /proc/net/dev 2>/dev/null)",
  'echo "net=$net"',
  "io=$(awk '$3 ~ /^(sda|sdb|sdc|sdd|nvme[0-9]n[0-9]|vd[a-z])/ {r += $6; w += $10} END {print r+0, w+0}' /proc/diskstats 2>/dev/null)",
  'echo "io=$io"',
  'echo "tops="',
  "(ps -eo pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null || ps -o pcpu=,pmem=,args= 2>/dev/null || ps aux 2>/dev/null) | head -6",
].join('\n')

function parseProbeOutput(stdout) {
  const out = {}
  let inTops = false
  const tops = []
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw
    if (line.startsWith('tops=')) { inTops = true; continue }
    if (inTops) {
      if (line.includes('=')) { inTops = false } else {
        const m = line.trim().split(/\s+/)
        if (m.length >= 3 && /^[0-9.]/.test(m[0]) && /^[0-9.]/.test(m[1])) tops.push({ cpu: Number(m[0]), mem: Number(m[1]), cmd: m.slice(2).join(' ') })
        continue
      }
    }
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (!v) continue
    if (k === 'uptime') out.uptime = v
    else if (k === 'load') out.load = v
    else if (k === 'mem') { const p = v.split(/\s+/).map(Number); out.memory = { totalBytes: p[0] || null, usedBytes: p[1] || null, availableBytes: p[2] || null } }
    else if (k === 'disk') { const p = v.split(/\s+/).map(Number); out.rootFs = { totalBytes: p[0] || null, usedBytes: p[1] || null, availableBytes: p[2] || null } }
    else if (k === 'cpu') { const p = v.split(/\s+/).map(Number); out.cpu = { busy: p[0] || 0, idle: p[1] || 0, total: p[2] || 0, cores: p[3] || null } }
    else if (k === 'net') { const p = v.split(/\s+/).map(Number); out.net = { rx: p[0] || 0, tx: p[1] || 0 } }
    else if (k === 'io') { const p = v.split(/\s+/).map(Number); out.io = { r: p[0] || 0, w: p[1] || 0 } }
  }
  if (tops.length) out.tops = tops
  return out
}

async function probeStatus(name) {
  const b64 = Buffer.from(PROBE_CMD, 'utf8').toString('base64')
  const res = await orb(['run', '-m', name, '-u', 'root', 'sh', '-lc', "printf '%s' '" + b64 + "' | base64 -d | sh"], { timeoutMs: 15000 })
  const out = parseProbeOutput(res.stdout || '')
  if (res.exitCode !== 0) out.probeError = String(res.stderr || '')
  return out
}

async function machineDetail(ctx, name, sessionId) {
  const res = await orb(['info', '-f', 'json', name], { timeoutMs: 30000 })
  if (res.exitCode !== 0) {
    throw new Error('orb info 失败: ' + String(res.stderr || res.stdout || res.exitCode).slice(0, 300))
  }
  let parsed
  try {
    parsed = JSON.parse(res.stdout.trim() || '{}')
  } catch (err) {
    throw new Error('orb info 输出解析失败: ' + res.stdout.slice(0, 200))
  }
  const record = parsed.record || {}
  const limits = await machineConfigOf(name)
  const owner = ownerOfMachine(name)
  const info = owner ? { sessionId: owner, title: await sessionTitleOf(ctx, owner) } : null
  const snap = state.snapshots[name] || null
  const runtime = record.state === 'running' ? await probeStatus(name).catch(() => ({})) : null
  return {
    ok: true,
    id: String(record.id || ''),
    name: String(record.name || name),
    state: String(record.state || ''),
    image: record.image || {},
    config: record.config || {},
    builtin: !!record.builtin,
    diskSizeBytes: typeof parsed.disk_size === 'number' ? parsed.disk_size : null,
    ip4: parsed.ip4 || null,
    ip6: parsed.ip6 || null,
    limits,
    owner: info,
    ownedByThis: !!sessionId && owner === sessionId,
    kind: snap ? 'snapshot' : (recordOfMachine(name) ? recordOfMachine(name).type : 'machine'),
    snapshot: snap,
    sharedWith: sharesOf(name),
    network: networkPolicyOf(name),
    runtime,
    recentShell: (shellLogs.get(name) || []).slice(-10).reverse(),
  }
}

async function listView(ctx, sessionId) {
  const machines = await listMachines()
  const rows = []
  for (const m of machines) {
    const found = recordOfMachine(m.name)
    const owner = found ? found.sessionId : null
    const info = owner ? { sessionId: owner, title: await sessionTitleOf(ctx, owner) } : null
    const snap = state.snapshots[m.name] || null
    rows.push({
      ...m,
      owner: info,
      ownedByThis: !!sessionId && owner === sessionId,
      kind: snap ? 'snapshot' : (found ? found.type : 'machine'),
      source: snap ? snap.source : null,
      note: snap ? snap.note : null,
      sharedWith: sharesOf(m.name),
    })
  }
  const own = sessionMachines(sessionId).map((r) => ({ name: r.name, distro: r.distro }))
  const sessionsList = []
  const seen = new Set()
  for (const sid of Object.keys(state.machines)) {
    if (seen.has(sid)) continue
    seen.add(sid)
    sessionsList.push({ sessionId: sid, title: await sessionTitleOf(ctx, sid) })
  }
  for (const snap of Object.values(state.snapshots)) {
    if (seen.has(snap.sessionId)) continue
    seen.add(snap.sessionId)
    sessionsList.push({ sessionId: snap.sessionId, title: await sessionTitleOf(ctx, snap.sessionId) })
  }
  return {
    ok: true,
    machines: rows,
    own,
    snapshots: listSnapshots(),
    sessions: sessionsList,
    sessionId,
    cap: MAX_RUNNING,
    maxPerSession: MAX_PER_SESSION,
    maxSnapshots: MAX_SNAPSHOTS,
    maxSnapshotsPerSession: MAX_SNAPSHOTS_PER_SESSION,
    quota: (() => { const q = quotaState(sessionId, 0, 0); return { maxMachines: q.policy.maxMachines, cpuQuota: q.policy.cpuQuota || null, memoryQuotaMiB: q.policy.memoryQuotaMiB || null, machines: q.usage.machines, cpus: q.usage.cpus, memoryMiB: q.usage.memoryMiB } })(),
    queueCount: (state.queue && state.queue[sessionId] && state.queue[sessionId].length) || 0,
  }
}
// ---------- HTTP API(部署插件无 host.call,面板走路由) ----------
function queryOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch (e) {
    return new URLSearchParams()
  }
}
function sendJson(res, status, obj) {
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = status
    res.end(JSON.stringify(obj))
  } catch (e) { /* ignore */ }
}

// ---------- 面板 API 加固(S1):同源校验 + CSRF token 绑定 session ----------
const ALLOWED_SFS = new Set(['same-origin', 'none'])
function sameOriginOk(req) {
  const headers = req.headers || {}
  const sfs = headers['sec-fetch-site']
  if (typeof sfs === 'string' && sfs !== '' && !ALLOWED_SFS.has(sfs)) return false
  const origin = headers.origin
  if (!origin) return true
  try {
    const o = new URL(origin)
    const host = String(headers.host || '').toLowerCase()
    const m = host.match(/^([^:]+)(?::(\d+))?$/)
    if (!m) return false
    const oPort = o.port || (o.protocol === 'https:' ? '443' : '80')
    const hPort = m[2] || (o.protocol === 'https:' ? '443' : '80')
    return o.hostname.toLowerCase() === m[1] && oPort === hPort
  } catch (e) { return false }
}
function checkCsrf(sid, header) {
  const rec = csrfTokens.get(sid)
  if (!rec) return false
  if (rec.exp < Date.now()) { csrfTokens.delete(sid); return false }
  return !!header && String(header) === rec.token
}
function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 1024 * 1024
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) return resolve(req.body === null || req.body === '' ? {} : req.body)
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => { if (req.removeListener) { req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError) } }
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e) }
    const onData = (c) => { size += c.length; if (size > limit) { fail(new Error('请求体过大')) } else { chunks.push(c) } }
    const onEnd = () => { if (settled) return; settled = true; cleanup(); try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(new Error('请求体 JSON 解析失败')) } }
    const onError = (e) => fail(e || new Error('请求中断'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
// 统一闸门:校验方法 / 同源 / CSRF;POST 时解析 JSON body。任一校验失败 sendJson 并返回 null。
async function gate(req, res, opts) {
  const method = (opts && opts.method) || 'GET'
  const needToken = !!(opts && opts.token)
  if (req.method && String(req.method).toUpperCase() !== method) {
    sendJson(res, 405, { ok: false, error: 'method not allowed (expect ' + method + ')' })
    return null
  }
  if (!sameOriginOk(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    return null
  }
  let body = {}
  if (method === 'POST') {
    try { body = await readJsonBody(req) } catch (e) { sendJson(res, 400, { ok: false, error: String((e && e.message) || e) }); return null }
  }
  if (needToken) {
    const sid = String(body && body.session != null ? body.session : (queryOf(req).get('session') || '')).trim()
    if (!checkCsrf(sid, (req.headers || {})['x-vmsb-token'])) {
      sendJson(res, 403, { ok: false, error: '缺少或无效的 CSRF token(请先 GET /vmsb-api/token?session=... 并回传 X-VMSB-Token 头)' })
      return null
    }
  }
  return body
}
// 合并 POST body 与 GET query,保持既有 handler 用 URLSearchParams 读取的方式不变
function pFrom(req, body) {
  const q = queryOf(req)
  const out = new URLSearchParams(q.toString())
  if (body && typeof body === 'object') {
    for (const k of Object.keys(body)) {
      const v = body[k]
      if (v === undefined || v === null) continue
      out.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
  }
  return out
}

// ---------- 模型工具 ----------
const render = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const sessionIdOf = (exec) => (exec && exec.agent ? exec.agent.id : null)
const OUT = { schema: { type: 'object', additionalProperties: true }, render }

function apply(ctx) {
  const tools = ctx.get('tools')
  const webServer = ctx.get('webServer')
  try { console.log('[vmsb] apply: webServer=' + (webServer ? 'yes' : 'NO') + ', tools=' + (tools ? 'yes' : 'NO')) } catch (e) { /* ignore */ }

  // 归档自动清理
  ctx.on('domain/changed', (change) => {
    if (!change || change.domain !== 'workspace' || change.operation !== 'put') return
    const value = change.value
    if (!value || !Array.isArray(value.archivedSessionIds)) return
    const next = new Set(value.archivedSessionIds)
    for (const id of next) {
      if (!knownArchived.has(id)) {
        knownArchived.add(id)
        removeSessionMachines(id).catch((err) => {
          try { console.error('[vmsb] 归档清理失败', err) } catch (e) { /* ignore */ }
        })
      }
    }
    knownArchived = next
  })

  // 会话被删除(dispose)时清理其机器
  ctx.on('session/disposed', (session) => {
    const sid = session && session.id
    if (!sid) return
    handleDisposed(ctx, sid).catch((err) => {
      try { console.error('[vmsb] dispose 清理失败', err) } catch (e) { /* ignore */ }
    })
  })

  // 初始对账 + 闲置扫描(每 5 分钟)
  reconcile(ctx).catch((err) => {
    try { console.error('[vmsb] 初始化对账失败', err) } catch (e) { /* ignore */ }
  })
  processQueuedCreations(ctx).catch((err) => {
    try { console.error('[vmsb] 初始创建队列处理失败', err) } catch (e) { /* ignore */ }
  })
  idleSweep(ctx).catch((err) => {
    try { console.error('[vmsb] 初始闲置检查失败', err) } catch (e) { /* ignore */ }
  })
  ctx.effect(() => {
    const timer = setInterval(() => {
      idleSweep(ctx).catch((err) => {
        try { console.error('[vmsb] 闲置检查失败', err) } catch (e) { /* ignore */ }
      })
    }, IDLE_SWEEP_MS)
    return () => clearInterval(timer)
  }, 'vmsb: idle sweep')
// Cron + 自动快照 + 指标采样
    ctx.effect(() => {
      const timer = setInterval(() => {
        runCronTick(ctx).catch(() => {})
        autoSnapshotTick(ctx).catch(() => {})
      }, CRON_INTERVAL_MS)
      return () => clearInterval(timer)
    }, 'vmsb: cron/snapshot')
    ctx.effect(() => {
      sampleAllMetrics().catch(() => {})
      const timer = setInterval(() => {
        sampleAllMetrics().catch(() => {})
      }, METRICS_INTERVAL_MS)
      return () => clearInterval(timer)
    }, 'vmsb: metrics')
// 状态兜底落盘:周期 flush + 处理创建队列 + 卸载时落盘(配合去抖,保证不丢最后 300ms)
    ctx.effect(() => {
      const timer = setInterval(() => { flushStateNow(); processQueuedCreations(ctx).catch(() => {}) }, 60 * 1000)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return () => { clearInterval(timer); try { flushStateNow() } catch (e) { /* ignore */ } }
    }, 'vmsb: state flush')
// ---------- HTTP 路由 ----------
  if (webServer) {
    const route = (path, handler) => {
      ctx.effect(() => {
        try {
          const disposer = webServer.register({ kind: 'exact', path, handler })
          try { console.log('[vmsb] route registered: ' + path) } catch (e) { /* ignore */ }
          return disposer
        } catch (err) {
          try { console.error('[vmsb] route FAILED: ' + path + ' -> ' + String((err && err.message) || err)) } catch (e) { /* ignore */ }
        }
      }, 'vmsb: ' + path)
    }

    // 面板 CSRF token 下发(只读 GET;跨源页面无法读取响应体 -> token 只对本会话可见)
    route('/vmsb-api/token', async (req, res) => {
      try {
        const q = queryOf(req)
        const sid = q.get('session') || ''
        const now = Date.now()
        for (const [k, v] of csrfTokens) { if (v.exp < now) csrfTokens.delete(k) }
        const token = genId('csrf')
        if (sid) csrfTokens.set(sid, { token, exp: now + CSRF_TTL_MS })
        sendJson(res, 200, { ok: true, session: sid, token: sid ? token : '' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/list', async (req, res) => {
      try {
        const sid = queryOf(req).get('session') || ''
        sendJson(res, 200, await listView(ctx, sid))
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/info', async (req, res) => {
      try {
        const q = queryOf(req)
        const name = q.get('name') || ''
        if (!name) throw new Error('缺少机器名称')
        sendJson(res, 200, await machineDetail(ctx, name, q.get('session') || ''))
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/shell', async (req, res) => {
      try {
        const q = queryOf(req)
        const name = q.get('name') || ''
        if (!name) throw new Error('缺少机器名称')
        sendJson(res, 200, shellLogView(name))
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/create', async (req, res) => {
      try {
        const body = await gate(req, res, { method: 'POST', token: true })
        if (body === null) return
        const q = pFrom(req, body)
        const sessionId = q.get('session') || ''
        if (!sessionId) throw new Error('缺少会话标识')
        const distro = q.get('distro') === 'alpine' ? 'alpine' : 'debian'
        const hint = sanitizeName(q.get('machine') || '')
        if (hint && ownerOfMachine(hint) && !canExec(sessionId, hint)) {
          sendJson(res, 403, { ok: false, error: '该机器属于其他会话且未共享，不能使用' })
          return
        }
        if (hint && ownerOfMachine(hint)) {
          const m = await machineStateOf(hint)
          sendJson(res, 200, { ok: true, machine: hint, distro, state: m ? m.state : 'unknown', existing: true })
          return
        }
        const title = await sessionTitleOf(ctx, sessionId)
        const name = await uniqueMachineName(title, sessionId, hint)
        const policy = sessionPolicy(sessionId)
        if (sessionMachines(sessionId).length >= policy.maxMachines) {
          sendJson(res, 400, { ok: false, error: '本会话虚拟机已达上限(' + policy.maxMachines + ' 台),请先删除不再使用的机器' })
          return
        }
        const cpus = q.get('cpus') || '2'
        const memory = q.get('memory') || '2G'
        const disk = q.get('disk') || '16G'
        const harden = q.get('harden') !== '0' && q.get('harden') !== 'false'
        const options = { cpus, memory, disk, harden, isolated: q.get('isolated') === '1' || q.get('isolated') === 'true', isolateNetwork: q.get('isolate_network') === '1' || q.get('isolate_network') === 'true' }
        const template = q.get('template') || ''
        if (template) {
          try {
            const tpl = await resolveTemplate(ctx, template)
            if (tpl && tpl.init_script && !options.initScript) options.initScript = tpl.init_script
            if (tpl && tpl.cloud_init && !options.cloudInit) options.cloudInit = tpl.cloud_init
            if (tpl && tpl.cpus) options.cpus = String(tpl.cpus) || options.cpus
            if (tpl && tpl.memory) options.memory = String(tpl.memory) || options.memory
          } catch (e) {
            sendJson(res, 400, { ok: false, error: '模板解析失败: ' + String((e && e.message) || e).slice(0, 200) })
            return
          }
        }
        createMachineWithName(ctx, sessionId, name, distro, null, options).catch((err) => {
          try { console.error('[vmsb] 面板创建机器失败', name, err) } catch (e) { /* ignore */ }
        })
        sendJson(res, 200, { ok: true, status: 'creating', machine: name, distro, template: template || null })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/start', async (req, res) => {
      try {
        const body = await gate(req, res, { method: 'POST', token: true })
        if (body === null) return
        const q = pFrom(req, body)
        const name = q.get('name') || ''
        const sessionId = q.get('session') || ''
        if (!name) throw new Error('缺少机器名称')
        if (!canManage(sessionId, name)) throw new Error('没有权限启动该机器')
        const result = await orb(['start', name], { timeoutMs: 300000 })
        if (result.exitCode !== 0) throw new Error('orb start 失败: ' + String(result.stderr || result.stdout || '').slice(0, 300))
        await enforceRunningCap(name)
        const owner = ownerOfMachine(name)
        if (owner) touchMachine(owner, name)
        await ensureNetworkApplied(name)
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/restart', async (req, res) => {
      try {
        const body = await gate(req, res, { method: 'POST', token: true })
        if (body === null) return
        const q = pFrom(req, body)
        const name = q.get('name') || ''
        const sessionId = q.get('session') || ''
        if (!name) throw new Error('缺少机器名称')
        if (!canManage(sessionId, name)) throw new Error('没有权限重启该机器')
        const result = await orb(['restart', name], { timeoutMs: 300000 })
        if (result.exitCode !== 0) throw new Error('orb restart 失败: ' + String(result.stderr || result.stdout || '').slice(0, 300))
        await ensureNetworkApplied(name)
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/sleep', async (req, res) => {
      try {
        const body = await gate(req, res, { method: 'POST', token: true })
        if (body === null) return
        const q = pFrom(req, body)
        const name = q.get('name') || ''
        const sessionId = q.get('session') || ''
        if (!name) throw new Error('缺少机器名称')
        if (!canManage(sessionId, name)) throw new Error('没有权限休眠该机器')
        const result = await orb(['stop', name], { timeoutMs: 300000 })
        if (result.exitCode !== 0) throw new Error('orb stop 失败: ' + String(result.stderr || result.stdout || '').slice(0, 300))
        stopMachineTunnels(name)
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/delete', async (req, res) => {
      try {
        const body = await gate(req, res, { method: 'POST', token: true })
        if (body === null) return
        const q = pFrom(req, body)
        const name = q.get('name') || ''
        const sessionId = q.get('session') || ''
        if (!name) throw new Error('缺少机器名称')
        const found = recordOfMachine(name)
        if (found && found.type === 'snapshot') throw new Error('快照请使用 vm_snapshot_delete 删除')
        if (!canOwner(sessionId, name)) throw new Error('该机器属于其他会话或未获得删除权限，不能删除')
        await removeMachineByName(name)
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/audit', async (req, res) => {
      try {
        const q = queryOf(req)
        const sessionId = q.get('session') || undefined
        const machine = q.get('machine') || undefined
        const operation = q.get('operation') || undefined
        const list = await auditView(ctx, { sessionId, machine, operation }, q.get('limit') || 100)
        sendJson(res, 200, { ok: true, entries: list })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/jobs', async (req, res) => {
      try {
        const q = queryOf(req)
        const sessionId = q.get('session') || ''
        const jobs = state.jobs.slice().reverse().filter((j) => !sessionId || j.sessionId === sessionId)
        const out = []
        for (const j of jobs.slice(0, Number(q.get('limit')) || 200)) {
          const s = await readJobStatus(j).catch(() => ({ status: j.status }))
          out.push({ ...j, ...s })
        }
        sendJson(res, 200, { ok: true, jobs: out })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/tunnels', async (req, res) => {
      try {
        sendJson(res, 200, { ok: true, tunnels: tunnelView() })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })
route('/vmsb-api/snapshots', async (req, res) => {
        try {
          const q = queryOf(req)
          const sessionId = q.get('session') || ''
          const list = listSnapshots().filter((s) => !sessionId || s.sessionId === sessionId)
          sendJson(res, 200, { ok: true, snapshots: list })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/snapshot', async (req, res) => {
        try {
          const body = await gate(req, res, { method: 'POST', token: true })
          if (body === null) return
          const q = pFrom(req, body)
          const sessionId = q.get('session') || ''
          const action = q.get('action') || ''
          const machine = q.get('machine') || ''
          const snapshot = q.get('snapshot') || ''
          if (action === 'create') {
            if (!sessionId) throw new Error('缺少会话标识')
            sendJson(res, 200, await createSnapshot(ctx, sessionId, machine || (await resolveDefaultMachine(ctx, sessionId)).name, q.get('note') || ''))
          } else if (action === 'restore') {
            sendJson(res, 200, await restoreSnapshot(ctx, sessionId, snapshot))
          } else if (action === 'delete') {
            sendJson(res, 200, await deleteSnapshot(ctx, sessionId, snapshot))
          } else {
            sendJson(res, 200, { ok: true, snapshots: listSnapshots() })
          }
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/metrics', async (req, res) => {
        try {
          const q = queryOf(req)
          const machine = q.get('machine') || ''
          if (!machine) throw new Error('缺少机器名称')
          sendJson(res, 200, metricsView(machine, q.get('limit') || 120))
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/alerts', async (req, res) => {
        try {
          const q = queryOf(req)
          const sessionId = q.get('session') || ''
          const rules = (state.alerts || []).filter((r) => !sessionId || r.sessionId === sessionId).map((r) => ({ ...r }))
          sendJson(res, 200, { ok: true, sessionId, rules, recentFires: recentFires.map((f) => ({ ...f })) })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/cron', async (req, res) => {
        try {
          const q = queryOf(req)
          const sessionId = q.get('session') || ''
          const list = (state.cron || []).filter((c) => !sessionId || c.sessionId === sessionId)
          sendJson(res, 200, { ok: true, jobs: list })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/templates', async (req, res) => {
        try {
          sendJson(res, 200, { ok: true, templates: templateList() })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/services', async (req, res) => {
        try {
          const q = queryOf(req)
          const sessionId = q.get('session') || ''
          sendJson(res, 200, await discoverServices(ctx, sessionId, q.get('machine') || ''))
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/policy', async (req, res) => {
        try {
          const q = queryOf(req)
          const sessionId = q.get('session') || ''
          sendJson(res, 200, { ok: true, sessionId, policy: sessionPolicy(sessionId) })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
route('/vmsb-api/network', async (req, res) => {
        try {
          const isPost = !!(req.method && String(req.method).toUpperCase() === 'POST')
          const body = isPost ? await gate(req, res, { method: 'POST', token: true }) : await gate(req, res, { method: 'GET' })
          if (body === null) return
          const q = pFrom(req, isPost ? body : {})
          const sessionId = q.get('session') || ''
          const machine = q.get('machine') || ''
          const hasSet = q.get('public_access') !== null || q.get('internal_access') !== null || q.get('isolated') !== null || q.get('isolate_network') !== null || q.get('allowlist') !== null
          if (!machine) throw new Error('缺少机器名称')
          if (hasSet) {
            if (!isPost) { sendJson(res, 405, { ok: false, error: '网络策略修改需要 POST' }); return }
            const parseB = (v) => v === null ? undefined : (v === '1' || v === 'true')
            const allow = q.get('allowlist') ? q.get('allowlist').split(',').map((x) => x.trim()).filter(Boolean) : undefined
            sendJson(res, 200, await setNetworkPolicy(ctx, sessionId, machine, parseB(q.get('public_access')), parseB(q.get('internal_access')), parseB(q.get('isolated')), parseB(q.get('isolate_network')), allow))
          } else {
            sendJson(res, 200, await networkStatusOf(ctx, sessionId, machine))
          }
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/share', async (req, res) => {
        try {
          const isPost = !!(req.method && String(req.method).toUpperCase() === 'POST')
          const body = isPost ? await gate(req, res, { method: 'POST', token: true }) : await gate(req, res, { method: 'GET' })
          if (body === null) return
          const q = pFrom(req, isPost ? body : {})
          const sessionId = q.get('session') || ''
          const machine = q.get('machine') || ''
          const target = q.get('session_target') || ''
          const mode = q.get('mode') || 'exec'
          const action = q.get('action') || 'list'
          if (!machine) throw new Error('缺少机器名称')
          if (action === 'add') {
            if (!isPost) { sendJson(res, 405, { ok: false, error: '共享添加需要 POST' }); return }
            if (!sessionId || !target) throw new Error('缺少 session/session_target')
            if (!canOwner(sessionId, machine)) throw new Error('只有归属会话可以共享')
            const grants = state.shares[machine] = state.shares[machine] || []
            const idx = grants.findIndex((g) => g.sessionId === target)
            if (idx >= 0) grants[idx] = { sessionId: target, mode, sharedAt: Date.now() }
            else grants.push({ sessionId: target, mode, sharedAt: Date.now() })
            saveState()
          } else if (action === 'remove') {
            if (!isPost) { sendJson(res, 405, { ok: false, error: '共享移除需要 POST' }); return }
            if (!target) throw new Error('缺少 session_target')
            const grants = state.shares[machine] = (state.shares[machine] || []).filter((g) => g.sessionId !== target)
            if (grants.length === 0) delete state.shares[machine]
            saveState()
          }
          sendJson(res, 200, { ok: true, machine, sharedWith: state.shares[machine] || [] })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
      route('/vmsb-api/job', async (req, res) => {
        try {
          const isPost = !!(req.method && String(req.method).toUpperCase() === 'POST')
          const body = isPost ? await gate(req, res, { method: 'POST', token: true }) : await gate(req, res, { method: 'GET' })
          if (body === null) return
          const q = pFrom(req, isPost ? body : {})
          const sessionId = q.get('session') || ''
          const id = q.get('id') || ''
          const action = q.get('action') || 'list'
          if (id && action === 'stop') {
            if (!isPost) { sendJson(res, 405, { ok: false, error: '停止任务需要 POST' }); return }
            sendJson(res, 200, await stopJob(ctx, sessionId, id))
          } else if (id && action === 'rotate') {
            if (!isPost) { sendJson(res, 405, { ok: false, error: '日志轮转需要 POST' }); return }
            const job = jobById(id)
            if (!job) throw new Error('未找到后台任务')
            sendJson(res, 200, await jobLogRotate(id))
          } else if (id && action === 'output') {
            sendJson(res, 200, await jobFullOutput(id, q.get('max_bytes')))
          } else {
            const list = (state.jobs || []).filter((j) => !sessionId || j.sessionId === sessionId).reverse().slice(0, Number(q.get('limit')) || 200)
            sendJson(res, 200, { ok: true, jobs: list })
          }
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
        }
      })
  }
// ---------- 模型工具 ----------
  if (tools) {
    const registerTool = (tool) => {
      ctx.effect(() => {
        try {
          const disposer = tools.register(tool)
          try { console.log('[vmsb] tool registered: ' + tool.name) } catch (e) { /* ignore */ }
          return disposer
        } catch (err) {
          try { console.error('[vmsb] tool FAILED: ' + tool.name + ' -> ' + String((err && err.message) || err)) } catch (e) { /* ignore */ }
        }
      }, 'vmsb: tool ' + tool.name)
    }

    registerTool({
      name: 'vm_list',
      description: '列出 OrbStack 中的全部沙箱虚拟机与快照:名称、状态(running/sleeping/stopped)、系统(debian/alpine)、归属会话、共享权限、快照来源。返回 machines(全部机器,含归属)、own(本会话的机器数组)、snapshots(快照)、sessions(已知会话)、cap 等配额信息。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        return listView(ctx, sessionIdOf(exec))
      },
    })

    registerTool({
      name: 'vm_create',
      description: '为当前会话创建一台新的沙箱虚拟机(OrbStack;默认 CPU 2 核 / 内存 2G / 磁盘 16G)。仅支持 debian(默认)与 alpine。支持自定义 cpus/memory/disk、初始化脚本 init_script 或 cloud_init、网络隔离 isolated/isolate_network。可用 machine 指定名称(小写字母/数字<=8);若名称已存在且有权限则返回现有机器。每会话上限 8 台,全局运行上限 25 台。创建耗时约 1-3 分钟。',
      parameters: {
        type: 'object',
        properties: {
          distro: { type: 'string', description: '发行版:debian(默认)或 alpine。', enum: ['debian', 'alpine'] },
          machine: { type: 'string', description: '可选:机器名称提示(仅小写字母/数字,<=8 位)。若该名称已存在(含其他会话的机器)且有权限则返回现有机器。' },
          cpus: { type: 'string', description: '可选:CPU 核数,例如 2、4;默认 2。' },
          memory: { type: 'string', description: '可选:内存大小,支持 MiB/GiB 等 OrbStack 官方单位,例如 2G、4096MiB;默认 2G。' },
          disk: { type: 'string', description: '可选:磁盘上限,支持 GiB/单位,例如 16G、64G;默认 16G。' },
          init_script: { type: 'string', description: '可选:Shell 初始化脚本(会包装成 cloud-init runcmd,在首次启动时自动执行)。' },
          cloud_init: { type: 'string', description: '可选:完整 cloud-config 用户数据文本(以 #cloud-config 开头),优先于 init_script。' },
          template: { type: 'string', description: '可选:模板名(python/node/docker/cuda)、本地 JSON/YAML 路径或 GitHub raw URL。内置模板见 vm_template。' },
          isolated: { type: 'boolean', description: '可选:创建隔离机器(关闭文件共享/集成),使用 OrbStack 官方 --isolated。' },
          isolate_network: { type: 'boolean', description: '可选:启用网络隔离(自动附带 --isolated),使用 OrbStack 官方 --isolate-network。' },
          harden: { type: 'boolean', description: '可选:创建后应用安全基线(禁 SSH 密码登录/root 仅密钥等),默认 true;false 关闭。' },
          queue: { type: 'boolean', description: '可选:超过本会话配额(台数/累计 CPU/内存)时才排队等待(返回 queued,完成后 VM 自动出现);默认 false 直接报错。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        const distro = args && args.distro === 'alpine' ? 'alpine' : 'debian'
        const hint = sanitizeName(args && args.machine)
        const template = args && args.template
        const options = {
          cpus: args && args.cpus,
          memory: args && args.memory,
          disk: args && args.disk,
          initScript: args && args.init_script,
          cloudInit: args && args.cloud_init,
          isolated: !!(args && args.isolated),
          isolateNetwork: !!(args && args.isolate_network),
          harden: args && args.harden === false ? false : true,
          queue: !!(args && args.queue),
          templateName: template || null,
        }
        if (template) {
          const tpl = await resolveTemplate(ctx, template)
          if (tpl && tpl.distro && !(args && args.distro)) options.distro = tpl.distro
          if (tpl && tpl.init_script && !options.initScript && !options.cloudInit) options.initScript = tpl.init_script
          if (tpl && tpl.cloud_init && !options.cloudInit && !options.initScript) options.cloudInit = tpl.cloud_init
        }
        const templateDistro = options.distro || distro
        try {
          if (hint && ownerOfMachine(hint)) {
            const owner = ownerOfMachine(hint)
            if (!canExec(sessionId, hint)) throw new Error('该机器属于其他会话且未共享，不能使用')
            touchMachine(owner, hint)
            const m = await machineStateOf(hint)
            return { machine: hint, distro, state: m ? m.state : 'unknown', existing: true, ownerSession: owner, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
          }
          // D4: 配额检查(台数 + 累计 CPU/内存);支持排队
          const reqCpus = Number(options.cpus) || 2
          const reqMemMiB = sizeToMiB(options.memory) || 2048
          const qs = quotaState(sessionId, reqCpus, reqMemMiB)
          if (!qs.fits) {
            if (!options.queue) {
              const bits = []
              if (!qs.countOk) bits.push('台数已满(' + qs.policy.maxMachines + ')')
              if (!qs.cpuOk) bits.push('累计 CPU ' + qs.usage.cpus + '/' + qs.policy.cpuQuota)
              if (!qs.memOk) bits.push('累计内存 ' + Math.round(qs.usage.memoryMiB / 1024) + '/' + (qs.policy.memoryQuotaMiB / 1024) + ' GB')
              throw new Error('超出本会话配额: ' + bits.join('; ') + '(可调整 vm_policy 或使用 queue:true 排队)')
            }
            state.queue = state.queue || {}
            state.queue[sessionId] = state.queue[sessionId] || []
            const qi = { id: genId('q'), sessionId, req: { distro: templateDistro || distro, hint: hint || null, cpus: options.cpus, memory: options.memory, disk: options.disk, initScript: options.initScript, cloudInit: options.cloudInit, isolated: options.isolated, isolateNetwork: options.isolateNetwork, harden: options.harden, templateName: options.templateName }, createdAt: Date.now(), status: 'queued' }
            state.queue[sessionId].push(qi)
            saveState()
            pushAudit(sessionId, null, 'vm_create_queued', { id: qi.id }, true, null)
            return { ok: true, queued: true, queueId: qi.id, position: state.queue[sessionId].length, machine: null, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
          }
          const rec = await createMachineForSession(ctx, sessionId, templateDistro || distro, exec.signal, hint, options)
          pushAudit(sessionId, rec.name, 'vm_create', { distro, cpus: options.cpus, memory: options.memory, disk: options.disk, init: !!options.initScript, cloudInit: !!options.cloudInit }, true, null, Date.now() - t0)
          return { machine: rec.name, distro: rec.distro, state: rec.state, existing: false, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
        } catch (err) {
          pushAudit(sessionId, hint || null, 'vm_create', { distro, cpus: options.cpus, memory: options.memory, disk: options.disk }, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })
registerTool({
      name: 'vm_exec',
      description: '在沙箱虚拟机中执行 shell 命令(以 root 身份,sh -lc)。省略 machine 时使用当前会话默认虚拟机;若没有机器则自动创建一台。传 machine 指定单个机器,或传 machines 数组并行执行同一命令(多机一致性/集群实验)。需要目标机器归属当前会话或已被 vm_share 共享(exec/manage 权限)。返回 stdout/stderr/exitCode;多机模式返回 results 数组。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在虚拟机内执行的 shell 命令。' },
          machine: { type: 'string', description: '可选:目标机器名称(仅小写字母/数字,<=8 位)。' },
          machines: { type: 'array', items: { type: 'string' }, description: '可选:多台机器名称,并行执行同一命令。' },
          groups: { type: 'object', description: '可选:按角色/分组顺序执行,如 {"web":["vmA"],"db":["vmB"]}。组内并行,组间按顺序。' },
          strategy: { type: 'string', enum: ['continue', 'fail-fast'], description: '可选:多机执行策略,默认 continue;fail-fast 遇到失败立即跳过后续组。' },
          distro: { type: 'string', description: '仅当需要新建机器时使用的发行版:debian(默认)或 alpine;目标机器已存在时忽略。', enum: ['debian', 'alpine'] },
          timeout_ms: { type: 'integer', description: '超时毫秒数,默认 600000(10 分钟)。' },
        },
        required: ['command'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const command = String((args && args.command) || '')
        if (!command.trim()) throw new Error('command 不能为空')
        const distro = args && args.distro === 'alpine' ? 'alpine' : 'debian'
        const timeoutMs = Number(args && args.timeout_ms) > 0 ? Number(args.timeout_ms) : 600000
        const machineName = sanitizeName(args && args.machine)
        const machineList = Array.isArray(args && args.machines) ? args.machines.map((m) => sanitizeName(m)).filter(Boolean) : []
        const names = machineName || machineList.length > 0 ? (machineName ? [machineName] : machineList) : null
        const targets = []
        if (names) {
          for (const n of Array.from(new Set(names))) {
            const owner = ownerOfMachine(n)
            if (owner && !canExec(sessionId, n)) throw new Error('没有权限执行: ' + n + '(请先 vm_share)')
            targets.push(owner
              ? await resolveExistingMachineByName(ctx, sessionId, n)
              : await resolveMachineByName(ctx, sessionId, n, distro, exec.signal))
          }
        } else {
          targets.push(await ensureSessionMachine(ctx, sessionId, distro, exec.signal))
        }
        await Promise.all(targets.map((t) => ensureRunning(t.name)))
        await Promise.all(targets.map((t) => enforceRunningCap(t.name)))

        const execOne = async (target) => {
          const entry = {
            id: 'shell-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            machine: target.name,
            command,
            startTime: Date.now(),
            endTime: null,
            durationMs: null,
            exitCode: null,
            stdout: '',
            stderr: '',
            status: 'running',
          }
          pushShellLog(target.name, entry)
          let run
          try {
            run = await orb(['run', '-m', target.name, '-u', 'root', 'sh', '-lc', command], { timeoutMs, signal: exec.signal })
          } finally {
            entry.endTime = Date.now()
            entry.durationMs = entry.endTime - entry.startTime
            entry.exitCode = run ? run.exitCode : -1
            entry.stdout = run ? run.stdout : ''
            entry.stderr = run ? run.stderr : ''
            entry.status = run && run.exitCode === 0 ? 'ok' : 'bad'
          }
          return {
            machine: target.name,
            distro: target.distro,
            ownerSession: target.sessionId || null,
            crossSession: target.crossSession === true,
            exitCode: run.exitCode,
            stdout: run.stdout,
            stderr: run.stderr,
          }
        }
        const t0 = Date.now()
        const strategy = (args && args.strategy) || 'continue'
        const groups = args && args.groups && typeof args.groups === 'object' ? args.groups : null
        const allOutput = []
        let failed = false

        const runGroup = async (groupTargets) => {
          const settled = await Promise.allSettled(groupTargets.map((t) => execOne(t)))
          return settled.map((r) => r.status === 'fulfilled' ? r.value : { machine: r.reason && r.reason.machine ? r.reason.machine : null, error: String((r.reason && r.reason.message) || r.reason) })
        }

        if (groups) {
          for (const [role, machineNames] of Object.entries(groups)) {
            const groupTargets = []
            for (const n of Array.from(new Set(Array.isArray(machineNames) ? machineNames : [machineNames])).map(sanitizeName)) {
              const owner = ownerOfMachine(n)
              if (owner && !canExec(sessionId, n)) throw new Error('没有权限执行: ' + n + '(请先 vm_share)')
              groupTargets.push(owner ? await resolveExistingMachineByName(ctx, sessionId, n) : await resolveMachineByName(ctx, sessionId, n, distro, exec.signal))
            }
            await Promise.all(groupTargets.map((t) => ensureRunning(t.name)))
            const out = await runGroup(groupTargets)
            for (const row of out) row.role = role
            allOutput.push(...out)
            if (strategy === 'fail-fast' && out.some((o) => o.exitCode !== 0 || o.error)) {
              failed = true
              break
            }
          }
        } else {
          const results = await Promise.allSettled(targets.map((t) => execOne(t)))
          const output = results.map((r) => r.status === 'fulfilled' ? r.value : { machine: r.reason && r.reason.machine ? r.reason.machine : null, error: String((r.reason && r.reason.message) || r.reason) })
          allOutput.push(...output)
        }

        pushAudit(sessionId, names ? names.join(',') : (targets[0] && targets[0].name) || null, 'vm_exec', { command: command.slice(0, 200), multi: (names && names.length > 1) || !!groups, strategy }, allOutput.every((o) => o.exitCode === 0), null, Date.now() - t0)
        if (names && names.length > 1 || groups) {
          const okCount = allOutput.filter((o) => o.exitCode === 0).length
          return { ok: true, parallel: true, summary: okCount + '/' + allOutput.length + ' 台成功' + (failed ? '（fail-fast 中止）' : ''), strategy, results: allOutput }
        }
        return allOutput[0]
      },
    })

    registerTool({
      name: 'vm_delete',
      description: '删除虚拟机(永久删除,数据不保留)。省略 machine 时删除当前会话最近的默认机器;传入 machine 名称可删除本会话指定的机器(其他会话的机器即使共享也不能删除)。归档或删除会话的虚拟机由系统自动清理。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:要删除的机器名称(仅小写字母/数字,<=8 位)。省略时删除当前会话最近的默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const name = sanitizeName(args && args.machine)
        const t0 = Date.now()
        try {
          if (name) {
            const found = recordOfMachine(name)
            if (found && found.type === 'snapshot') throw new Error('快照请使用 vm_snapshot_delete 删除')
            if (!canOwner(sessionId, name)) throw new Error('该机器属于其他会话，不能删除')
            const removed = await removeMachineByName(name)
            pushAudit(sessionId, name, 'vm_delete', {}, removed, removed ? null : '删除失败', Date.now() - t0)
            return { ok: removed, machine: name, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
          }
          const def = defaultSessionMachine(sessionId)
          if (!def) return { ok: false, machine: null, reason: '本会话没有虚拟机' }
          const removed = await removeMachineByName(def.name)
          pushAudit(sessionId, def.name, 'vm_delete', {}, removed, removed ? null : '删除失败', Date.now() - t0)
          return { ok: removed, machine: def.name, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
        } catch (err) {
          pushAudit(sessionId, name, 'vm_delete', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_status',
      description: '查询虚拟机状态详情:IP、状态、发行版、CPU/内存/磁盘限额与实时用量、uptime、最近 Shell 记录、归属、权限、快照来源。省略 machine 时使用当前会话默认机器。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:目标机器名称。省略时使用当前会话默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        if (hint && !canExec(sessionId, hint)) throw new Error('没有权限查看该机器状态')
        const detail = hint ? await machineDetail(ctx, hint, sessionId) : await (async () => {
          const def = await resolveDefaultMachine(ctx, sessionId)
          return machineDetail(ctx, def.name, sessionId)
        })()
        const jobs = state.jobs.filter((j) => j.machine === detail.name).reverse().slice(0, 20)
        return { ok: true, ...detail, jobs, tunnels: tunnelView().filter((t) => t.machine === detail.name) }
      },
    })

    registerTool({
      name: 'vm_start',
      description: '启动/唤醒一台沙箱虚拟机。省略 machine 时使用当前会话默认机器;需要 owner 或 manage 共享权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:目标机器名称。省略时使用当前会话默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canManage(sessionId, target.name)) throw new Error('没有权限启动该机器(' + target.name + ')')
        const t0 = Date.now()
        const res = await orb(['start', target.name], { timeoutMs: 300000 })
        if (res.exitCode !== 0) throw new Error('orb start 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
        const owner = ownerOfMachine(target.name)
        if (owner) touchMachine(owner, target.name)
        await enforceRunningCap(target.name)
        await ensureNetworkApplied(target.name)
        pushAudit(sessionId, target.name, 'vm_start', {}, true, null, Date.now() - t0)
        return { ok: true, machine: target.name, state: 'running' }
      },
    })

    registerTool({
      name: 'vm_stop',
      description: '休眠/停止一台沙箱虚拟机(不影响数据)。省略 machine 时使用当前会话默认机器;需要 owner 或 manage 共享权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:目标机器名称。省略时使用当前会话默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canManage(sessionId, target.name)) throw new Error('没有权限停止该机器(' + target.name + ')')
        const t0 = Date.now()
        const res = await orb(['stop', target.name], { timeoutMs: 300000 })
        if (res.exitCode !== 0) throw new Error('orb stop 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
        stopMachineTunnels(target.name)
        pushAudit(sessionId, target.name, 'vm_stop', {}, true, null, Date.now() - t0)
        return { ok: true, machine: target.name, state: 'stopped' }
      },
    })

    registerTool({
      name: 'vm_restart',
      description: '重启一台沙箱虚拟机。省略 machine 时使用当前会话默认机器;需要 owner 或 manage 共享权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:目标机器名称。省略时使用当前会话默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canManage(sessionId, target.name)) throw new Error('没有权限重启该机器(' + target.name + ')')
        const t0 = Date.now()
        const res = await orb(['restart', target.name], { timeoutMs: 300000 })
        if (res.exitCode !== 0) throw new Error('orb restart 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
        stopMachineTunnels(target.name)
        await ensureNetworkApplied(target.name)
        pushAudit(sessionId, target.name, 'vm_restart', {}, true, null, Date.now() - t0)
        return { ok: true, machine: target.name, state: 'running' }
      },
    })
registerTool({
      name: 'vm_snapshot',
      description: '为虚拟机创建快照(基于 OrbStack 官方 orb clone,按需复制,不双倍占用磁盘)。创建后可随时 vm_restore 回滚;需要 owner 或 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器名称。省略时使用当前会话默认机器。' },
          note: { type: 'string', description: '可选快照备注。' },
        },
        required: ['machine'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const machine = sanitizeName(args && args.machine) || (await resolveDefaultMachine(ctx, sessionId)).name
        const t0 = Date.now()
        try {
          const out = await createSnapshot(ctx, sessionId, machine, args && args.note)
          pushAudit(sessionId, machine, 'vm_snapshot', { note: args && args.note }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, machine, 'vm_snapshot', { note: args && args.note }, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_snapshot_list',
      description: '列出当前会话全部虚拟机快照(含来源机器、创建时间、备注)。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const all = listSnapshots()
        return { ok: true, snapshots: all, own: all.filter((s) => s.sessionId === sessionId) }
      },
    })

    registerTool({
      name: 'vm_restore',
      description: '从快照恢复虚拟机:删除当前机器并从快照克隆回原机器名(快照本身保留)。需要 owner 或 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          snapshot: { type: 'string', description: '快照名称(见 vm_list 或 vm_snapshot_list)。' },
        },
        required: ['snapshot'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const snapName = String(args && args.snapshot || '').trim()
        const t0 = Date.now()
        try {
          const out = await restoreSnapshot(ctx, sessionId, snapName)
          pushAudit(sessionId, out.machine, 'vm_restore', { snapshot: snapName }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, snapName, 'vm_restore', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_snapshot_delete',
      description: '删除一个虚拟机快照(永久删除,不可恢复)。只有快照归属会话可删除。',
      parameters: {
        type: 'object',
        properties: {
          snapshot: { type: 'string', description: '要删除的快照名称。' },
        },
        required: ['snapshot'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const snapName = String(args && args.snapshot || '').trim()
        const t0 = Date.now()
        try {
          const out = await deleteSnapshot(ctx, sessionId, snapName)
          pushAudit(sessionId, snapName, 'vm_snapshot_delete', {}, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, snapName, 'vm_snapshot_delete', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_upload',
      description: '上传文件/目录到虚拟机(OrbStack 官方 orb push)。local_path 为 macOS/工作区相对路径,remote_path 为 Linux 内路径(相对默认用户 home 或绝对路径)。目标机器需归属当前会话或被共享 exec/manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          local_path: { type: 'string', description: '本地文件/目录路径(相对工作区或绝对路径,需在工作区内)。' },
          remote_path: { type: 'string', description: '虚拟机内目标路径。' },
          machine: { type: 'string', description: '可选目标机器名称;省略使用当前会话默认机器。' },
        },
        required: ['local_path', 'remote_path'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const out = await uploadToMachine(ctx, sessionId, sanitizeName(args && args.machine), args && args.local_path, args && args.remote_path)
          pushAudit(sessionId, out.machine, 'vm_upload', { localPath: out.localPath, remotePath: out.remotePath }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_upload', { localPath: args && args.local_path, remotePath: args && args.remote_path }, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_download',
      description: '从虚拟机下载文件/目录到本地(OrbStack 官方 orb pull)。remote_path 为 Linux 内路径,local_path 为工作区相对/绝对路径。目标机器需归属当前会话或被共享 exec/manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          remote_path: { type: 'string', description: '虚拟机内源路径。' },
          local_path: { type: 'string', description: '本地目标路径(目录需已存在或写入新目录)。' },
          machine: { type: 'string', description: '可选目标机器名称;省略使用当前会话默认机器。' },
        },
        required: ['remote_path', 'local_path'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const out = await downloadFromMachine(ctx, sessionId, sanitizeName(args && args.machine), args && args.remote_path, args && args.local_path)
          pushAudit(sessionId, out.machine, 'vm_download', { localPath: out.localPath, remotePath: out.remotePath }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_download', { localPath: args && args.local_path, remotePath: args && args.remote_path }, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_port_forward',
      description: '把虚拟机内端口映射到本地回环地址(ssh -N -L MACHINE@orb,OrbStack 官方 SSH)。默认自动选择空闲本地端口;可指定 host_port。需要 exec 或 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
          vm_port: { type: 'integer', description: '虚拟机内要暴露的端口(1-65535)。' },
          host_port: { type: 'integer', description: '可选本地端口;缺省自动分配空闲端口。' },
          bind_host: { type: 'string', description: '可选本地绑定地址,默认 127.0.0.1;仅支持 localhost/127.0.0.1/::1。' },
        },
        required: ['machine', 'vm_port'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        const machine = sanitizeName(args && args.machine)
        try {
          const out = await startPortForward(ctx, sessionId, machine, args && args.vm_port, args && args.host_port, args && args.bind_host)
          pushAudit(sessionId, out.tunnel.machine, 'vm_port_forward', { vmPort: out.tunnel.vmPort, hostPort: out.tunnel.hostPort }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, machine || null, 'vm_port_forward', { vmPort: args && args.vm_port }, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_port_forward_list',
      description: '列出当前所有端口转发(含 machine、vm_port、host_port、pid、状态)。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        return { ok: true, tunnels: tunnelView() }
      },
    })

    registerTool({
      name: 'vm_port_forward_stop',
      description: '停止一个端口转发。可传 tunnel_id 或 host_port 停止对应转发。',
      parameters: {
        type: 'object',
        properties: {
          tunnel_id: { type: 'string', description: '转发 ID。' },
          host_port: { type: 'integer', description: '或按本地端口停止。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const idOrPort = args && args.tunnel_id || args && args.host_port
        if (!idOrPort) throw new Error('需要 tunnel_id 或 host_port')
        const out = stopTunnelById(String(idOrPort))
        return { ok: true, ...out }
      },
    })
registerTool({
      name: 'vm_job_submit',
      description: '提交一个后台长任务到虚拟机内执行(避免依赖单次 vm_exec 超时)。任务在 VM 内以后台进程运行,返回 job id/pid;用 vm_job_list / vm_job_status / vm_job_stop 管理。需要 exec 或 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在虚拟机内以后台方式运行的 shell 命令。' },
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
        },
        required: ['command'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const command = String((args && args.command) || '')
        if (!command.trim()) throw new Error('command 不能为空')
        const t0 = Date.now()
        try {
          const out = await submitJob(ctx, sessionId, sanitizeName(args && args.machine), command)
          pushAudit(sessionId, out.job.machine, 'vm_job_submit', { jobId: out.job.id }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_job_submit', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_job_list',
      description: '列出后台任务(当前会话或全部),包含状态、PID、命令、运行时长、最近日志尾部。可选 machine/session/limit 过滤。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选按机器过滤。' },
          limit: { type: 'integer', description: '可选返回条数,默认 100。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const machine = sanitizeName(args && args.machine)
        const limit = Math.min(500, Number(args && args.limit) || 100)
        let jobs = state.jobs.slice().reverse()
        if (machine) jobs = jobs.filter((j) => j.machine === machine)
        else if (sessionId) jobs = jobs.filter((j) => j.sessionId === sessionId)
        const out = []
        for (const j of jobs.slice(0, limit)) {
          const s = await readJobStatus(j).catch(() => ({ status: j.status }))
          out.push({ ...j, ...s })
        }
        return { ok: true, jobs: out }
      },
    })

    registerTool({
      name: 'vm_job_status',
      description: '查询单个后台任务最新状态(运行中、成功、失败、已停止)和日志尾部。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '任务 ID。' },
        },
        required: ['job_id'],
      },
      output: OUT,
      async execute(args, exec) {
        const job = jobById(String(args && args.job_id || ''))
        if (!job) throw new Error('未找到后台任务')
        const status = await readJobStatus(job)
        return { ok: true, job: { ...job, ...status } }
      },
    })

    registerTool({
      name: 'vm_job_stop',
      description: '停止一个运行中的后台任务。需要任务归属会话或对目标机器有 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '任务 ID。' },
        },
        required: ['job_id'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        const out = await stopJob(ctx, sessionId, String(args && args.job_id || ''))
        pushAudit(sessionId, out.job.machine, 'vm_job_stop', { jobId: out.job.id }, true, null, Date.now() - t0)
        return out
      },
    })

    registerTool({
      name: 'vm_job_output',
      description: '获取后台任务的完整日志输出(默认最多 1MB,可选 max_bytes)。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '任务 ID。' },
          max_bytes: { type: 'integer', description: '可选最大字节数,默认 1048576。' },
        },
        required: ['job_id'],
      },
      output: OUT,
      async execute(args, exec) {
        return jobFullOutput(String(args && args.job_id || ''), args && args.max_bytes)
      },
    })
registerTool({
      name: 'vm_job_log',
      description: '管理后台任务日志:operation=get 读取日志(可选 max_bytes)、rotate 轮转归档、archives 列出归档。用于日志轮转/归档/下载场景。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['get', 'rotate', 'archives'], description: '操作类型,默认 get。' },
          job_id: { type: 'string', description: '任务 ID。' },
          max_bytes: { type: 'integer', description: 'get 时可选最大字节数,默认 1048576。' },
        },
        required: ['job_id'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'get'
        const jobId = String(args && args.job_id || '')
        const job = jobById(jobId)
        if (!job) throw new Error('未找到后台任务: ' + jobId)
        if (job.sessionId !== sessionId && !canManage(sessionId, job.machine)) throw new Error('没有权限管理该任务日志')
        if (op === 'rotate') return jobLogRotate(jobId)
        if (op === 'archives') return jobLogArchives(jobId)
        return jobFullOutput(jobId, args && args.max_bytes)
      },
    })

    registerTool({
      name: 'vm_audit',
      description: '查询虚拟机操作审计日志:谁(sessionId)/什么机器/什么操作/何时/是否成功/错误。可按 session/machine/operation 过滤。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选按机器过滤。' },
          operation: { type: 'string', description: '可选按操作名过滤,如 vm_create、vm_exec、vm_snapshot。' },
          limit: { type: 'integer', description: '可选返回条数,默认 100。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const filter = { sessionId: sessionId || undefined, machine: sanitizeName(args && args.machine) || undefined, operation: args && args.operation || undefined }
        return { ok: true, entries: await auditView(ctx, filter, args && args.limit || 100) }
      },
    })

    registerTool({
      name: 'vm_share',
      description: '把当前会话拥有的虚拟机共享给另一个会话。mode=exec 允许执行/传输/端口转发/任务,mode=manage 额外允许生命周期/网络/快照。只有 owner 可共享。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '要共享的机器名称。' },
          session: { type: 'string', description: '目标会话 ID(可从 vm_list.sessions 获取)。' },
          mode: { type: 'string', enum: ['exec', 'manage'], description: '可选权限模式,默认 exec。' },
        },
        required: ['machine', 'session'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const name = sanitizeName(args && args.machine)
        const targetSession = String(args && args.session || '').trim()
        const mode = args && args.mode === 'manage' ? 'manage' : 'exec'
        if (!canOwner(sessionId, name)) throw new Error('只有归属会话可以共享该机器')
        if (!targetSession || targetSession === sessionId) throw new Error('session 必须是其他会话 ID')
        const grants = state.shares[name] = state.shares[name] || []
        const idx = grants.findIndex((g) => g.sessionId === targetSession)
        if (idx >= 0) grants[idx] = { sessionId: targetSession, mode, sharedAt: Date.now() }
        else grants.push({ sessionId: targetSession, mode, sharedAt: Date.now() })
        saveState()
        pushAudit(sessionId, name, 'vm_share', { targetSession, mode }, true, null)
        return { ok: true, machine: name, sharedWith: grants }
      },
    })

    registerTool({
      name: 'vm_unshare',
      description: '取消当前会话虚拟机对其他会话的共享。只有 owner 可操作。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '机器名称。' },
          session: { type: 'string', description: '目标会话 ID。' },
        },
        required: ['machine', 'session'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const name = sanitizeName(args && args.machine)
        const targetSession = String(args && args.session || '').trim()
        if (!canOwner(sessionId, name)) throw new Error('只有归属会话可以取消共享')
        const grants = state.shares[name] = (state.shares[name] || []).filter((g) => g.sessionId !== targetSession)
        if (grants.length === 0) delete state.shares[name]
        saveState()
        pushAudit(sessionId, name, 'vm_unshare', { targetSession }, true, null)
        return { ok: true, machine: name, sharedWith: grants }
      },
    })

    registerTool({
      name: 'vm_policy',
      description: '查看/调整当前会话的虚拟机配额与回收策略:max_machines、idle_sleep_minutes、idle_delete_days、cpu_quota(累计 CPU 核)、memory_quota(累计内存,如 16G,0=不限制)。只影响当前会话自己的机器。',
      parameters: {
        type: 'object',
        properties: {
          max_machines: { type: 'integer', description: '可选设置本会话最大机器数(1-8)。' },
          idle_sleep_minutes: { type: 'integer', description: '可选设置闲置休眠分钟数(0 表示不自动休眠)。' },
          idle_delete_days: { type: 'integer', description: '可选设置闲置自动删除天数(0 表示不自动删除)。' },
          snapshot_interval_hours: { type: 'integer', description: '可选:自动快照间隔(小时),0 表示关闭。' },
          snapshot_retention: { type: 'integer', description: '可选:每台机器保留最新快照份数(0 表示不限制)。' },
          cpu_quota: { type: 'number', description: '可选:本会话累计 CPU 核数上限(0 表示不限制)。' },
          memory_quota: { type: 'string', description: '可选:本会话累计内存上限,如 16G / 4096MiB(0 表示不限制)。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const cur = sessionPolicy(sessionId)
        const next = { ...cur }
        if (args && args.max_machines !== undefined) next.maxMachines = Math.max(1, Math.min(MAX_PER_SESSION, Number(args.max_machines)))
        if (args && args.idle_sleep_minutes !== undefined) next.idleSleepMinutes = Math.max(0, Number(args.idle_sleep_minutes))
        if (args && args.idle_delete_days !== undefined) next.idleDeleteDays = Math.max(0, Number(args.idle_delete_days))
        if (args && args.snapshot_interval_hours !== undefined) next.snapshotIntervalHours = Math.max(0, Number(args.snapshot_interval_hours))
        if (args && args.snapshot_retention !== undefined) next.snapshotRetention = Math.max(0, Number(args.snapshot_retention))
        if (args && args.cpu_quota !== undefined) next.cpuQuota = Math.max(0, Number(args.cpu_quota) || 0)
        if (args && args.memory_quota !== undefined) {
          const mib = sizeToMiB(args.memory_quota) || (/^[0-9]+$/.test(String(args.memory_quota).trim()) ? Number(args.memory_quota) : 0)
          next.memoryQuotaMiB = Math.max(0, mib)
        }
        state.policies[sessionId] = next
        saveState()
        pushAudit(sessionId, null, 'vm_policy', { next }, true, null)
        return { ok: true, sessionId, policy: next, usage: sessionResourceUsage(sessionId) }
      },
    })

    registerTool({
      name: 'vm_network',
      description: '查看/设置虚拟机网络策略。public_access 是否允许访问公网;internal_access 是否允许与其他 VM 内网互通;isolated/isolate_network 为 OrbStack 官方网络隔离标记(需重启生效)。策略持久化并在每次启动时重新应用。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
          public_access: { type: 'boolean', description: '可选:是否允许访问公网。' },
          internal_access: { type: 'boolean', description: '可选:是否允许与其他 VM 内网互通。' },
          isolated: { type: 'boolean', description: '可选:OrbStack 官方隔离模式。' },
          isolate_network: { type: 'boolean', description: '可选:OrbStack 官方网络隔离(需 isolated=true)。' },
          allowlist: { type: 'array', items: { type: 'string' }, description: '可选:IP/CIDR/域名白名单,即使公网/内网关闭也会放行。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const machine = sanitizeName(args && args.machine)
        if (args && (args.public_access !== undefined || args.internal_access !== undefined || args.isolated !== undefined || args.isolate_network !== undefined || args.allowlist !== undefined)) {
          return setNetworkPolicy(ctx, sessionId, machine, args.public_access, args.internal_access, args.isolated, args.isolate_network, args.allowlist)
        }
        return networkStatusOf(ctx, sessionId, machine)
      },
    })
registerTool({
      name: 'vm_cron',
      description: '管理 VM 内定时任务(5 字段 cron 表达式)。operation=list|add|remove|toggle;add 需要 machine/command/expr,支持启停与下次运行时间。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'add', 'remove', 'toggle', 'run'], description: '操作类型,默认 list。' },
          name: { type: 'string', description: '任务名称(add/remove/toggle/run 时使用)。' },
          machine: { type: 'string', description: '目标机器名称(add 时使用)。' },
          command: { type: 'string', description: '要定时执行的命令(add 时使用)。' },
          expr: { type: 'string', description: 'cron 表达式(5 字段,如 */5 * * * *)' },
          enabled: { type: 'boolean', description: '可选:是否启用,默认 true。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        if (op === 'list') {
          const list = (state.cron || []).filter((c) => c.sessionId === sessionId).map((c) => ({ ...c }))
          return { ok: true, jobs: list }
        }
        if (op === 'add') {
          const machine = sanitizeName(args && args.machine)
          const command = String((args && args.command) || '').trim()
          const expr = String((args && args.expr) || '').trim()
          if (!machine) throw new Error('缺少 machine')
          if (!command) throw new Error('缺少 command')
          if (expr.split(/\s+/).length !== 5) throw new Error('cron 表达式必须为 5 字段')
          if (!cronMatch(new Date(), expr)) {
            // 仅校验格式,不强制当前分钟匹配
          }
          const id = genId('cron')
          state.cron = state.cron || []
          state.cron.push({ id, name: String((args && args.name) || '').trim() || id, sessionId, machine, command, expr, enabled: args.enabled !== false, createdAt: Date.now(), nextRunAt: nextCronRun(expr, new Date())?.getTime() || null })
          saveState()
          pushAudit(sessionId, machine, 'vm_cron_add', { id, expr }, true, null)
          return { ok: true, job: state.cron.find((c) => c.id === id) }
        }
        if (op === 'remove') {
          const name = String((args && args.name) || '').trim()
          const idx = (state.cron || []).findIndex((c) => c.id === name || c.name === name || (args && args.machine && c.machine === sanitizeName(args.machine)))
          if (idx < 0) throw new Error('未找到定时任务')
          const [job] = state.cron.splice(idx, 1)
          saveState()
          pushAudit(sessionId, job.machine, 'vm_cron_remove', { id: job.id }, true, null)
          return { ok: true, removed: job }
        }
        if (op === 'toggle' || op === 'run') {
          const name = String((args && args.name) || '').trim()
          const job = (state.cron || []).find((c) => c.id === name || c.name === name)
          if (!job) throw new Error('未找到定时任务')
          if (op === 'toggle') {
            job.enabled = !job.enabled
            saveState()
            return { ok: true, job: { ...job } }
          }
          const out = await submitJob(ctx, sessionId, job.machine, job.command)
          job.lastRunAt = Date.now()
          saveState()
          return { ok: true, job: { ...job }, triggered: out }
        }
        throw new Error('不支持的 operation')
      },
    })

    registerTool({
      name: 'vm_template',
      description: '查看/管理初始化模板库(python/node/docker/cuda 内置模板,支持本地 JSON/YAML 或 GitHub raw URL)。operation=list|get|save|remove;save 保存自定义模板。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'get', 'save', 'remove'], description: '操作类型,默认 list。' },
          name: { type: 'string', description: '模板名。' },
          description: { type: 'string', description: '模板描述。' },
          distro: { type: 'string', description: '模板发行版(debian/alpine)。' },
          init_script: { type: 'string', description: '模板初始化脚本。' },
          cloud_init: { type: 'string', description: '模板 cloud-init 用户数据。' },
          source: { type: 'string', description: '模板来源(本地 JSON/YAML 路径或 GitHub raw URL),get 时使用。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        if (op === 'list') return { ok: true, templates: templateList() }
        if (op === 'get') {
          const name = String((args && args.name) || '').trim()
          if (!name) throw new Error('缺少模板名')
          if (state.templates && state.templates[name]) return { ok: true, template: { name, ...state.templates[name], custom: true } }
          const builtin = builtinTemplates()[name]
          if (builtin) return { ok: true, template: { name, ...builtin, builtin: true } }
          const tpl = await resolveTemplate(ctx, args.source || name)
          return { ok: true, template: { name, ...tpl } }
        }
        if (op === 'save') {
          const name = sanitizeName(args && args.name) || ('tpl-' + Date.now().toString(36))
          state.templates = state.templates || {}
          state.templates[name] = {
            name,
            description: String((args && args.description) || '').slice(0, 200),
            distro: (args && args.distro) || 'debian',
            init_script: args && args.init_script,
            cloud_init: args && args.cloud_init,
            createdAt: Date.now(),
          }
          saveState()
          pushAudit(sessionId, null, 'vm_template_save', { name }, true, null)
          return { ok: true, template: state.templates[name] }
        }
        if (op === 'remove') {
          const name = String((args && args.name) || '').trim()
          if (!state.templates || !state.templates[name]) throw new Error('未找到模板')
          delete state.templates[name]
          saveState()
          return { ok: true, removed: name }
        }
        throw new Error('不支持的 operation')
      },
    })
registerTool({
      name: 'vm_resize',
      description: '运行时热调整虚拟机资源规格(cpus/memory/disk),基于 OrbStack 官方 orb config set。需要 manage 权限;磁盘等变更会自动重启 VM 生效。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
          cpus: { type: 'number', description: '可选:新的 CPU 核数。' },
          memory: { type: 'string', description: '可选:新内存,如 4G / 4096MiB。' },
          disk: { type: 'string', description: '可选:新磁盘上限,如 32G / 64G。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const out = await resizeMachine(ctx, sessionId, sanitizeName(args && args.machine), args && args.cpus, args && args.memory, args && args.disk)
          pushAudit(sessionId, out.machine, 'vm_resize', out.changes, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_resize', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_metrics',
      description: '查看虚拟机资源指标历史(CPU/内存/磁盘,每 30 秒采样,默认最近 120 条)。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
          limit: { type: 'integer', description: '可选返回条数,默认 120,最大 1440。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canExec(sessionId, target.name)) throw new Error('没有权限查看指标')
        return metricsView(target.name, Math.min(1440, Number(args && args.limit) || 120))
      },
    })

    registerTool({
      name: 'vm_export',
      description: '导出虚拟机为镜像文件(D3,based on orb export)。output_path 为本地导出路径(工作区内)。slice_mb>0 时按指定大小分片到 <output_path>.parts/;remote_machine+remote_dir 时把单文件或(配 slice)分片推送到另一台 VM 内。需要 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '源机器名称;省略使用当前会话默认机器。' },
          output_path: { type: 'string', description: '本地导出路径(相对于工作区);分片时为 <path>.parts/ 目录。' },
          slice_mb: { type: 'number', description: '可选:分片大小(MB),>0 时按片导出。' },
          remote_machine: { type: 'string', description: '可选:推送到另一台 VM(远端备份);目录见 remote_dir。' },
          remote_dir: { type: 'string', description: '可选:远端目录,默认 /root。' },
        },
        required: ['output_path'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const out = await exportMachine(ctx, sessionId, sanitizeName(args && args.machine), args && args.output_path, { sliceMb: args && args.slice_mb, remoteMachine: sanitizeName(args && args.remote_machine), remoteDir: args && args.remote_dir })
          pushAudit(sessionId, out.machine, 'vm_export', { dest: out.dest && out.dest.type }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_export', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_import',
      description: '从镜像文件导入虚拟机(基于 OrbStack 官方 orb import -n)。需要会话内机器未满。',
      parameters: {
        type: 'object',
        properties: {
          input_path: { type: 'string', description: '本地导入文件路径(相对于工作区)。' },
          machine: { type: 'string', description: '可选:导入后的机器名称;省略自动生成。' },
          distro: { type: 'string', enum: ['debian', 'alpine'], description: '可选:发行版标记,默认 debian。' },
        },
        required: ['input_path'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const out = await importMachine(ctx, sessionId, args && args.input_path, sanitizeName(args && args.machine), (args && args.distro) || 'debian')
          pushAudit(sessionId, out.machine, 'vm_import', { path: args && args.input_path }, true, null, Date.now() - t0)
          return out
        } catch (err) {
          pushAudit(sessionId, sanitizeName(args && args.machine), 'vm_import', {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_service_discover',
      description: '服务发现:列出全部/单台运行中的虚拟机及其 IP、运行中端口转发、已注册服务。可用于 VM 间互访。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '可选:只发现指定机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        return discoverServices(ctx, sessionId, sanitizeName(args && args.machine))
      },
    })

    registerTool({
      name: 'vm_service_register',
      description: '注册/注销一个 VM 上对外开放的服务(用于服务发现)。operation=register|unregister;返回服务清单。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['register', 'unregister'], description: '操作类型,默认 register。' },
          machine: { type: 'string', description: '目标机器名称。' },
          service: { type: 'string', description: '服务名,如 backend-api。' },
          port: { type: 'integer', description: '服务端口。' },
          meta: { type: 'string', description: '可选元信息/备注。' },
        },
        required: ['machine', 'service'],
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const machine = sanitizeName(args && args.machine)
        const service = String((args && args.service) || '').trim()
        if (!recordOfMachine(machine)) throw new Error('未找到机器: ' + machine)
        if (!canManage(sessionId, machine)) throw new Error('没有权限注册服务')
        state.services = state.services || {}
        if (!state.services[machine]) state.services[machine] = []
        const list = state.services[machine]
        const op = (args && args.operation) || 'register'
        if (op === 'unregister') {
          state.services[machine] = list.filter((s) => s.service !== service)
        } else {
          let found = list.find((s) => s.service === service)
          if (found) found.port = Number(args.port)
          else list.push({ service, port: Number(args.port), meta: String((args && args.meta) || ''), registeredAt: Date.now() })
        }
        saveState()
        pushAudit(sessionId, machine, 'vm_service_' + op, { service, port: args.port }, true, null)
        return { ok: true, machine, services: state.services[machine] }
      },
    })

    registerTool({
      name: 'vm_harden',
      description: '查看/应用虚拟机安全基线(B1):operation=scan 检测 sshd 密码登录/root 登录/非回环监听/基础工具/标记;apply 应用加固(禁 SSH 密码登录、root 仅密钥、写入 /etc/dsh/hardened-on);status 显示已加固时间。默认新创建的 VM 自动加固;需要 manage 权限。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['scan', 'apply', 'status'], description: '操作类型,默认 scan。' },
          machine: { type: 'string', description: '目标机器名称;省略使用当前会话默认机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canManage(sessionId, target.name)) throw new Error('没有权限查看/加固该机器(' + target.name + ')')
        const op = (args && args.operation) || 'scan'
        const t0 = Date.now()
        try {
          if (op === 'scan') {
            await ensureRunning(target.name)
            const checks = await hardenScan(target.name)
            pushAudit(sessionId, target.name, 'vm_harden_scan', {}, true, null, Date.now() - t0)
            return { ok: true, machine: target.name, operation: 'scan', checks, summary: { pass: checks.filter((c) => c.status === 'ok').length, fail: checks.filter((c) => c.status === 'fail').length, na: checks.filter((c) => c.status === 'na').length } }
          }
          if (op === 'apply') {
            await ensureRunning(target.name)
            const before = await hardenScan(target.name)
            await applyHardenBaseline(target.name)
            const after = await hardenScan(target.name)
            const rec = recordOfMachine(target.name)
            if (rec && rec.type === 'machine') { rec.security = Object.assign(rec.security || {}, { hardenedAt: Date.now() }); saveState() }
            pushAudit(sessionId, target.name, 'vm_harden_apply', {}, true, null, Date.now() - t0)
            return { ok: true, machine: target.name, operation: 'apply', before, after, hardenedAt: Date.now() }
          }
          const rec = recordOfMachine(target.name)
          return { ok: true, machine: target.name, hardenedAt: rec && rec.type === 'machine' && rec.security ? rec.security.hardenedAt : null }
        } catch (err) {
          pushAudit(sessionId, target.name, 'vm_harden_' + op, {}, false, err && err.message || err, Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_secret',
      description: '密钥库(B2):operation=set/get/list/rm。set 以 AES-256-GCM 加密存于 ~/.dsh/vm-sandbox/secrets.vault.json(key 0600);init_script/cloud_init 内用 {{secret:name}} 占位符注入;审计与日志自动对密文脱敏。value 仅 get 返回,不回显到审计。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['set', 'get', 'list', 'rm'], description: '操作类型,默认 list。' },
          name: { type: 'string', description: '密钥名(字母数字._-)。' },
          value: { type: 'string', description: 'set 时的明文值(仅允许占位符引用场景使用,不落日志)。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        const name = String((args && args.name) || '').trim()
        try {
          if (op === 'set') {
            if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error('name 仅允许字母数字._-(<=64)')
            if (args === null || args === undefined || args.value === undefined || args.value === null) throw new Error('value 不能为空')
            vaultSet(name, String(args.value), 'secret')
            pushAudit(sessionId, null, 'vm_secret_set', { name }, true, null)
            return { ok: true, name, set: true }
          }
          if (op === 'get') {
            if (!name) throw new Error('缺少 name')
            const v = vaultGet(name)
            if (v === null) throw new Error('未找到密钥或解密失败: ' + name)
            pushAudit(sessionId, null, 'vm_secret_get', { name }, true, null)
            return { ok: true, name, value: v }
          }
          if (op === 'rm') {
            if (!name) throw new Error('缺少 name')
            const removed = vaultRemove(name)
            pushAudit(sessionId, null, 'vm_secret_rm', { name }, true, null)
            return { ok: true, name, removed }
          }
          pushAudit(sessionId, null, 'vm_secret_list', {}, true, null)
          return { ok: true, secrets: vaultList().map((s) => ({ name: s.name, kind: s.kind, updatedAt: s.updatedAt })) }
        } catch (err) {
          pushAudit(sessionId, null, 'vm_secret_' + op, { name }, false, redactVaultText(String((err && err.message) || err)))
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_alert',
      description: '指标阈值告警(C1):operation=add/list/remove。rule 在每次指标采样(30s)时评估,命中即记 vm_alert_fire 审计并出现在 /vmsb-api/alerts;metric ∈ cpu|mem|disk|load|netRx|netTx|io,op ∈ gt|gte|lt|lte|eq,value 为阈值,cooldown_min 为冷却(0=每次命中都触发),machine 留空则作用于该会话全部机器。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'list', 'remove'], description: '操作类型,默认 list。' },
          name: { type: 'string', description: '规则名(唯一,add/remove 时使用)。' },
          metric: { type: 'string', enum: ['cpu', 'mem', 'disk', 'load', 'netRx', 'netTx', 'io'], description: '度量:CPU%/内存%/磁盘%/load(1min)/网络入(MB/s→Bps)/netTx/io(sectors/s)。' },
          op: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq'], description: '比较操作。' },
          value: { type: 'number', description: '阈值。' },
          message: { type: 'string', description: '可选告警文案。' },
          cooldown_min: { type: 'number', description: '冷却分钟(默认 0)。' },
          machine: { type: 'string', description: '目标机器;留空作用于本会话全部机器。' },
          enabled: { type: 'boolean', description: 'add 时是否启用,默认 true。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        try {
          if (op === 'add') {
            const name = String((args && args.name) || '').trim()
            const metric = String((args && args.metric) || '').trim()
            const o = String((args && args.op) || '').trim()
            const value = Number(args && args.value)
            if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error('name 仅允许字母数字._-(<=64)')
            if (!['cpu', 'mem', 'disk', 'load', 'netRx', 'netTx', 'io'].includes(metric)) throw new Error('metric 不合法')
            if (!['gt', 'gte', 'lt', 'lte', 'eq'].includes(o)) throw new Error('op 不合法')
            if (!Number.isFinite(value)) throw new Error('value 必须为数字')
            const existing = (state.alerts || []).find((r) => r.sessionId === sessionId && r.name === name)
            const rule = existing || { id: genId('alrt'), sessionId, createdAt: Date.now(), count: 0 }
            Object.assign(rule, { name, metric, op: o, value, message: String((args && args.message) || '').slice(0, 200), cooldownMin: Math.max(0, Number(args && args.cooldown_min) || 0), machine: sanitizeName(args && args.machine) || null, enabled: args && args.enabled === false ? false : true })
            if (!existing) state.alerts = state.alerts || []
            if (!existing && !state.alerts.some((r) => r.id === rule.id)) state.alerts.push(rule)
            saveState()
            pushAudit(sessionId, rule.machine, 'vm_alert_add', { name, metric, op: o, value }, true, null)
            return { ok: true, rule }
          }
          if (op === 'remove') {
            const name = String((args && args.name) || '').trim()
            const idx = (state.alerts || []).findIndex((r) => r.sessionId === sessionId && r.name === name)
            if (idx < 0) throw new Error('未找到规则: ' + name)
            const [rule] = state.alerts.splice(idx, 1)
            saveState()
            pushAudit(sessionId, rule.machine, 'vm_alert_remove', { name }, true, null)
            return { ok: true, removed: rule }
          }
          const rules = (state.alerts || []).filter((r) => r.sessionId === sessionId).map((r) => ({ ...r }))
          return { ok: true, rules }
        } catch (err) {
          pushAudit(sessionId, null, 'vm_alert_' + op, { name: args && args.name }, false, String((err && err.message) || err))
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_scp',
      description: '批量文件分发(D1):上传/下载任意文件集合到单台或多台机器(fan-out)。direction=upload|download;files 为 [{local_path, remote_path}] 数组,或用单个 local_path/remote_path 简写;machines 为目标机器数组(或单 machine)。权限复用 exec 权限。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['upload', 'download'], description: '方向,默认 upload。' },
          machines: { type: 'array', items: { type: 'string' }, description: '目标机器数组(至少一台)。' },
          machine: { type: 'string', description: '或单台目标机器。' },
          files: { type: 'array', items: { type: 'object', properties: { local_path: { type: 'string' }, remote_path: { type: 'string' } } }, description: '文件对数组。' },
          local_path: { type: 'string', description: '简写:单对文件的本地路径(local 亦可)。' },
          remote_path: { type: 'string', description: '简写:单对文件的远端路径(remote 亦可)。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const t0 = Date.now()
        try {
          const direction = (args && args.direction) === 'download' ? 'download' : 'upload'
          const machines = Array.isArray(args && args.machines) ? args.machines.map(sanitizeName).filter(Boolean) : [sanitizeName(args && args.machine)].filter(Boolean)
          if (machines.length === 0) throw new Error('需要 machines 或 machine')
          let files = Array.isArray(args && args.files)
            ? args.files.map((f) => ({ local: f && f.local_path, remote: f && f.remote_path })).filter((f) => f.local && f.remote)
            : []
          if (files.length === 0 && (args && (args.local_path || args.local)) && (args && (args.remote_path || args.remote))) {
            files = [{ local: args.local_path || args.local, remote: args.remote_path || args.remote }]
          }
          if (files.length === 0) throw new Error('需要 files 或 local_path+remote_path')
          const results = []
          for (const m of Array.from(new Set(machines))) {
            const owner = ownerOfMachine(m)
            if (owner && !canExec(sessionId, m)) throw new Error('没有权限: ' + m + '(请先 vm_share)')
            const target = owner ? await resolveExistingMachineByName(ctx, sessionId, m) : await resolveMachineByName(ctx, sessionId, m)
            await ensureRunning(target.name)
            for (const f of files) {
              let local
              try { local = resolveLocalPath(ctx, f.local) } catch (e) { results.push({ machine: target.name, localPath: f.local, ok: false, error: String(e.message || e) }); continue }
              const remote = String(f.remote || '')
              if (!remote.trim()) { results.push({ machine: target.name, ok: false, error: 'remote_path 不能为空' }); continue }
              if (direction === 'download') {
                if ((String(local).endsWith('/') || String(local).endsWith(sep)) && !existsSync(local)) { try { mkdirSync(local, { recursive: true }) } catch (e) { /* ignore */ } }
                const res = await orb(['pull', '-m', target.name, remote, local], { timeoutMs: 600000 })
                results.push({ machine: target.name, direction, localPath: local, remotePath: remote, ok: res.exitCode === 0, error: res.exitCode === 0 ? null : String(res.stderr || res.stdout || '').slice(0, 300) })
              } else {
                if (!existsSync(local)) { results.push({ machine: target.name, localPath: local, ok: false, error: '本地文件不存在' }); continue }
                const res = await orb(['push', '-m', target.name, local, remote], { timeoutMs: 600000 })
                results.push({ machine: target.name, direction, localPath: local, remotePath: remote, ok: res.exitCode === 0, error: res.exitCode === 0 ? null : String(res.stderr || res.stdout || '').slice(0, 300) })
              }
            }
          }
          const okCount = results.filter((r) => r.ok).length
          pushAudit(sessionId, machines.join(','), 'vm_scp', { direction, files: files.length, ok: okCount + '/' + results.length }, okCount === results.length, okCount === results.length ? null : '部分失败', Date.now() - t0)
          return { ok: true, direction, files: files.length, success: okCount + '/' + results.length, results }
        } catch (err) {
          pushAudit(sessionId, null, 'vm_scp', {}, false, String((err && err.message) || err), Date.now() - t0)
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_logs',
      description: '统一日志视图(D1):vm_logs { machine?, job_id?, limit, max_bytes }。job_id 给单个任务日志尾部;否则返回该机器最近的 Shell 命令记录 + 各后台任务尾部。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器;省略使用当前会话默认机器。' },
          job_id: { type: 'string', description: '给单个任务 id 时返回其日志。' },
          limit: { type: 'integer', description: 'shell 记录条数,默认 20。' },
          max_bytes: { type: 'integer', description: '任务日志最大字节,默认 8192。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const jobId = String((args && args.job_id) || '').trim()
        if (jobId) {
          const job = jobById(jobId)
          if (!job) throw new Error('未找到任务: ' + jobId)
          if (!canExec(sessionId, job.machine)) throw new Error('没有权限查看该任务日志')
          return { ok: true, jobId, machine: job.machine, log: (await jobFullOutput(jobId, Number(args && args.max_bytes) || 8192)).log }
        }
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canExec(sessionId, target.name)) throw new Error('没有权限查看日志(' + target.name + ')')
        const limit = Math.min(100, Number(args && args.limit) || 20)
        const shell = (shellLogs.get(target.name) || []).slice(-limit).reverse().map((e) => ({ id: e.id, ts: e.startTime, status: e.status, exitCode: e.exitCode, command: e.command, stdout: (e.stdout || '').slice(0, 2000), stderr: (e.stderr || '').slice(0, 1000) }))
        const jobs = []
        for (const j of state.jobs.filter((x) => x.machine === target.name).reverse().slice(0, limit)) {
          const s = await readJobStatus(j).catch(() => ({ status: j.status }))
          jobs.push({ id: j.id, status: s.status, command: j.command, tail: s.tail || '' })
        }
        return { ok: true, machine: target.name, shell, jobs }
      },
    })

    registerTool({
      name: 'vm_env',
      description: '环境变量库(D1):operation=set/get/list/rm。与 vm_secret 共用一个加密 vault(区分 kind=env),init_script/cloud_init 里可用 {{env:name}} 注入;审计脱敏同样生效(受保护的是 value,env 通常非敏感)。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['set', 'get', 'list', 'rm'], description: '操作类型,默认 list。' },
          name: { type: 'string', description: '变量名(字母数字._-)。' },
          value: { type: 'string', description: 'set 时的值。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        const name = String((args && args.name) || '').trim()
        try {
          if (op === 'set') {
            if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error('name 需为合法标识符(<=64)')
            if (args === null || args === undefined || args.value === undefined || args.value === null) throw new Error('value 不能为空')
            vaultSet(name, String(args.value), 'env')
            pushAudit(sessionId, null, 'vm_env_set', { name }, true, null)
            return { ok: true, name, set: true }
          }
          if (op === 'get') {
            if (!name) throw new Error('缺少 name')
            const v = vaultGet(name)
            if (v === null) throw new Error('未找到变量: ' + name)
            pushAudit(sessionId, null, 'vm_env_get', { name }, true, null)
            return { ok: true, name, value: v }
          }
          if (op === 'rm') {
            if (!name) throw new Error('缺少 name')
            pushAudit(sessionId, null, 'vm_env_rm', { name }, true, null)
            return { ok: true, name, removed: vaultRemove(name) }
          }
          pushAudit(sessionId, null, 'vm_env_list', {}, true, null)
          return { ok: true, envs: vaultList().filter((e) => e.kind === 'env').map((e) => ({ name: e.name, updatedAt: e.updatedAt })) }
        } catch (err) {
          pushAudit(sessionId, null, 'vm_env_' + op, { name }, false, String((err && err.message) || err))
          throw err
        }
      },
    })

    registerTool({
      name: 'vm_withdraw',
      description: '安全下线(D1):停止该机器所有运行中后台任务、停止端口转发、撤销全部共享、可选先快照(keep_snapshot),然后删除机器。需要 owner 权限。',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: '目标机器;省略使用当前会话默认机器。' },
          keep_snapshot: { type: 'boolean', description: '删除前先创建快照(默认 false)。' },
          note: { type: 'string', description: '快照备注。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const hint = sanitizeName(args && args.machine)
        const target = hint ? await resolveExistingMachineByName(ctx, sessionId, hint) : await resolveDefaultMachine(ctx, sessionId)
        if (!canOwner(sessionId, target.name)) throw new Error('只有归属会话可以下线该机器')
        const t0 = Date.now()
        let stoppedJobs = 0
        for (const j of state.jobs) {
          if (j.machine === target.name && j.status === 'running') { try { await stopJob(ctx, sessionId, j.id) } catch (e) { /* ignore */ } stoppedJobs++ }
        }
        stopMachineTunnels(target.name)
        const sharesRevoked = (state.shares[target.name] || []).length
        delete state.shares[target.name]
        let snapshot = null
        if (args && args.keep_snapshot) {
          try { snapshot = (await createSnapshot(ctx, sessionId, target.name, String((args && args.note) || 'withdraw-before-delete'))).snapshot } catch (e) { /* 快照失败继续下线 */ }
        }
        const removed = await removeMachineByName(target.name)
        saveState()
        pushAudit(sessionId, target.name, 'vm_withdraw', { stoppedJobs, sharesRevoked, snapshot: snapshot ? snapshot.name : null }, true, null, Date.now() - t0)
        return { ok: true, machine: target.name, operation: 'withdraw', removed, stoppedJobs, sharesRevoked, snapshot: snapshot ? snapshot.name : null }
      },
    })

    registerTool({
      name: 'vm_queue',
      description: '创建排队(D4):operation=list|cancel。list 查看本会话排队中的 vm_create 请求(含位置/状态);cancel 按 queue_id 取消。每当配额释放,队列会自动推进(FIFO)。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'cancel'], description: '操作类型,默认 list。' },
          queue_id: { type: 'string', description: 'cancel 时指定。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const op = (args && args.operation) || 'list'
        const q = (state.queue && state.queue[sessionId]) || []
        if (op === 'cancel') {
          const id = String((args && args.queue_id) || '').trim()
          const idx = q.findIndex((i) => i.id === id)
          if (idx < 0) throw new Error('未找到该排队请求')
          const [item] = q.splice(idx, 1)
          if (q.length === 0) delete state.queue[sessionId]
          else state.queue[sessionId] = q
          saveState()
          pushAudit(sessionId, null, 'vm_queue_cancel', { id }, true, null)
          return { ok: true, cancelled: item.id }
        }
        return { ok: true, queue: q.map((x, i) => ({ id: x.id, position: i + 1, status: x.status, distro: x.req && x.req.distro, cpus: x.req && x.req.cpus, memory: x.req && x.req.memory, createdAt: x.createdAt, machine: x.machine || null, error: x.error || null })) }
      },
    })
  }

  try { console.log('[vmsb] VM sandbox deployment plugin ready (v0.3.0, cap ' + MAX_RUNNING + ', max-per-session ' + MAX_PER_SESSION + ')') } catch (e) { /* ignore */ }
}

export { apply }
export const inject = ['webServer', 'tools']
// 测试接缝:导出纯函数供 node:test 单元测试使用(不影响 Cordis 加载)
export const __vmsb = {
  cronPartMatch, cronMatch, nextCronRun,
  sanitizeName, abbreviate, codepointLetter,
  sizeToBytes, sizeToMiB,
  parseSimpleYaml,
  validateAllowlist,
  sameOriginOk, checkCsrf, csrfTokens,
  atomicWriteJson, readJsonRobust, flushStateNow,
  normalizeMachines,
  canOwner, canExec, canManage, shareMode,
  ALLOWLIST_RE, STATE_DIR, AUDIT_FILE, METRICS_FILE,
  // B1 / B2 测试接缝
  HARDEN_SCRIPT, HARDEN_CHECK, parseHardenOutput,
  VAULT_FILE, VAULT_KEY_FILE,
  vaultEncrypt, vaultDecrypt, vaultSet, vaultGet, vaultList, vaultRemove,
  injectVaultText, redactVaultText, redactDeep,
  // C1 增强指标/告警测试接缝
  parseProbeOutput, metricValueOf, evalAlert, sampleAllMetrics, evaluateAlerts, metricsView, PROBE_CMD,
  // D4 配额/排队测试接缝
  state, quotaState, sessionResourceUsage, sessionPolicy, processQueuedCreations,
  // D3 分片导出测试接缝
  sliceFileByChunks,
}
// ---- 模板库 ----
function builtinTemplates() {
  return {
    python: { description: 'Python 3 基础环境', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq python3 python3-pip' },
    node: { description: 'Node.js LTS 基础环境', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq curl && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs npm' },
    docker: { description: 'Docker 环境（VM 内安装 Docker CLI）', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq ca-certificates curl && install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io' },
    cuda: { description: 'CUDA 基础环境（示例模板，建议按需调整）', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq build-essential linux-headers-$(uname -r) && apt-get install -y -qq nvidia-driver' },
    webapp: { description: 'Node.js Web 脚手架(git+node+pm2)', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq curl git && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs npm && npm i -g pm2' },
    data: { description: 'Python 数据分析(pandas+git+curl)', distro: 'debian', init_script: 'apt-get update -qq && apt-get install -y -qq python3 python3-pip curl git && python3 -m pip install --quiet pandas numpy requests' },
  }
}

function parseSimpleYaml(text) {
  const out = {}
  let currentKey = null
  const lines = String(text || '').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (m) {
      currentKey = m[1]
      out[currentKey] = m[2].trim()
    } else if (currentKey && indent > 0) {
      out[currentKey] = (out[currentKey] || '') + line.trim() + '\n'
    }
  }
  if (out.init_script) out.init_script = out.init_script.trim()
  if (out.cloud_init) out.cloud_init = out.cloud_init.trim()
  return out
}

function templateList() {
  const builtin = Object.entries(builtinTemplates()).map(([name, t]) => ({ name, description: t.description, builtin: true }))
  const custom = Object.entries(state.templates || {}).map(([name, t]) => ({ name, description: t.description || '', builtin: false }))
  return builtin.concat(custom)
}

async function resolveTemplate(ctx, template) {
  const name = String(template || '').trim()
  if (!name) return null
  if (state.templates && state.templates[name]) return state.templates[name]
  const builtin = builtinTemplates()[name]
  if (builtin) return builtin
  // 支持本地 JSON/YAML 文件路径(仅限工作区内,防止读取宿主任意文件)
  if (name.startsWith('/') || name.startsWith('.')) {
    const full = resolveWorkspacePath(ctx, name)
    if (!existsSync(full)) throw new Error('模板文件不存在: ' + full)
    const text = readFileSync(full, 'utf8')
    if (full.endsWith('.json')) return JSON.parse(text)
    return parseSimpleYaml(text)
  }
  // 支持 GitHub raw URL(仅 https)
  if (/^https:\/\//i.test(name)) {
    const res = await fetch(name, { timeout: 20000 })
    if (!res.ok) throw new Error('模板下载失败: HTTP ' + res.status)
    const text = await res.text()
    if (text.length > 1024 * 1024) throw new Error('模板文件过大(>1MB)')
    if (name.endsWith('.json')) return JSON.parse(text)
    return parseSimpleYaml(text)
  }
  throw new Error('未找到模板: ' + name + '（可用 vm_template 查看）')
}

// 将模板/导入导出路径解析限制在工作区根目录内
function resolveWorkspacePath(ctx, p) {
  const root = workspaceRootOf(ctx)
  const full = resolve(root, String(p || '').replace(/^~/, HOME))
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('路径必须位于工作区内: ' + root)
  }
  return full
}
// ---- 指标历史(独立 metrics.json 存储,不随主 state 序列化) ----
const cpuPrev = new Map()
const netPrev = new Map()
const ioPrev = new Map()
let recentFires = []

function pushMetrics(name, point) {
  let list = metricsStore.get(name)
  if (!list) { list = []; metricsStore.set(name, list) }
  list.push(point)
  if (list.length > MAX_METRICS_POINTS) list.splice(0, list.length - MAX_METRICS_POINTS)
}

// C1: 从指标点取某个可告警度量值
function metricValueOf(point, metric) {
  if (!point) return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (metric === 'cpu') return num(point.cpuPercent)
  if (metric === 'mem') return point.memory && point.memory.totalBytes ? Math.round((1 - (point.memory.availableBytes || 0) / point.memory.totalBytes) * 1000) / 10 : null
  if (metric === 'disk') return point.rootFs && point.rootFs.totalBytes ? Math.round((1 - (point.rootFs.availableBytes || 0) / point.rootFs.totalBytes) * 1000) / 10 : null
  if (metric === 'load') { const p = Number(String(point.load || '').split(' ')[0]); return Number.isFinite(p) ? p : null }
  if (metric === 'netRx') return num(point.netRxBps)
  if (metric === 'netTx') return num(point.netTxBps)
  if (metric === 'io') return num(point.ioOps)
  return null
}
function evalAlert(rule, point) {
  const v = metricValueOf(point, rule && rule.metric)
  if (v === null || v === undefined || Number.isNaN(v)) return false
  const t = Number(rule.value)
  const ops = { gt: v > t, gte: v >= t, lt: v < t, lte: v <= t, eq: v === t }
  return !!ops[rule.op]
}
function evaluateAlerts(machine, point) {
  const now = Date.now()
  for (const rule of state.alerts || []) {
    if (!rule.enabled) continue
    if (rule.machine && rule.machine !== machine) continue
    if (!evalAlert(rule, point)) continue
    const cooldown = (rule.cooldownMin || 0) * 60000
    if (rule.lastFiredAt && cooldown > 0 && now - rule.lastFiredAt < cooldown) continue
    rule.lastFiredAt = now
    rule.count = (rule.count || 0) + 1
    recentFires.unshift({ ts: now, machine, name: rule.name, metric: rule.metric, value: metricValueOf(point, rule.metric), message: rule.message || '', sessionId: rule.sessionId })
    if (recentFires.length > 20) recentFires.length = 20
    saveState()
    pushAudit(rule.sessionId, machine, 'vm_alert_fire', { name: rule.name, metric: rule.metric, value: metricValueOf(point, rule.metric) }, true, null)
  }
}

async function sampleAllMetrics() {
  try {
    const machines = await listMachines()
    const running = machines.filter((m) => m.state === 'running' && !state.snapshots[m.name])
    const now = Date.now()
    for (const m of running) {
      const probe = await probeStatus(m.name).catch(() => null)
      if (!probe) continue
      const point = { ts: now, ...probe }
      // CPU 使用率(两次采样差)
      const cp = cpuPrev.get(m.name)
      if (cp && probe.cpu && probe.cpu.total > cp.total && now > cp.ts) {
        const busyDelta = (probe.cpu.total - probe.cpu.idle) - (cp.total - cp.idle)
        const totalDelta = probe.cpu.total - cp.total
        if (totalDelta > 0) point.cpuPercent = Math.max(0, Math.min(100, Math.round((busyDelta / totalDelta) * 1000) / 10))
        point.cpuCores = probe.cpu.cores
      }
      cpuPrev.set(m.name, { ts: now, total: probe.cpu ? probe.cpu.total : 0, idle: probe.cpu ? probe.cpu.idle : 0 })
      // 网络速率 / IO 速率
      const np = netPrev.get(m.name)
      if (np && probe.net) {
        const dt = Math.max(1, (now - np.ts) / 1000)
        if (probe.net.rx >= np.rx) point.netRxBps = Math.round((probe.net.rx - np.rx) / dt)
        if (probe.net.tx >= np.tx) point.netTxBps = Math.round((probe.net.tx - np.tx) / dt)
      }
      netPrev.set(m.name, { ts: now, rx: probe.net ? probe.net.rx : 0, tx: probe.net ? probe.net.tx : 0 })
      const ip = ioPrev.get(m.name)
      if (ip && probe.io) {
        const dt = Math.max(1, (now - ip.ts) / 1000)
        if (probe.io.r + probe.io.w >= ip.r + ip.w) point.ioOps = Math.round(((probe.io.r - ip.r) + (probe.io.w - ip.w)) / dt)
      }
      ioPrev.set(m.name, { ts: now, r: probe.io ? probe.io.r : 0, w: probe.io ? probe.io.w : 0 })
      pushMetrics(m.name, point)
      evaluateAlerts(m.name, point)
    }
    saveState()
  } catch (e) { /* 采样失败静默 */ }
}

function metricsView(name, limit) {
  const list = metricsStore.get(name) || []
  const n = Math.max(1, Number(limit) || 120)
  return { ok: true, machine: name, metrics: list.slice(-n).map((p) => ({ ...p })) }
}

// ---- 热调整资源 ----
function sizeToBytes(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMGTP]?)(i?B?)$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  const map = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(n * (map[unit] || 1))
}

function sizeToMiB(value) {
  const bytes = sizeToBytes(value)
  return bytes === null ? null : Math.ceil(bytes / 1024 / 1024)
}

async function resizeMachine(ctx, sessionId, machineName, cpus, memory, disk) {
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canManage(sessionId, target.name)) throw new Error('没有权限调整资源(' + target.name + ')')
  const changes = []
  if (cpus !== undefined && String(cpus).trim() !== '') {
    const val = Number(cpus)
    if (!(val > 0)) throw new Error('cpus 必须为正数')
    const res = await orb(['config', 'set', 'machine.' + target.name + '.cpu', String(val)], { timeoutMs: 30000 })
    if (res.exitCode !== 0) throw new Error('设置 CPU 失败: ' + String(res.stderr || res.stdout || ''))
    changes.push('cpu=' + val)
  }
  if (memory !== undefined && String(memory).trim() !== '') {
    const mib = sizeToMiB(memory) || Number(memory)
    if (!(mib > 0)) throw new Error('memory 必须为正数')
    const res = await orb(['config', 'set', 'machine.' + target.name + '.memory_mib', String(mib)], { timeoutMs: 30000 })
    if (res.exitCode !== 0) throw new Error('设置内存失败: ' + String(res.stderr || res.stdout || ''))
    changes.push('memory_mib=' + mib)
  }
  if (disk !== undefined && String(disk).trim() !== '') {
    const bytes = sizeToBytes(disk) || Number(disk)
    if (!(bytes > 0)) throw new Error('disk 必须为正数')
    const res = await orb(['config', 'set', 'machine.' + target.name + '.disk_bytes', String(bytes)], { timeoutMs: 30000 })
    if (res.exitCode !== 0) throw new Error('设置磁盘失败: ' + String(res.stderr || res.stdout || ''))
    changes.push('disk_bytes=' + bytes)
  }
  if (changes.length === 0) throw new Error('至少需要指定 cpus / memory / disk 之一')
  const m = await machineStateOf(target.name)
  if (m && m.state === 'running') {
    await orb(['restart', target.name], { timeoutMs: 300000 })
    await ensureNetworkApplied(target.name)
  }
  return { ok: true, machine: target.name, changes }
}
// ---- 导入导出 ----
// D3: 分片导出(按字节切片为大镜像为小段,便于增量传输/远端上行)
function sliceFileByChunks(localPath, sliceMb, outDir) {
  const BUF = Math.max(1, Number(sliceMb) || 1024) * 1024 * 1024
  mkdirSync(outDir, { recursive: true })
  const fd = openSync(localPath, 'r')
  let size = 0
  try { size = statSync(localPath).size } catch (e) { size = 0 }
  const names = []
  try {
    let off = 0
    let idx = 0
    while (off < size) {
      const len = Math.min(BUF, size - off)
      const chunk = Buffer.alloc(len)
      readSync(fd, chunk, 0, len, off)
      const p = join(outDir, 'part-' + String(idx++).padStart(4, '0') + '.img')
      writeFileSync(p, chunk)
      names.push(p)
      off += len
    }
  } finally {
    closeSync(fd)
  }
  return { parts: names, size, sliceMb: BUF / 1024 / 1024 }
}

async function exportMachine(ctx, sessionId, machineName, outputPath, opts) {
  opts = opts || {}
  const target = machineName
    ? await resolveExistingMachineByName(ctx, sessionId, machineName)
    : await resolveDefaultMachine(ctx, sessionId)
  if (!canManage(sessionId, target.name)) throw new Error('没有权限导出(' + target.name + ')')
  const local = resolveLocalPath(ctx, outputPath)
  const base = basename(local)
  // 先导出到临时文件(切片/远端时需要),否则直接写目标
  const tmp = join(STATE_DIR, 'export-' + target.name + '-' + Date.now() + '.img')
  const res = await orb(['export', target.name, tmp], { timeoutMs: 900000 })
  if (res.exitCode !== 0) {
    try { rmSync(tmp, { force: true }) } catch (e) { /* ignore */ }
    throw new Error('orb export 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
  const dest = {}
  try {
    const sliceMb = Number(opts.sliceMb) > 0 ? Number(opts.sliceMb) : 0
    if (opts.remoteMachine) {
      const owner = ownerOfMachine(opts.remoteMachine)
      if (owner && !canExec(sessionId, opts.remoteMachine)) throw new Error('没有权限写入目标机器(' + opts.remoteMachine + ')')
      const rm = owner ? await resolveExistingMachineByName(ctx, sessionId, opts.remoteMachine) : await resolveMachineByName(ctx, sessionId, opts.remoteMachine)
      await ensureRunning(rm.name)
      const rdir = String(opts.remoteDir || '/root').replace(/\/+$/, '')
      if (sliceMb > 0) {
        const s = sliceFileByChunks(tmp, sliceMb, local + '.parts')
        for (const p of s.parts) {
          const rr = await orb(['push', '-m', rm.name, p, rdir + '/' + basename(p)], { timeoutMs: 600000 })
          if (rr.exitCode !== 0) throw new Error('推送分片失败: ' + String(rr.stderr || rr.stdout || '').slice(0, 300))
        }
        dest.type = 'machine_parts'; dest.machine = rm.name; dest.dir = rdir; dest.parts = s.parts.length
      } else {
        const rr = await orb(['push', '-m', rm.name, tmp, rdir + '/' + base], { timeoutMs: 600000 })
        if (rr.exitCode !== 0) throw new Error('推送镜像失败: ' + String(rr.stderr || rr.stdout || '').slice(0, 300))
        dest.type = 'machine'; dest.machine = rm.name; dest.path = rdir + '/' + base
      }
    } else if (sliceMb > 0) {
      const outDir = local + '.parts'
      const s = sliceFileByChunks(tmp, sliceMb, outDir)
      dest.type = 'parts'; dest.dir = outDir; dest.parts = s.parts.length; dest.sliceMb = s.sliceMb; dest.size = s.size
    } else {
      copyFileSync(tmp, local)
      dest.type = 'local'; dest.path = local
    }
  } finally {
    try { rmSync(tmp, { force: true }) } catch (e) { /* ignore */ }
  }
  return { ok: true, machine: target.name, operation: 'export', dest, merge: dest.type === 'parts' ? 'cat ' + dest.dir + '/part-*.img > out.img(供 vm_import)' : null }
}

async function importMachine(ctx, sessionId, inputPath, nameHint, distro) {
  const local = resolveLocalPath(ctx, inputPath)
  if (!existsSync(local)) throw new Error('导入文件不存在: ' + local)
  const name = sanitizeName(nameHint) || await uniqueMachineName(await sessionTitleOf(ctx, sessionId), sessionId, null)
  if (ownerOfMachine(name)) throw new Error('机器名称已存在: ' + name)
  const res = await orb(['import', '-n', name, local], { timeoutMs: 900000 })
  if (res.exitCode !== 0) throw new Error('orb import 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  const list = sessionMachines(sessionId)
  list.push({ name, distro: distro === 'alpine' ? 'alpine' : 'debian', createdAt: Date.now(), lastUsedAt: Date.now(), imported: true })
  state.machines[sessionId] = list
  saveState()
  return { ok: true, machine: name }
}

// ---- 服务发现 ----
async function discoverServices(ctx, sessionId, machineName) {
  const machines = await listMachines()
  const targets = machineName ? machines.filter((m) => m.name === machineName) : machines
  const out = []
  for (const m of targets) {
    const rec = recordOfMachine(m.name)
    const owner = rec ? rec.sessionId : null
    const item = {
      name: m.name,
      state: m.state,
      distro: m.distro,
      ip4: null,
      ip6: null,
      owner,
      tunnels: tunnelView().filter((t) => t.machine === m.name && t.status === 'running'),
      services: (state.services && state.services[m.name]) || [],
    }
    if (m.state === 'running') {
      const info = await orb(['info', '-f', 'json', m.name], { timeoutMs: 30000 })
      if (info.exitCode === 0) {
        try {
          const parsed = JSON.parse(info.stdout)
          item.ip4 = parsed.ip4 || null
          item.ip6 = parsed.ip6 || null
        } catch (e) { /* ignore */ }
      }
    }
    out.push(item)
  }
  return { ok: true, machines: out }
}
