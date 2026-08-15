// Prepare script for @deepseek-ai/dsh-plugin-vm-sandbox.
// Git installs fetch source and run `prepare`; this builds lib/ from src/.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

const required = ['index.js', 'client.js']
const missing = required.filter((file) => existsSync(join(srcDir, file)) === false)
if (missing.length > 0) {
  console.error(`[dsh-plugin-vm-sandbox] prepare failed: missing src/${missing.join(', src/')}`)
  process.exit(1)
}

rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })
cpSync(srcDir, libDir, { recursive: true })

console.log('[dsh-plugin-vm-sandbox] prepare: built lib/ from src/')
