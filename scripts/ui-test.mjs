// UI route layer test: registers all /vmsb-api routes through the real host
// apply() and invokes every route handler used by the Web tab.
// v0.3.0: reads stay GET; mutations go POST + CSRF token bound to the session.
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
  effect(fn, key) { if (key && (key.startsWith('vmsb: idle') || key.startsWith('vmsb: cron') || key.startsWith('vmsb: metrics') || key.startsWith('vmsb: state'))) return; return fn() },
}
apply(ctx)
const exec = { agent: { id: SESSION } }
const QUI = 'vuique'

async function callTool(name, args) {
  try { return { ok: true, out: await toolsMap[name].execute(args || {}, exec) } }
  catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

function driveReq(handler, req, res) {
  let status = 200
  let raw = ''
  let resolveFn
  const r = {
    setHeader: (res && res.setHeader) || (() => {}),
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(text) { raw = text; let body = {}; try { body = JSON.parse(raw) } catch (e) { /* ignore */ } resolveFn({ status, body }) },
  }
  return new Promise((resolve) => {
    resolveFn = resolve
    handler(req, r)
  })
}

function apiGet(path, params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) q.set(k, v)
  }
  const url = q.toString() ? path + '?' + q.toString() : path
  const handler = routes[path]
  if (!handler) return Promise.resolve({ status: 0, body: { ok: false, error: 'missing route ' + path } })
  return driveReq(handler, { url, method: 'GET', headers: { host: '127.0.0.1' } }, { setHeader() {} })
}

function apiPost(path, body, token) {
  const handler = routes[path]
  if (!handler) return Promise.resolve({ status: 0, body: { ok: false, error: 'missing route ' + path } })
  const headers = { 'content-type': 'application/json', host: '127.0.0.1' }
  if (token) headers['x-vmsb-token'] = token
  return driveReq(handler, { url: path, method: 'POST', headers, body }, { setHeader() {} })
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

  // CSRF token handshake (S1)
  const tok = await apiGet('/vmsb-api/token', { session: SESSION })
  const TOKEN = (tok.body && tok.body.token) || ''
  check('GET /vmsb-api/token', tok.status === 200 && !!TOKEN, tok.body)

  let r = await apiGet('/vmsb-api/list', { session: SESSION })
  check('GET /vmsb-api/list', r.status === 200 && r.body.ok === true && Array.isArray(r.body.machines), r.body)
  r = await apiGet('/vmsb-api/info', { name: QUI, session: SESSION })
  check('GET /vmsb-api/info', r.status === 200 && r.body.ok === true && r.body.name === QUI, r.body)
  r = await apiGet('/vmsb-api/shell', { name: QUI })
  check('GET /vmsb-api/shell', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/snapshots', { session: SESSION })
  check('GET /vmsb-api/snapshots', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/metrics', { machine: QUI, limit: 10 })
  check('GET /vmsb-api/metrics', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/cron', { session: SESSION })
  check('GET /vmsb-api/cron', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/templates', {})
  check('GET /vmsb-api/templates', r.status === 200 && r.body.ok === true && r.body.templates.some((t) => t.name === 'python'), r.body)
  r = await apiGet('/vmsb-api/services', { session: SESSION })
  check('GET /vmsb-api/services', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/policy', { session: SESSION })
  check('GET /vmsb-api/policy', r.status === 200 && r.body.ok === true && r.body.policy, r.body)
  r = await apiGet('/vmsb-api/network', { machine: QUI, session: SESSION })
  check('GET /vmsb-api/network', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/share', { machine: QUI, session: SESSION })
  check('GET /vmsb-api/share', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/job', { session: SESSION })
  check('GET /vmsb-api/job', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/tunnels', {})
  check('GET /vmsb-api/tunnels', r.status === 200 && r.body.ok === true, r.body)
  r = await apiGet('/vmsb-api/audit', { session: SESSION, limit: 5 })
  check('GET /vmsb-api/audit', r.status === 200 && r.body.ok === true, r.body)

  // S1: mutation endpoints must REQUIRE a token (403 without)
  r = await apiPost('/vmsb-api/delete', { name: QUI, session: SESSION })
  check('POST without token rejected (403)', r.status === 403 && r.body.ok === false, r.body)

  // snapshot create/restore/delete (POST + token)
  r = await apiPost('/vmsb-api/snapshot', { action: 'create', machine: QUI, session: SESSION, note: 'ui-test' }, TOKEN)
  const snapName = r.body && r.body.snapshot ? r.body.snapshot.name : null
  check('POST snapshot create', r.status === 200 && r.body.ok === true && !!snapName, r.body)
  r = await apiPost('/vmsb-api/snapshot', { action: 'restore', snapshot: snapName, session: SESSION }, TOKEN)
  check('POST snapshot restore', r.status === 200 && r.body.ok === true && r.body.machine === QUI, r.body)
  r = await apiPost('/vmsb-api/snapshot', { action: 'delete', snapshot: snapName, session: SESSION }, TOKEN)
  check('POST snapshot delete', r.status === 200 && r.body.ok === true, r.body)

  // network toggle (POST + token)
  r = await apiPost('/vmsb-api/network', { machine: QUI, session: SESSION, public_access: 0 }, TOKEN)
  check('POST network set', r.status === 200 && r.body.ok === true && r.body.policy.publicAccess === false, r.body)
  r = await apiPost('/vmsb-api/network', { machine: QUI, session: SESSION, public_access: 1 }, TOKEN)
  check('POST network revert', r.status === 200 && r.body.ok === true && r.body.policy.publicAccess === true, r.body)

  // share add/remove (POST + token)
  r = await apiPost('/vmsb-api/share', { action: 'add', machine: QUI, session: SESSION, session_target: 'ui-target', mode: 'exec' }, TOKEN)
  check('POST share add', r.status === 200 && r.body.ok === true && r.body.sharedWith.some((s) => s.sessionId === 'ui-target'), r.body)
  r = await apiPost('/vmsb-api/share', { action: 'remove', machine: QUI, session: SESSION, session_target: 'ui-target' }, TOKEN)
  check('POST share remove', r.status === 200 && r.body.ok === true, r.body)

  // job route list (GET read)
  r = await apiGet('/vmsb-api/job', { session: SESSION, action: 'list', limit: 5 })
  check('GET job list', r.status === 200 && r.body.ok === true, r.body)

  // error path
  r = await apiGet('/vmsb-api/info', { name: 'no-such-vm', session: SESSION })
  check('error handling', r.status === 500 && r.body.ok === false, r.body)

  // create / sleep routes (UI buttons, POST + token)
  r = await apiPost('/vmsb-api/sleep', { name: QUI, session: SESSION }, TOKEN)
  check('POST sleep', r.status === 200 && r.body.ok === true, r.body)
  r = await apiPost('/vmsb-api/start', { name: QUI, session: SESSION }, TOKEN)
  check('POST start', r.status === 200 && r.body.ok === true, r.body)
  r = await apiPost('/vmsb-api/restart', { name: QUI, session: SESSION }, TOKEN)
  check('POST restart', r.status === 200 && r.body.ok === true, r.body)

  console.log('UI_ROUTES_FAILED', failed)
} finally {
  await callTool('vm_delete', { machine: QUI }).catch(() => {})
}
