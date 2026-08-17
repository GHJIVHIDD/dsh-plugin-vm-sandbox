/**
 * Host loader entry for the deployment-level VM sandbox plugin.
 *
 * Migrated from the dynamic plugin (vmsb-3) to a persistent deployment
 * plugin: per-session OrbStack sandbox VMs (debian/alpine, one or MORE per
 * session when necessary), pinyin-initial naming, resource governance
 * (running cap 25, idle auto-sleep, archive/dispose cleanup), model tools
 * (vm_list/vm_create/vm_exec/vm_delete) and HTTP API routes for the client
 * panel (deployment plugins have no harness.handle/host.call private RPC,
 * so the panel talks to /vmsb-api/* routes served by this host half).
 *
 * v0.0.3 rules:
 * - The same session may create multiple VMs (vm_create always creates a
 *   fresh machine; vm_exec without `machine` reuses the session's default
 *   machine, auto-creating one only when the session has none).
 * - Global running cap raised to 25 machines.
 * - Cross-session use: vm_exec / vm_create accept a `machine` name that may
 *   point to a VM owned by another session; deletion stays owner-only.
 * - Soft per-session total cap (MAX_PER_SESSION) guards disk exhaustion.
 *
 * State lives in ~/.dsh/vm-sandbox/state.json, shared with the previous
 * dynamic incarnation; legacy single-record entries are migrated to lists.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const ORB = '/usr/local/bin/orb'
const HOME = process.env.HOME || ''
const STATE_DIR = join(HOME, '.dsh', 'vm-sandbox')
const STATE_FILE = join(STATE_DIR, 'state.json')
const PY_TABLE_FILE = join(STATE_DIR, 'pinyin-initials.json')

const MAX_RUNNING = 25
const MAX_PER_SESSION = 8
const IDLE_SLEEP_MS = 30 * 60 * 1000
const ACTIVE_WINDOW_MS = 15 * 60 * 1000
const IDLE_SWEEP_MS = 5 * 60 * 1000
const CREATE_ARGS = ['--cpus', '2', '--memory', '2G', '--disk', '16G']

// ---------- 状态持久化(与动态版共用同一文件) ----------
// 记录模型:state.machines[sessionId] = [ { name, distro, createdAt, lastUsedAt }, ... ]
// 旧版单条记录(对象)在加载时自动迁移为数组。
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
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.machines && typeof parsed.machines === 'object') {
      return { version: 2, machines: normalizeMachines(parsed.machines) }
    }
  } catch (e) { /* 缺失或损坏时使用空状态 */ }
  return { version: 2, machines: {} }
}
let state = loadStateFile()
let knownArchived = new Set()
const inFlight = new Map()
const shellLogs = new Map()
let sweeping = false

const SHELL_LOG_LIMIT = 200

function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch (e) {
    try { console.error('[vmsb] state save failed:', e && e.message || e) } catch (e2) { /* ignore */ }
  }
}

// ---------- 拼音首字母表(懒加载,缺失时优雅降级) ----------
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
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      // 注意:execFile 的 signal 不能为 null(会抛 ERR_INVALID_ARG_TYPE),仅传真 AbortSignal
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

// ---------- Shell 执行记录(仅内存,按机器名保留最近 N 条) ----------
function pushShellLog(name, entry) {
  if (!shellLogs.has(name)) shellLogs.set(name, [])
  const list = shellLogs.get(name)
  list.push(entry)
  if (list.length > SHELL_LOG_LIMIT) list.splice(0, list.length - SHELL_LOG_LIMIT)
}

function shellLogView(name) {
  return { ok: true, name, entries: shellLogs.get(name) || [] }
}

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
  if (m && m.state === 'running') return
  const res = await orb(['start', name], { timeoutMs: 300000 })
  if (res.exitCode !== 0) {
    throw new Error('orb start 失败: ' + String(res.stderr || res.stdout || '').slice(0, 300))
  }
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

// ---------- 命名:会话名称简写或调用方提示,<=8 个英文字母 ----------
// 1) 标题 ASCII 字母/数字 >=3 位时直接使用
// 2) 否则逐字取拼音首字母(汉字走拼音表,生僻字/其他字符用确定性码点字母)
// 3) 结果不足 3 位自动补齐,杜绝退化短名
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

// 调用方提示名:仅保留小写字母/数字,截断到 8 位;空则返回 ''。
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
  // 追加计数器,保证总长 <= 8(n 位数字时截断词干)
  for (let n = 1; n < 1000; n++) {
    const digits = String(n)
    const base = stem.slice(0, Math.max(3, 8 - digits.length))
    const cand = base + digits
    if (!existing.has(cand)) return cand
  }
  return (stem.slice(0, 5) + String(Date.now()).slice(-3)).slice(0, 8)
}

// ---------- 会话虚拟机(每会话可多台) ----------
function sessionMachines(sessionId) {
  const list = state.machines[sessionId]
  return Array.isArray(list) ? list : []
}

function byRecent(a, b) {
  return (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)
}

// 会话的默认机器:最近使用的机器;没有则 null。
function defaultSessionMachine(sessionId) {
  const list = sessionMachines(sessionId)
  if (list.length === 0) return null
  return list.slice().sort(byRecent)[0]
}

// 在某台机器所属会话中查找记录:{ sessionId, record },找不到则 null。
function recordOfMachine(name) {
  for (const sid of Object.keys(state.machines)) {
    const list = state.machines[sid]
    if (!Array.isArray(list)) continue
    const found = list.find((r) => r.name === name)
    if (found) return { sessionId: sid, record: found }
  }
  return null
}

// 某台机器的归属会话;未跟踪则 null。
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

// 等待机器进入 running(最多 ~30s;orb create 通常 1-3 分钟内完成)
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

// 用确定的名字创建机器并记入会话列表(调用方负责名字唯一)。
async function createMachineWithName(ctx, sessionId, name, distro, signal) {
  if (sessionMachines(sessionId).length >= MAX_PER_SESSION) {
    throw new Error('本会话虚拟机已达上限(' + MAX_PER_SESSION + ' 台),请先删除不再使用的机器')
  }
  const key = 'create:' + name
  if (inFlight.has(key)) return inFlight.get(key)
  const task = (async () => {
    const res = await orb(['create'].concat(CREATE_ARGS, [distro, name]), { timeoutMs: 900000, signal })
    if (res.exitCode !== 0) {
      throw new Error('orb create 失败 (' + String(res.exitCode) + '): ' + String(res.stderr || res.stdout || '').slice(0, 500))
    }
    const found = await waitRunning(name)
    const list = sessionMachines(sessionId)
    list.push({ name, distro, createdAt: Date.now(), lastUsedAt: Date.now() })
    state.machines[sessionId] = list
    saveState()
    await enforceRunningCap(name)
    return { name, distro, state: found ? found.state : 'starting' }
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

// 为会话创建一台新机器;hint 为可选命名提示。
async function createMachineForSession(ctx, sessionId, distro, signal, hint) {
  const title = await sessionTitleOf(ctx, sessionId)
  const name = await uniqueMachineName(title, sessionId, hint)
  return createMachineWithName(ctx, sessionId, name, distro, signal)
}

// vm_exec 无 machine 参数时的目标:会话默认机器;没有(或全部已消失)则新建。
async function ensureSessionMachine(ctx, sessionId, distro, signal) {
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
    // 记录全部失效:丢弃后新建
    delete state.machines[sessionId]
    saveState()
  }
  const rec = await createMachineForSession(ctx, sessionId, distro, signal, null)
  return { ...rec, sessionId, existing: false, crossSession: false }
}

// 按名字解析机器(支持跨会话):
// - 名字已存在(任意会话):返回它,并刷新其 lastUsedAt;
// - 不存在:为当前会话创建同名机器。
async function resolveMachineByName(ctx, sessionId, name, distro, signal) {
  const owner = ownerOfMachine(name)
  if (owner) {
    touchMachine(owner, name)
    const rec = recordOfMachine(name).record
    const m = await machineStateOf(name)
    return { name: rec.name, distro: rec.distro, state: m ? m.state : 'unknown', sessionId: owner, existing: true, crossSession: owner !== sessionId }
  }
  const rec = await createMachineWithName(ctx, sessionId, name, distro, signal)
  return { ...rec, sessionId, existing: false, crossSession: false }
}

async function deleteMachineByName(name) {
  const res = await orb(['delete', '-f', name], { timeoutMs: 180000 })
  if (res.exitCode === 0) shellLogs.delete(name)
  return res.exitCode === 0
}

// 删除指定名字的机器(任意归属)并清理状态记录。
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

// 删除某会话的全部机器(归档/会话语義删除时使用)。
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

// ---------- 资源治理:全局运行上限 + 闲置自动休眠 + 孤儿清理 ----------
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
    }
  }).sort((a, b) => a.age - b.age)
  const toSleep = []
  for (const item of ranked) {
    if (running.length - toSleep.length <= MAX_RUNNING) break
    if (item.name === excludeName) continue
    if (item.lastUsed && now - item.lastUsed < ACTIVE_WINDOW_MS) continue
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
      if (!owner) continue
      const rec = recordOfMachine(m.name).record
      const lastUsed = rec.lastUsedAt || rec.createdAt || 0
      if (now - lastUsed >= IDLE_SLEEP_MS) {
        try {
          await orb(['stop', m.name], { timeoutMs: 120000 })
          try { console.log('[vmsb] 闲置 ' + Math.round((now - lastUsed) / 60000) + ' 分钟,自动休眠 ' + m.name) } catch (e) { /* ignore */ }
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

// ---------- 归档自动清理 ----------
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
  } catch (err) { /* orb 不可用时忽略 */ }
}

// 会话被删除(dispose)时清理其机器;宿主停机也会触发 dispose,用 sessionKnown 甄别真删除
async function handleDisposed(ctx, sessionId) {
  if (!state.machines[sessionId]) return
  const wr = ctx.get('workspaceRegistry')
  if (wr && typeof wr.sessionKnown === 'function') {
    const known = await wr.sessionKnown(sessionId).catch(() => true)
    if (known) return
  }
  await removeSessionMachines(sessionId)
}

// ---------- 面板数据 ----------
async function listView(ctx, sessionId) {
  const machines = await listMachines()
  const rows = []
  for (const m of machines) {
    const owner = ownerOfMachine(m.name)
    const info = owner ? { sessionId: owner, title: await sessionTitleOf(ctx, owner) } : null
    rows.push({ ...m, owner: info, ownedByThis: !!sessionId && owner === sessionId })
  }
  const own = sessionMachines(sessionId).map((r) => ({ name: r.name, distro: r.distro }))
  return {
    ok: true,
    machines: rows,
    own,
    sessionId,
    cap: MAX_RUNNING,
    maxPerSession: MAX_PER_SESSION,
  }
}

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

    // 面板「新建」:立即返回,后台异步创建(创建耗时约 1-3 分钟)
    route('/vmsb-api/create', async (req, res) => {
      try {
        const q = queryOf(req)
        const sessionId = q.get('session') || ''
        if (!sessionId) throw new Error('缺少会话标识')
        const distro = q.get('distro') === 'alpine' ? 'alpine' : 'debian'
        const hint = sanitizeName(q.get('machine') || '')
        if (hint && ownerOfMachine(hint)) {
          const m = await machineStateOf(hint)
          sendJson(res, 200, { ok: true, machine: hint, distro, state: m ? m.state : 'unknown', existing: true })
          return
        }
        const title = await sessionTitleOf(ctx, sessionId)
        const name = await uniqueMachineName(title, sessionId, hint)
        if (sessionMachines(sessionId).length >= MAX_PER_SESSION) {
          sendJson(res, 400, { ok: false, error: '本会话虚拟机已达上限(' + MAX_PER_SESSION + ' 台),请先删除不再使用的机器' })
          return
        }
        createMachineWithName(ctx, sessionId, name, distro, null).catch((err) => {
          try { console.error('[vmsb] 面板创建机器失败', name, err) } catch (e) { /* ignore */ }
        })
        sendJson(res, 200, { ok: true, status: 'creating', machine: name, distro })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/start', async (req, res) => {
      try {
        const q = queryOf(req)
        const name = q.get('name') || ''
        if (!name) throw new Error('缺少机器名称')
        const result = await orb(['start', name], { timeoutMs: 300000 })
        if (result.exitCode !== 0) {
          throw new Error('orb start 失败: ' + String(result.stderr || result.stdout || '').slice(0, 300))
        }
        await enforceRunningCap(name)
        const owner = ownerOfMachine(name)
        if (owner) touchMachine(owner, name)
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/sleep', async (req, res) => {
      try {
        const name = queryOf(req).get('name') || ''
        if (!name) throw new Error('缺少机器名称')
        const result = await orb(['stop', name], { timeoutMs: 300000 })
        if (result.exitCode !== 0) {
          throw new Error('orb stop 失败: ' + String(result.stderr || result.stdout || '').slice(0, 300))
        }
        sendJson(res, 200, { ok: true, name })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    })

    route('/vmsb-api/delete', async (req, res) => {
      try {
        const q = queryOf(req)
        const name = q.get('name') || ''
        const sessionId = q.get('session') || ''
        if (!name) throw new Error('缺少机器名称')
        const owner = ownerOfMachine(name)
        if (owner && sessionId && owner !== sessionId) {
          throw new Error('该机器属于其他会话，不能删除')
        }
        await removeMachineByName(name)
        sendJson(res, 200, { ok: true, name })
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
      description: '列出 OrbStack 中的全部沙箱虚拟机:名称、状态(running/sleeping/stopped)、系统(debian/alpine)及归属会话。用于查看本会话的虚拟机或检查某台机器状态。返回 machines(全部机器,含归属)、own(本会话的机器数组)、cap(全局运行上限 25 台)。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        return listView(ctx, sessionIdOf(exec))
      },
    })

    registerTool({
      name: 'vm_create',
      description: '为当前会话创建一台新的沙箱虚拟机(OrbStack;默认限额 CPU 2 核 / 内存 2G / 磁盘 16G)。仅支持 debian(默认)与 alpine 两种发行版。每次调用都会创建一台新机器(同一会话必要时可创建多台),可用 machine 参数指定名称(仅小写字母/数字,<=8 位);若 machine 指定的名称已存在(含其他会话的机器)则直接返回现有机器。每会话最多 ' + MAX_PER_SESSION + ' 台,全局运行上限 25 台。创建耗时约 1-3 分钟。',
      parameters: {
        type: 'object',
        properties: {
          distro: { type: 'string', description: '发行版:debian(默认)或 alpine。', enum: ['debian', 'alpine'] },
          machine: { type: 'string', description: '可选:机器名称提示(仅小写字母/数字,<=8 位,缺省自动生成)。若该名称已存在(含其他会话的机器)则返回现有机器。' },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const distro = args && args.distro === 'alpine' ? 'alpine' : 'debian'
        const hint = sanitizeName(args && args.machine)
        if (hint && ownerOfMachine(hint)) {
          touchMachine(ownerOfMachine(hint), hint)
          const m = await machineStateOf(hint)
          return {
            machine: hint,
            distro,
            state: m ? m.state : 'unknown',
            existing: true,
            ownerSession: ownerOfMachine(hint),
            sessionMachines: sessionMachines(sessionId).map((r) => r.name),
          }
        }
        if (sessionMachines(sessionId).length >= MAX_PER_SESSION) {
          throw new Error('本会话虚拟机已达上限(' + MAX_PER_SESSION + ' 台),请先删除不再使用的机器')
        }
        const rec = await createMachineForSession(ctx, sessionId, distro, exec.signal, hint)
        return {
          machine: rec.name,
          distro: rec.distro,
          state: rec.state,
          existing: false,
          sessionMachines: sessionMachines(sessionId).map((r) => r.name),
        }
      },
    })

    registerTool({
      name: 'vm_exec',
      description: '在沙箱虚拟机中执行 shell 命令(以 root 身份,sh -lc)。省略 machine 时使用当前会话的默认虚拟机(本会话没有任何机器时自动创建一台,debian 默认,可选 alpine)。传入 machine 名称可指定任意已存在的机器,包括其他会话的虚拟机(必要情况下跨会话使用),或指定一个新名称来创建该名称的机器;省略 machine 时不创建重复机器。与本地 macOS 系统无关的命令(安装、构建、运行服务、网络实验、沙箱内文件操作等)请优先使用本工具。返回 stdout/stderr/exitCode。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在虚拟机内执行的 shell 命令。' },
          machine: { type: 'string', description: '可选:目标机器名称(仅小写字母/数字,<=8 位)。省略时使用本会话默认机器;指定其他会话的机器时跨会话执行;指定不存在的新名称则先创建该名称的机器再执行。' },
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
        const target = machineName
          ? await resolveMachineByName(ctx, sessionId, machineName, distro, exec.signal)
          : await ensureSessionMachine(ctx, sessionId, distro, exec.signal)
        await ensureRunning(target.name)
        await enforceRunningCap(target.name)
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
      },
    })

    registerTool({
      name: 'vm_delete',
      description: '删除虚拟机(永久删除,数据不保留)。省略 machine 时删除当前会话最近的默认机器;传入 machine 名称可删除本会话指定的机器(其他会话的机器不能删除)。归档或删除会话的虚拟机由系统自动清理。',
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
        if (name) {
          const owner = ownerOfMachine(name)
          if (owner && owner !== sessionId) throw new Error('该机器属于其他会话，不能删除')
          const removed = await removeMachineByName(name)
          return { ok: removed, machine: name, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
        }
        const def = defaultSessionMachine(sessionId)
        if (!def) return { ok: false, machine: null, reason: '本会话没有虚拟机' }
        const removed = await removeMachineByName(def.name)
        return { ok: removed, machine: def.name, sessionMachines: sessionMachines(sessionId).map((r) => r.name) }
      },
    })
  }

  try { console.log('[vmsb] VM sandbox deployment plugin ready (v0.0.3, cap ' + MAX_RUNNING + ', max-per-session ' + MAX_PER_SESSION + ')') } catch (e) { /* ignore */ }
}

export { apply }
export const inject = ['webServer', 'tools']