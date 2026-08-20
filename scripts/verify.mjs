// Verify the v0.1.0 VM sandbox plugin surface without starting DSH.
// It loads the real host module, registers all tools through the same plugin
// entry point, and asserts the required tool schemas/parameters exist.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../dsh-plugin-vm-sandbox/src/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'dsh-plugin-vm-sandbox', 'src', 'index.js')

const toolsMap = {}
const tools = {
  register(tool) {
    toolsMap[tool.name] = tool
    return () => {}
  },
}
const webServer = {
  register() {
    return () => {}
  },
}
const ctx = {
  get(key) {
    if (key === 'tools') return tools
    if (key === 'webServer') return webServer
    return null
  },
  on() {},
  effect(fn, key) {
    // Do not start real interval sweeps during verification.
    if (key && (key.startsWith('vmsb: idle') || key.startsWith('vmsb: cron') || key.startsWith('vmsb: metrics'))) return
    return fn()
  },
}

apply(ctx)

const requiredTools = [
  'vm_list', 'vm_create', 'vm_exec', 'vm_delete',
  'vm_status', 'vm_start', 'vm_stop', 'vm_restart',
  'vm_snapshot', 'vm_snapshot_list', 'vm_restore', 'vm_snapshot_delete',
  'vm_upload', 'vm_download',
  'vm_port_forward', 'vm_port_forward_list', 'vm_port_forward_stop',
  'vm_job_submit', 'vm_job_list', 'vm_job_status', 'vm_job_stop', 'vm_job_output', 'vm_job_log',
  'vm_audit', 'vm_share', 'vm_unshare', 'vm_policy', 'vm_network',
  'vm_cron', 'vm_template', 'vm_resize', 'vm_metrics', 'vm_export', 'vm_import',
  'vm_service_discover', 'vm_service_register',
  'vm_harden', 'vm_secret', 'vm_alert',
  'vm_scp', 'vm_logs', 'vm_env', 'vm_withdraw', 'vm_queue', 'vm_report',
]

const missing = requiredTools.filter((name) => !toolsMap[name])
if (missing.length) {
  console.error('Missing tools:', missing.join(', '))
  process.exit(1)
}

const requiredParams = {
  vm_create: ['cpus', 'memory', 'disk', 'init_script', 'cloud_init', 'isolated', 'isolate_network', 'template', 'harden', 'queue'],
  vm_exec: ['machines', 'groups', 'strategy'],
  vm_snapshot: ['machine', 'note'],
  vm_restore: ['snapshot'],
  vm_snapshot_delete: ['snapshot'],
  vm_upload: ['local_path', 'remote_path'],
  vm_download: ['remote_path', 'local_path'],
  vm_port_forward: ['vm_port', 'host_port', 'bind_host'],
  vm_job_submit: ['command'],
  vm_job_status: ['job_id'],
  vm_job_log: ['job_id', 'operation', 'max_bytes'],
  vm_job_stop: ['job_id'],
  vm_audit: ['machine', 'operation', 'limit'],
  vm_share: ['machine', 'session', 'mode'],
  vm_network: ['public_access', 'internal_access', 'isolated', 'isolate_network'],
  vm_policy: ['max_machines', 'idle_sleep_minutes', 'idle_delete_days', 'snapshot_interval_hours', 'snapshot_retention', 'cpu_quota', 'memory_quota'],
  vm_cron: ['operation', 'machine', 'command', 'expr'],
  vm_template: ['operation', 'name', 'init_script', 'cloud_init'],
  vm_resize: ['machine', 'cpus', 'memory', 'disk'],
  vm_metrics: ['machine', 'limit'],
  vm_export: ['machine', 'output_path'],
  vm_import: ['machine', 'input_path'],
  vm_service_discover: ['machine'],
  vm_service_register: ['machine', 'service'],
  vm_network: ['public_access', 'internal_access', 'isolated', 'isolate_network', 'allowlist'],
  vm_harden: ['operation', 'machine'],
  vm_secret: ['operation', 'name', 'value'],
  vm_alert: ['operation', 'name', 'metric', 'op', 'value'],
  vm_scp: ['direction', 'machines', 'files', 'local_path', 'remote_path'],
  vm_logs: ['machine', 'job_id', 'limit', 'max_bytes'],
  vm_env: ['operation', 'name', 'value'],
  vm_withdraw: ['machine', 'keep_snapshot', 'note'],
  vm_queue: ['operation', 'queue_id'],
  vm_report: ['machine'],
}

const failures = []
for (const [toolName, params] of Object.entries(requiredParams)) {
  const tool = toolsMap[toolName]
  const props = tool && tool.parameters && tool.parameters.properties ? Object.keys(tool.parameters.properties) : []
  for (const p of params) {
    if (!props.includes(p)) failures.push(`${toolName}.${p}`)
  }
}

if (failures.length) {
  console.error('Missing tool parameters:', failures.join(', '))
  process.exit(1)
}

execFileSync(process.execPath, ['--check', src], { stdio: 'inherit' })
execFileSync(process.execPath, ['--check', join(root, 'dsh-plugin-vm-sandbox', 'src', 'client.js')], { stdio: 'inherit' })

console.log(`[vm-sandbox] verify OK: ${requiredTools.length} tools, host/client syntax, parameter schemas`)
