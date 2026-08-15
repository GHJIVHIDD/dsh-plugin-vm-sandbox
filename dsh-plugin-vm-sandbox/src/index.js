/**
 * Host loader entry for the deployment-level VM sandbox plugin.
 *
 * Migrated from the dynamic plugin (vmsb-3) to a persistent deployment
 * plugin: per-session OrbStack sandbox VMs (debian/alpine, one per session),
 * pinyin-initial naming, resource governance (running cap, idle auto-sleep,
 * archive/dispose cleanup), model tools (vm_list/vm_create/vm_exec/vm_delete)
 * and HTTP API routes for the client panel (deployment plugins have no
 * harness.handle/host.call private RPC, so the panel talks to
 * /vmsb-api/* routes served by this host half).
 *
 * State lives in ~/.dsh/vm-sandbox/state.json, shared with the previous
 * dynamic incarnation, so existing machines keep their ownership.
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

const MAX_RUNNING = 5
const IDLE_SLEEP_MS = 30 * 60 * 1000
const ACTIVE_WINDOW_MS = 15 * 60 * 1000
const IDLE_SWEEP_MS = 5 * 60 * 1000
const CREATE_ARGS = ['--cpus', '2', '--memory', '2G', '--disk', '16G']

// ---------- 状态持久化(与动态版共用同一文件) ----------
function loadStateFile() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.machines && typeof parsed.machines === 'object') {
      return { version: 1, machines: parsed.machines }
    }
  } catch (e) { /* 缺失或损坏时使用空状态 */ }
  return { version: 1, machines: {} }
}
let state = loadStateFile()
let knownArchived = new Set()
const inFlight = new Map()
let sweeping = false

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
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
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

async function ensureRunning(name) {
  let machines = []
  try {
    machines = await listMachines()
  } catch (err) { /* 继续尝试启动 */ }
  const m = machines.find((x) => x.name === name)
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

// ---------- 命名:会话名称简写,<=8 个英文字母 ----------
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

async function uniqueMachineName(title, sessionId) {
  let existing = new Set()
  try {
    existing = new Set((await listMachines()).map((m) => m.name))
  } catch (err) { /* 忽略 */ }
  const full = abbreviate(title, sessionId)
  if (full && !existing.has(full)) return full
  const suffix = String(sessionId || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 2) || 'vm'
  const base = full.slice(0, 6)
  for (let n = 0; n < 100; n++) {
    const cand = (base + suffix + (n === 0 ? '' : String(n))).slice(0, 8)
    if (!existing.has(cand)) return cand
  }
  return (base + String(Date.now()).slice(-3)).slice(0, 8)
}

// ---------- 会话虚拟机(每会话一台) ----------
async function getSessionMachine(sessionId) {
  const rec = state.machines[sessionId]
  if (!rec) return null
  let machines = []
  try {
    machines = await listMachines()
  } catch (err) {
    return { ...rec, state: 'unknown' }
  }
  const m = machines.find((x) => x.name === rec.name)
  if (!m) {
    delete state.machines[sessionId]
    saveState()
    return null
  }
  return { ...rec, state: m.state }
}

function touchMachine(sessionId) {
  const rec = state.machines[sessionId]
  if (!rec) return
  rec.lastUsedAt = Date.now()
  saveState()
}

async function ensureSessionMachine(ctx, sessionId, distro, signal) {
  const existing = await getSessionMachine(sessionId)
  if (existing) {
    touchMachine(sessionId)
    return existing
  }
  const key = 'create:' + sessionId
  if (inFlight.has(key)) return inFlight.get(key)
  const task = (async () => {
    const title = await sessionTitleOf(ctx, sessionId)
    const name = await uniqueMachineName(title, sessionId)
    const res = await orb(['create'].concat(CREATE_ARGS, [distro, name]), { timeoutMs: 900000, signal })
    if (res.exitCode !== 0) {
      throw new Error('orb create 失败 (' + String(res.exitCode) + '): ' + String(res.stderr || res.stdout || '').slice(0, 500))
    }
    let machines = []
    for (let i = 0; i < 15; i++) {
      try {
        machines = await listMachines()
        if (machines.some((m) => m.name === name && m.state === 'running')) break
      } catch (err) { /* 重试 */ }
      await sleep(2000)
    }
    const rec = { name, distro, createdAt: Date.now(), lastUsedAt: Date.now() }
    state.machines[sessionId] = rec
    saveState()
    await enforceRunningCap(name)
    const found = machines.find((m) => m.name === name)
    return { ...rec, state: found ? found.state : 'starting' }
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

async function deleteMachineByName(name) {
  const res = await orb(['delete', '-f', name], { timeoutMs: 180000 })
  return res.exitCode === 0
}

async function removeSessionMachine(sessionId) {
  const rec = state.machines[sessionId]
  if (!rec) return false
  try {
    await deleteMachineByName(rec.name)
  } catch (err) {
    try { console.error('[vmsb] 删除机器失败', err) } catch (e) { /* ignore */ }
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
    let owner = null
    for (const sid of Object.keys(state.machines)) {
      if (state.machines[sid].name === m.name) { owner = sid; break }
    }
    const rec = owner ? state.machines[owner] : null
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
      let owner = null
      for (const sid of Object.keys(state.machines)) {
        if (state.machines[sid].name === m.name) { owner = sid; break }
      }
      if (!owner) continue
      const rec = state.machines[owner]
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
    // 孤儿清理:会话已不存在(被删除)且未归档 -> 删除机器
    for (const sid of Object.keys(state.machines)) {
      if (archived.has(sid)) continue
      if (wr && typeof wr.sessionKnown === 'function') {
        const known = await wr.sessionKnown(sid).catch(() => true)
        if (!known) {
          try { console.log('[vmsb] 会话已删除,清理机器 ' + state.machines[sid].name) } catch (e) { /* ignore */ }
          await removeSessionMachine(sid)
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
    await removeSessionMachine(id)
  }
  try {
    const machines = await listMachines()
    const names = new Set(machines.map((m) => m.name))
    let changed = false
    for (const sid of Object.keys(state.machines)) {
      if (!names.has(state.machines[sid].name)) {
        delete state.machines[sid]
        changed = true
      }
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
  await removeSessionMachine(sessionId)
}

// ---------- 面板数据 ----------
async function listView(ctx, sessionId) {
  const machines = await listMachines()
  const rows = []
  for (const m of machines) {
    let owner = null
    for (const sid of Object.keys(state.machines)) {
      if (state.machines[sid].name === m.name) { owner = sid; break }
    }
    const info = owner ? { sessionId: owner, title: await sessionTitleOf(ctx, owner) } : null
    rows.push({ ...m, owner: info, ownedByThis: !!sessionId && owner === sessionId })
  }
  const own = sessionId ? (state.machines[sessionId] || null) : null
  return { ok: true, machines: rows, own, sessionId }
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
  let owner = null
  for (const sid of Object.keys(state.machines)) {
    if (state.machines[sid].name === name) { owner = sid; break }
  }
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
        removeSessionMachine(id).catch((err) => {
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
        for (const sid of Object.keys(state.machines)) {
          if (state.machines[sid].name === name) {
            touchMachine(sid)
            break
          }
        }
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
        let owner = null
        for (const sid of Object.keys(state.machines)) {
          if (state.machines[sid].name === name) { owner = sid; break }
        }
        if (owner && sessionId && owner !== sessionId) {
          throw new Error('该机器属于其他会话，不能删除')
        }
        await deleteMachineByName(name)
        if (owner) {
          delete state.machines[owner]
          saveState()
        }
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
      description: '列出 OrbStack 中的全部沙箱虚拟机:名称、状态(running/sleeping/stopped)、系统(debian/alpine)及归属会话。用于查看本会话的虚拟机或检查某台机器状态。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        return listView(ctx, sessionIdOf(exec))
      },
    })

    registerTool({
      name: 'vm_create',
      description: '为当前会话创建专属沙箱虚拟机(OrbStack,每会话一台;默认限额 CPU 2 核 / 内存 2G / 磁盘 16G)。仅支持 debian(默认)与 alpine 两种发行版。若本会话已有虚拟机则直接返回现有机器。创建耗时约 1-3 分钟。',
      parameters: {
        type: 'object',
        properties: {
          distro: { type: 'string', description: '发行版:debian(默认)或 alpine。', enum: ['debian', 'alpine'] },
        },
      },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const distro = args && args.distro === 'alpine' ? 'alpine' : 'debian'
        const rec = await ensureSessionMachine(ctx, sessionId, distro, exec.signal)
        return { machine: rec.name, distro: rec.distro, state: rec.state, existing: !!state.machines[sessionId] }
      },
    })

    registerTool({
      name: 'vm_exec',
      description: '在当前会话的沙箱虚拟机中执行 shell 命令(以 root 身份,sh -lc)。若本会话还没有虚拟机会自动创建一台(debian 默认,可选 alpine)。与本地 macOS 系统无关的命令(安装、构建、运行服务、网络实验、沙箱内文件操作等)请优先使用本工具。返回 stdout/stderr/exitCode。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要在虚拟机内执行的 shell 命令。' },
          distro: { type: 'string', description: '首次创建虚拟机时使用的发行版:debian(默认)或 alpine;已有虚拟机时忽略。', enum: ['debian', 'alpine'] },
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
        const rec = await ensureSessionMachine(ctx, sessionId, distro, exec.signal)
        await ensureRunning(rec.name)
        await enforceRunningCap(rec.name)
        const run = await orb(['run', '-m', rec.name, '-u', 'root', 'sh', '-lc', command], { timeoutMs, signal: exec.signal })
        return {
          machine: rec.name,
          distro: rec.distro,
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
        }
      },
    })

    registerTool({
      name: 'vm_delete',
      description: '删除当前会话的沙箱虚拟机(永久删除,数据不保留)。归档或删除会话的虚拟机由系统自动清理。',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) throw new Error('无法确定当前会话')
        const removed = await removeSessionMachine(sessionId)
        return { ok: removed }
      },
    })
  }

  try { console.log('[vmsb] VM sandbox deployment plugin ready') } catch (e) { /* ignore */ }
}

export { apply }
export const inject = ['webServer', 'tools']
