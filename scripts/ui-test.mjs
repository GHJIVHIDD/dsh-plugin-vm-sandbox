// UI route layer test: registers all /vmsb-api routes through the real host
// apply() and invokes every route handler used by the Web tab.
import { apply } from '../dsh-plugin-vm-sandbox/src/index.js'

const SESSION = process.env.VMSB_SMOKE_SESSION
if (!SESSION) {
  console.error('Missing VMSB_SMOKE_SESSION env')
  process.exit(2)
}

const toolsMap = {}
const routes = {}
const tools = { register(tool) { toolsMap[tool.name] = tool; return () => {} } }
const webServer = { register(route) { routes[route.path] = route.handler; return () => {} } }
const ctx = {
  get(key) { if (key === 'tools') return tools; if (key === 'webServer') return webServer; return null },
  on() {},
  effect(fn, key) { if (key && (key.startsWith('vmsb: idle') || key.startsWith('vmsb: cron') || key.startsWith('vmsb: metrics'))) return; return fn() },
}
apply(ctx)
const exec = { agent: { id: SESSION } }
const QUI = 'vuique'

async function callTool(name, args) {
  try { return { ok: true, out: await toolsMap[name].execute(args || {}, exec) } }
  catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

function api(path, params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) q.set(k, v)
  }
  const url = q.toString() ? path + '?' + q.toString() : path
  const handler = routes[path]
  if (!handler) return Promise.resolve({ status: 0, body: { ok: false, error: 'missing route ' + path } })
  return new Promise((resolve) => {
    let status = 200
    let raw = ''
    const req = { url }
    const res = {
      setHeader() {},
      set statusCode(v) { status = v },
      get statusCode() { return status },
      end(text) { raw = text; let body = {}; try { body = JSON.parse(raw) } catch (e) { /* ignore */ } resolve({ status, body }) },
    }
    handler(req, res)
  })
}

let failed = 0
function check(name, cond, detail) {
  if (!cond) { failed++; console.error('FAIL', name, detail) }
  else console.log('PASS', name)
}

try {
  // create one VM for stateful routes
  const cr = await callTool('vm_create', { machine: QUI, distro: 'alpine' })
  check('setup vm', cr.ok, cr.error)

  let r = await api('/vmsb-api/list', { session: SESSION })
  check('GET /vmsb-api/list', r.status === 200 && r.body.ok === true && Array.isArray(r.body.machines), r.body)
  r = await api('/vmsb-api/info', { name: QUI, session: SESSION })
  check('GET /vmsb-api/info', r.status === 200 && r.body.ok === true && r.body.name === QUI, r.body)
  r = await api('/vmsb-api/shell', { name: QUI })
  check('GET /vmsb-api/shell', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/snapshots', { session: SESSION })
  check('GET /vmsb-api/snapshots', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/metrics', { machine: QUI, limit: 10 })
  check('GET /vmsb-api/metrics', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/cron', { session: SESSION })
  check('GET /vmsb-api/cron', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/templates', {})
  check('GET /vmsb-api/templates', r.status === 200 && r.body.ok === true && r.body.templates.some((t) => t.name === 'python'), r.body)
  r = await api('/vmsb-api/services', { session: SESSION })
  check('GET /vmsb-api/services', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/policy', { session: SESSION })
  check('GET /vmsb-api/policy', r.status === 200 && r.body.ok === true && r.body.policy, r.body)
  r = await api('/vmsb-api/network', { machine: QUI, session: SESSION })
  check('GET /vmsb-api/network', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/share', { machine: QUI, session: SESSION })
  check('GET /vmsb-api/share', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/job', { session: SESSION })
  check('GET /vmsb-api/job', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/tunnels', {})
  check('GET /vmsb-api/tunnels', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/audit', { session: SESSION, limit: 5 })
  check('GET /vmsb-api/audit', r.status === 200 && r.body.ok === true, r.body)

  // snapshot create/restore/delete
  r = await api('/vmsb-api/snapshot', { action: 'create', machine: QUI, session: SESSION, note: 'ui-test' })
  const snapName = r.body && r.body.snapshot ? r.body.snapshot.name : null
  check('POST snapshot create', r.status === 200 && r.body.ok === true && !!snapName, r.body)
  r = await api('/vmsb-api/snapshot', { action: 'restore', snapshot: snapName, session: SESSION })
  check('POST snapshot restore', r.status === 200 && r.body.ok === true && r.body.machine === QUI, r.body)
  r = await api('/vmsb-api/snapshot', { action: 'delete', snapshot: snapName, session: SESSION })
  check('POST snapshot delete', r.status === 200 && r.body.ok === true, r.body)

  // network toggle
  r = await api('/vmsb-api/network', { machine: QUI, session: SESSION, public_access: 0 })
  check('POST network set', r.status === 200 && r.body.ok === true && r.body.policy.publicAccess === false, r.body)
  r = await api('/vmsb-api/network', { machine: QUI, session: SESSION, public_access: 1 })
  check('POST network revert', r.status === 200 && r.body.ok === true && r.body.policy.publicAccess === true, r.body)

  // share add/remove
  r = await api('/vmsb-api/share', { action: 'add', machine: QUI, session: SESSION, session_target: 'ui-target', mode: 'exec' })
  check('POST share add', r.status === 200 && r.body.ok === true && r.body.sharedWith.some((s) => s.sessionId === 'ui-target'), r.body)
  r = await api('/vmsb-api/share', { action: 'remove', machine: QUI, session: SESSION, session_target: 'ui-target' })
  check('POST share remove', r.status === 200 && r.body.ok === true, r.body)

  // job route list
  r = await api('/vmsb-api/job', { session: SESSION, action: 'list', limit: 5 })
  check('GET job list', r.status === 200 && r.body.ok === true, r.body)

  // error path
  r = await api('/vmsb-api/info', { name: 'no-such-vm', session: SESSION })
  check('error handling', r.status === 500 && r.body.ok === false, r.body)

  // create / sleep routes (UI buttons)
  r = await api('/vmsb-api/sleep', { name: QUI, session: SESSION })
  check('POST sleep', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/start', { name: QUI, session: SESSION })
  check('POST start', r.status === 200 && r.body.ok === true, r.body)
  r = await api('/vmsb-api/restart', { name: QUI, session: SESSION })
  check('POST restart', r.status === 200 && r.body.ok === true, r.body)

  console.log('UI_ROUTES_FAILED', failed)
} finally {
  await callTool('vm_delete', { machine: QUI }).catch(() => {})
}
