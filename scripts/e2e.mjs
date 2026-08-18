// Full E2E test for dsh-plugin-vm-sandbox v0.2.0.
// Creates temporary OrbStack VMs and exercises every host module, then cleans up.
// Run:  VMSB_SMOKE_SESSION=<sessionId> node scripts/e2e.mjs
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { apply } from '../dsh-plugin-vm-sandbox/src/index.js'

const SESSION = process.env.VMSB_SMOKE_SESSION
if (!SESSION) {
  console.error('Missing VMSB_SMOKE_SESSION env')
  process.exit(2)
}

const toolsMap = {}
const tools = { register(tool) { toolsMap[tool.name] = tool; return () => {} } }
const webServer = { register() { return () => {} } }
const ctx = {
  get(key) { if (key === 'tools') return tools; if (key === 'webServer') return webServer; return null },
  on() {},
  effect(fn, key) { if (key && (key.startsWith('vmsb: idle') || key.startsWith('vmsb: cron') || key.startsWith('vmsb: metrics'))) return; return fn() },
}
apply(ctx)
const exec = { agent: { id: SESSION } }

const Q1 = 'vq1'
const Q2 = 'vq2'
const Q3 = 'vq3'
const IMPORTED = 'vqimp'
const results = []
let failed = false

function ok(name, cond, detail) {
  results.push({ module: name, ok: !!cond, detail: detail || '' })
  if (!cond) { failed = true; console.error('FAIL', name, detail || '') }
  else console.log('PASS', name)
}

async function call(name, args) {
  try {
    const out = await toolsMap[name].execute(args || {}, exec)
    return { ok: true, out }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function cleanupAll() {
  for (const m of [Q1, Q2, Q3, IMPORTED]) {
    await call('vm_delete', { machine: m }).catch(() => {})
  }
  rmSync('.vmsb-e2e-upload.txt', { force: true })
  rmSync('.vmsb-e2e-download.txt', { force: true })
  rmSync('.vmsb-e2e-export.tar.zst', { force: true })
  rmSync('.vmsb-e2e-dir', { recursive: true, force: true })
}

try {
  // ---------- M1: vm_list ----------
  let r = await call('vm_list', {})
  ok('vm_list', r.ok && Array.isArray(r.out.machines), 'machines array')

  // ---------- M2: vm_create custom resources + init_script ----------
  r = await call('vm_create', { machine: Q1, distro: 'alpine', cpus: '1', memory: '1G', disk: '4G', init_script: 'echo qa-marker > /root/vmsb-qa-marker' })
  ok('vm_create(custom+init)', r.ok && r.out.machine === Q1 && r.out.state === 'running', r.ok ? r.out.machine : r.error)
  r = await call('vm_create', { machine: Q2, distro: 'alpine' })
  ok('vm_create(second)', r.ok && r.out.machine === Q2, r.ok ? r.out.machine : r.error)

  // ---------- M3: vm_status ----------
  r = await call('vm_status', { machine: Q1 })
  ok('vm_status', r.ok && r.out.state === 'running' && r.out.name === Q1, r.ok ? (r.out.ip4 || 'no-ip') : r.error)

  // ---------- M4: vm_exec single ----------
  r = await call('vm_exec', { machine: Q1, command: 'cat /root/vmsb-qa-marker' })
  ok('vm_exec(init check)', r.ok && r.out.exitCode === 0 && r.out.stdout.includes('qa-marker'), r.ok ? r.out.stdout.trim() : r.error)

  // ---------- M5: lifecycle ----------
  r = await call('vm_stop', { machine: Q1 })
  ok('vm_stop', r.ok && r.out.state === 'stopped', r.error)
  r = await call('vm_start', { machine: Q1 })
  ok('vm_start', r.ok && r.out.state === 'running', r.error)
  r = await call('vm_restart', { machine: Q1 })
  ok('vm_restart', r.ok && r.out.state === 'running', r.error)

  // ---------- M6: file transfer ----------
  writeFileSync('.vmsb-e2e-upload.txt', 'qa-upload-content')
  r = await call('vm_upload', { machine: Q1, local_path: '.vmsb-e2e-upload.txt', remote_path: '/root/vmsb-qa-upload.txt' })
  ok('vm_upload', r.ok, r.error)
  r = await call('vm_download', { machine: Q1, remote_path: '/root/vmsb-qa-upload.txt', local_path: '.vmsb-e2e-download.txt' })
  ok('vm_download', r.ok && existsSync('.vmsb-e2e-download.txt') && readFileSync('.vmsb-e2e-download.txt', 'utf8') === 'qa-upload-content', r.error)

  // ---------- M7: snapshot/restore/delete ----------
  r = await call('vm_snapshot', { machine: Q1, note: 'e2e' })
  const snapName = r.ok && r.out.snapshot ? r.out.snapshot.name : null
  ok('vm_snapshot', r.ok && !!snapName, r.error)
  r = await call('vm_snapshot_list', {})
  ok('vm_snapshot_list', r.ok && r.out.own.some((s) => s.name === snapName), r.error)
  r = await call('vm_restore', { snapshot: snapName })
  ok('vm_restore', r.ok && r.out.machine === Q1, r.error)
  r = await call('vm_snapshot_delete', { snapshot: snapName })
  ok('vm_snapshot_delete', r.ok, r.error)

  // ---------- M8: port forward ----------
  r = await call('vm_port_forward', { machine: Q1, vm_port: 22 })
  const tunnelId = r.ok && r.out.tunnel ? r.out.tunnel.id : null
  ok('vm_port_forward', r.ok && !!tunnelId, r.error)
  r = await call('vm_port_forward_list', {})
  ok('vm_port_forward_list', r.ok && r.out.tunnels.some((t) => t.id === tunnelId), r.error)
  r = await call('vm_port_forward_stop', { tunnel_id: tunnelId })
  ok('vm_port_forward_stop', r.ok, r.error)

  // ---------- M9: background jobs + log rotate ----------
  r = await call('vm_job_submit', { machine: Q1, command: 'echo job-start; sleep 1; echo job-done' })
  const jobId = r.ok && r.out.job ? r.out.job.id : null
  ok('vm_job_submit', r.ok && !!jobId, r.error)
  r = await call('vm_job_list', { machine: Q1 })
  ok('vm_job_list', r.ok && r.out.jobs.some((j) => j.id === jobId), r.error)
  r = await call('vm_job_status', { job_id: jobId })
  ok('vm_job_status', r.ok, r.error)
  await new Promise((resolve) => setTimeout(resolve, 1600))
  r = await call('vm_job_output', { job_id: jobId, max_bytes: 4096 })
  ok('vm_job_output', r.ok && r.out.log.includes('job-done'), r.error)
  r = await call('vm_job_log', { job_id: jobId, operation: 'rotate' })
  ok('vm_job_log(rotate)', r.ok && r.out.archived.includes('.archived'), r.error)
  r = await call('vm_job_log', { job_id: jobId, operation: 'archives' })
  ok('vm_job_log(archives)', r.ok && Array.isArray(r.out.archives), r.error)
  r = await call('vm_job_stop', { job_id: jobId })
  ok('vm_job_stop', r.ok, r.error)

  // ---------- M10: audit ----------
  r = await call('vm_audit', { machine: Q1, limit: 10 })
  ok('vm_audit', r.ok && Array.isArray(r.out.entries), r.error)

  // ---------- M11: share/unshare ----------
  r = await call('vm_share', { machine: Q1, session: 'qa-target-session', mode: 'exec' })
  ok('vm_share', r.ok && r.out.sharedWith.some((s) => s.sessionId === 'qa-target-session'), r.error)
  r = await call('vm_unshare', { machine: Q1, session: 'qa-target-session' })
  ok('vm_unshare', r.ok && r.out.sharedWith.length === 0, r.error)

  // ---------- M12: policy ----------
  r = await call('vm_policy', { max_machines: 6, idle_sleep_minutes: 30, snapshot_interval_hours: 0, snapshot_retention: 3 })
  ok('vm_policy', r.ok && r.out.policy.maxMachines === 6 && r.out.policy.snapshotRetention === 3, r.error)

  // ---------- M13: network + allowlist ----------
  r = await call('vm_network', { machine: Q1, public_access: false, internal_access: true, allowlist: ['8.8.8.8'] })
  ok('vm_network(set)', r.ok && r.out.policy.publicAccess === false && r.out.policy.allowlist.includes('8.8.8.8'), r.error)
  r = await call('vm_network', { machine: Q1 })
  ok('vm_network(status)', r.ok && r.out.policy.publicAccess === false, r.error)
  r = await call('vm_network', { machine: Q1, public_access: true, internal_access: true, allowlist: [] })
  ok('vm_network(revert)', r.ok && r.out.policy.publicAccess === true, r.error)

  // ---------- M14: cron ----------
  r = await call('vm_cron', { operation: 'add', name: 'qa-cron', machine: Q1, command: 'echo cron-ok', expr: '*/15 * * * *' })
  ok('vm_cron(add)', r.ok && !!r.out.job, r.error)
  r = await call('vm_cron', { operation: 'list' })
  ok('vm_cron(list)', r.ok && r.out.jobs.some((j) => j.id === (r.out.jobs[0] && r.out.jobs[0].id)), r.error)
  const cronId = (await call('vm_cron', { operation: 'list' })).out.jobs.find((j) => j.name === 'qa-cron').id
  r = await call('vm_cron', { operation: 'toggle', name: cronId })
  ok('vm_cron(toggle)', r.ok, r.error)
  r = await call('vm_cron', { operation: 'run', name: cronId })
  ok('vm_cron(run)', r.ok && r.out.triggered && r.out.triggered.job, r.error)
  r = await call('vm_cron', { operation: 'remove', name: cronId })
  ok('vm_cron(remove)', r.ok, r.error)

  // ---------- M15: template library ----------
  r = await call('vm_template', { operation: 'list' })
  ok('vm_template(list)', r.ok && r.out.templates.some((t) => t.name === 'python'), r.error)
  r = await call('vm_template', { operation: 'get', name: 'python' })
  ok('vm_template(get builtin)', r.ok && r.out.template.distro === 'debian', r.error)
  r = await call('vm_template', { operation: 'save', name: 'qatpl', distro: 'alpine', init_script: 'echo tpl-ok > /root/vmsb-tpl-marker' })
  ok('vm_template(save)', r.ok, r.error)
  r = await call('vm_template', { operation: 'remove', name: 'qatpl' })
  ok('vm_template(remove)', r.ok, r.error)

  // ---------- M16: vm_create with custom template ----------
  await call('vm_template', { operation: 'save', name: 'qatpl', distro: 'alpine', init_script: 'echo tpl-ok > /root/vmsb-tpl-marker' })
  r = await call('vm_create', { machine: Q3, template: 'qatpl' })
  ok('vm_create(template)', r.ok && r.out.machine === Q3, r.error)
  r = await call('vm_exec', { machine: Q3, command: 'cat /root/vmsb-tpl-marker' })
  ok('vm_template init applied', r.ok && r.out.stdout.includes('tpl-ok'), r.error)
  await call('vm_template', { operation: 'remove', name: 'qatpl' })

  // ---------- M17: vm_resize ----------
  r = await call('vm_resize', { machine: Q1, cpus: 2, memory: '1G' })
  ok('vm_resize', r.ok && r.out.changes.length >= 1, r.error)

  // ---------- M18: vm_export / vm_import ----------
  r = await call('vm_export', { machine: Q1, output_path: '.vmsb-e2e-export.tar.zst' })
  ok('vm_export', r.ok && existsSync('.vmsb-e2e-export.tar.zst'), r.error)
  r = await call('vm_import', { input_path: '.vmsb-e2e-export.tar.zst', machine: IMPORTED, distro: 'alpine' })
  ok('vm_import', r.ok && r.out.machine === IMPORTED, r.error)

  // ---------- M19: metrics ----------
  r = await call('vm_metrics', { machine: Q1, limit: 120 })
  ok('vm_metrics', r.ok && Array.isArray(r.out.metrics), r.error)

  // ---------- M20: service discovery ----------
  r = await call('vm_service_register', { machine: Q1, service: 'qa-api', port: 8080, meta: 'e2e' })
  ok('vm_service_register', r.ok && r.out.services.some((s) => s.service === 'qa-api'), r.error)
  r = await call('vm_service_discover', { machine: Q1 })
  ok('vm_service_discover', r.ok && r.out.machines.some((m) => m.name === Q1), r.error)
  r = await call('vm_service_register', { operation: 'unregister', machine: Q1, service: 'qa-api' })
  ok('vm_service_unregister', r.ok, r.error)

  // ---------- M21: multi-machine groups + fail-fast ----------
  r = await call('vm_exec', { groups: { web: [Q1], db: [Q2] }, command: 'echo group-ok', strategy: 'continue' })
  ok('vm_exec(groups continue)', r.ok && r.out.summary === '2/2 台成功' && r.out.results[0].role === 'web' && r.out.results[1].role === 'db', r.error)
  r = await call('vm_exec', { groups: { bad: [Q1], good: [Q2] }, command: 'exit 7', strategy: 'fail-fast' })
  ok('vm_exec(fail-fast)', r.ok && r.out.summary.includes('0/1') && r.out.results.length === 1, r.error || JSON.stringify(r.out))

  // ---------- M22: vm_delete ----------
  r = await call('vm_delete', { machine: IMPORTED })
  ok('vm_delete(imported)', r.ok, r.error)
  r = await call('vm_delete', { machine: Q3 })
  ok('vm_delete(template vm)', r.ok, r.error)
  r = await call('vm_delete', { machine: Q2 })
  ok('vm_delete(q2)', r.ok, r.error)
  r = await call('vm_delete', { machine: Q1 })
  ok('vm_delete(q1)', r.ok, r.error)

  console.log('E2E_RESULTS', results.length, 'FAILED', failed ? 1 : 0)
} finally {
  await cleanupAll()
  rmSync('.vmsb-e2e-upload.txt', { force: true })
  rmSync('.vmsb-e2e-download.txt', { force: true })
  rmSync('.vmsb-e2e-export.tar.zst', { force: true })
  rmSync('.vmsb-e2e-dir', { recursive: true, force: true })
}
