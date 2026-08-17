// Verify the v0.1.0 VM sandbox plugin surface without starting DSH.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'dsh-plugin-vm-sandbox', 'src', 'index.js')
const text = readFileSync(src, 'utf8')

const requiredTools = [
  'vm_list', 'vm_create', 'vm_exec', 'vm_delete',
  'vm_status', 'vm_start', 'vm_stop', 'vm_restart',
  'vm_snapshot', 'vm_snapshot_list', 'vm_restore', 'vm_snapshot_delete',
  'vm_upload', 'vm_download',
  'vm_port_forward', 'vm_port_forward_list', 'vm_port_forward_stop',
  'vm_job_submit', 'vm_job_list', 'vm_job_status', 'vm_job_stop', 'vm_job_output',
  'vm_audit', 'vm_share', 'vm_unshare', 'vm_policy', 'vm_network',
]

const missing = requiredTools.filter((name) => !text.includes("name: '" + name + "'"))
if (missing.length) {
  console.error('Missing tool registration:', missing.join(', '))
  process.exit(1)
}

const requiredRoutes = [
  '/vmsb-api/list', '/vmsb-api/info', '/vmsb-api/shell', '/vmsb-api/create',
  '/vmsb-api/start', '/vmsb-api/sleep', '/vmsb-api/restart', '/vmsb-api/delete',
  '/vmsb-api/audit', '/vmsb-api/jobs', '/vmsb-api/tunnels',
].filter((p) => !text.includes("'" + p + "'"))
if (requiredRoutes.length) {
  console.error('Missing routes:', requiredRoutes.join(', '))
  process.exit(1)
}

execFileSync(process.execPath, ['--check', src], { stdio: 'inherit' })
execFileSync(process.execPath, ['--check', join(root, 'dsh-plugin-vm-sandbox', 'src', 'client.js')], { stdio: 'inherit' })

console.log('[vm-sandbox] verify OK: 27 tools + host/client syntax')
