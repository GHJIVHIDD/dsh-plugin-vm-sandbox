// Integration smoke test for dsh-plugin-vm-sandbox v0.1.0.
// It creates a temporary OrbStack VM through the plugin and exercises every
// major feature: create+init, lifecycle, file transfer, snapshot/restore,
// port forward, background jobs, network policy, share/unshare and audit.
// Run:  VMSB_SMOKE_SESSION=session-... node scripts/smoke.mjs
// Cleanup is automatic; a VM named "vmsbsmoke" is created and deleted.
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { apply } from '../dsh-plugin-vm-sandbox/src/index.js'

const SESSION = process.env.VMSB_SMOKE_SESSION
if (!SESSION) {
  console.error('Missing VMSB_SMOKE_SESSION env; use the current DSH session id.')
  process.exit(2)
}

const toolsMap = {}
const tools = {
  register(tool) {
    toolsMap[tool.name] = tool
    return () => {}
  },
}
const webServer = { register() { return () => {} } }
const ctx = {
  get(key) { if (key === 'tools') return tools; if (key === 'webServer') return webServer; return null },
  on() {},
  effect(fn, key) { if (key && key.startsWith('vmsb: idle')) return; return fn() },
}
apply(ctx)

const exec = { agent: { id: SESSION } }
const MACHINE = 'vmsbsmk'
const REMOTE_FILE = '/root/vmsb-smoke.txt'
const LOCAL_FILE = '.vmsb-smoke-local.txt'
const DOWNLOAD_FILE = '.vmsb-smoke-download.txt'
const LOCAL_DIR = '.vmsb-smoke-dir'
const REMOTE_DIR = '/root/vmsb-smoke-dir'

async function call(name, args) {
  try {
    const out = await toolsMap[name].execute(args || {}, exec)
    return { ok: true, out }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error('SMOKE FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  try {
    // 1. create with custom resources + init script
    const created = await call('vm_create', {
      machine: MACHINE,
      distro: 'alpine',
      cpus: '1',
      memory: '1G',
      disk: '4G',
      init_script: 'echo smoke-marker > /root/vmsb-smoke-marker',
    })
    assert(created.ok && created.out.machine === MACHINE, 'vm_create')
    console.log('create ok:', created.out.state)

    // 2. init marker
    const init = await call('vm_exec', { machine: MACHINE, command: 'cat /root/vmsb-smoke-marker' })
    assert(init.ok && init.out.stdout.includes('smoke-marker'), 'init_script')

    // 3. lifecycle + status
    const started = await call('vm_start', { machine: MACHINE })
    assert(started.ok, 'vm_start')
    const stopped = await call('vm_stop', { machine: MACHINE })
    assert(stopped.ok, 'vm_stop')
    const restarted = await call('vm_restart', { machine: MACHINE })
    assert(restarted.ok, 'vm_restart')
    const status = await call('vm_status', { machine: MACHINE })
    assert(status.ok && status.out.state === 'running', 'vm_status')

    // 4. file transfer (local paths must stay under workspace root)
    writeFileSync(LOCAL_FILE, 'smoke-upload-content')
    const up = await call('vm_upload', { machine: MACHINE, local_path: LOCAL_FILE, remote_path: REMOTE_FILE })
    assert(up.ok, 'vm_upload')
    const down = await call('vm_download', { machine: MACHINE, remote_path: REMOTE_FILE, local_path: DOWNLOAD_FILE })
    assert(down.ok && existsSync(DOWNLOAD_FILE) && readFileSync(DOWNLOAD_FILE, 'utf8') === 'smoke-upload-content', 'vm_download')
    console.log('file transfer ok')

    // 5. snapshot / list / restore / delete snapshot
    const snap = await call('vm_snapshot', { machine: MACHINE, note: 'smoke' })
    assert(snap.ok && snap.out.snapshot && snap.out.snapshot.name, 'vm_snapshot')
    const snapName = snap.out.snapshot.name
    const snapList = await call('vm_snapshot_list', {})
    assert(snapList.ok && snapList.out.own.some((s) => s.name === snapName), 'vm_snapshot_list')
    const restored = await call('vm_restore', { snapshot: snapName })
    assert(restored.ok && restored.out.machine === MACHINE, 'vm_restore')
    const snapDel = await call('vm_snapshot_delete', { snapshot: snapName })
    assert(snapDel.ok, 'vm_snapshot_delete')
    console.log('snapshot/restore ok')

    // 6. port forward
    const port = await call('vm_port_forward', { machine: MACHINE, vm_port: 22 })
    assert(port.ok && port.out.tunnel && port.out.tunnel.pid, 'vm_port_forward')
    const portList = await call('vm_port_forward_list', {})
    assert(portList.ok && portList.out.tunnels.some((t) => t.id === port.out.tunnel.id), 'vm_port_forward_list')
    const portStop = await call('vm_port_forward_stop', { tunnel_id: port.out.tunnel.id })
    assert(portStop.ok, 'vm_port_forward_stop')
    console.log('port forward ok')

    // 7. background jobs
    const job = await call('vm_job_submit', { machine: MACHINE, command: 'echo job-ok; sleep 1; echo job-done' })
    assert(job.ok && job.out.job && job.out.job.id, 'vm_job_submit')
    const jobId = job.out.job.id
    const jobList = await call('vm_job_list', { machine: MACHINE })
    assert(jobList.ok && jobList.out.jobs.some((j) => j.id === jobId), 'vm_job_list')
    const jobOut = await call('vm_job_output', { job_id: jobId })
    assert(jobOut.ok && jobOut.out.log.includes('job-ok'), 'vm_job_output')
    const jobStop = await call('vm_job_stop', { job_id: jobId })
    assert(jobStop.ok, 'vm_job_stop')
    console.log('background job ok')

    // 8. network policy set + revert
    const net = await call('vm_network', { machine: MACHINE, public_access: false, internal_access: true })
    assert(net.ok && net.out.policy && net.out.policy.publicAccess === false, 'vm_network set')
    const netBack = await call('vm_network', { machine: MACHINE, public_access: true, internal_access: true })
    assert(netBack.ok && netBack.out.policy.publicAccess === true, 'vm_network revert')
    console.log('network policy ok')

    // 9. share / unshare
    const share = await call('vm_share', { machine: MACHINE, session: 'smoke-target-session', mode: 'exec' })
    assert(share.ok && share.out.sharedWith.some((s) => s.sessionId === 'smoke-target-session'), 'vm_share')
    const unshare = await call('vm_unshare', { machine: MACHINE, session: 'smoke-target-session' })
    assert(unshare.ok && unshare.out.sharedWith.length === 0, 'vm_unshare')
    console.log('share/unshare ok')

    // 10. audit
    const audit = await call('vm_audit', { machine: MACHINE, limit: 10 })
    assert(audit.ok && audit.out.entries.length >= 1, 'vm_audit')
    console.log('audit ok')

    // 11. multi-machine? create second temp machine just for parallel exec
    const second = await call('vm_create', { machine: MACHINE + '2', distro: 'alpine' })
    assert(second.ok, 'second vm_create')
    const multi = await call('vm_exec', { machines: [MACHINE, MACHINE + '2'], command: 'echo parallel-ok' })
    assert(multi.ok && multi.out.parallel && multi.out.summary === '2/2 台成功', 'vm_exec machines')
    await call('vm_delete', { machine: MACHINE + '2' })
    console.log('parallel exec ok')

    // cleanup
    await call('vm_delete', { machine: MACHINE })
    rmSync(LOCAL_FILE, { force: true })
    rmSync(DOWNLOAD_FILE, { force: true })
    rmSync(LOCAL_DIR, { recursive: true, force: true })
    console.log('SMOKE OK')
  } catch (e) {
    console.error('SMOKE ERROR:', e)
    // Best-effort cleanup
    await call('vm_delete', { machine: MACHINE })
    await call('vm_delete', { machine: MACHINE + '2' })
    rmSync(LOCAL_FILE, { force: true })
    rmSync(DOWNLOAD_FILE, { force: true })
    rmSync(LOCAL_DIR, { recursive: true, force: true })
    process.exit(1)
  }
}

main()
