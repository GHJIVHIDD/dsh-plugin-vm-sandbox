// Root prepare script for GitHub source installs.
// The repository root is the installable bundle; lib/ lives under
// dsh-plugin-vm-sandbox/lib and is generated from src/.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDir = join(root, 'dsh-plugin-vm-sandbox')
const srcDir = join(pkgDir, 'src')
const libDir = join(pkgDir, 'lib')

const required = ['index.js', 'client.js']
const missing = required.filter((file) => existsSync(join(srcDir, file)) === false)
if (missing.length > 0) {
  console.error(`[dsh-plugin-vm-sandbox] prepare failed: missing ${missing.map((f) => `dsh-plugin-vm-sandbox/src/${f}`).join(', ')}`)
  process.exit(1)
}

rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })
cpSync(srcDir, libDir, { recursive: true })

console.log('[dsh-plugin-vm-sandbox] prepare: built dsh-plugin-vm-sandbox/lib/ from src/')
