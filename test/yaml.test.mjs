// 单元测试:模板的简单 YAML 解析 (R5 骨架)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'vmsb-test-'))
const { __vmsb } = await import('../dsh-plugin-vm-sandbox/src/index.js')
const { parseSimpleYaml } = __vmsb

test('parseSimpleYaml: 顶层键值', () => {
  const out = parseSimpleYaml('name: demo\ndistro: debian\n')
  assert.equal(out.name, 'demo')
  assert.equal(out.distro, 'debian')
})

test('parseSimpleYaml: 多行 init_script 折叠', () => {
  const out = parseSimpleYaml('name: demo\ndistro: alpine\ninit_script:\n  echo hi\n  echo bye\n')
  assert.equal(out.name, 'demo')
  assert.equal(out.init_script, 'echo hi\necho bye')
})

test('parseSimpleYaml: 注释/空行被忽略,非法行跳过', () => {
  const out = parseSimpleYaml('# 注释\n\nname: x\n-nope: bad\n')
  assert.equal(out.name, 'x')
  assert.equal(out['-nope'], undefined)
})

test('parseSimpleYaml: 空输入', () => {
  assert.deepEqual(parseSimpleYaml(''), {})
  assert.deepEqual(parseSimpleYaml('# only comment'), {})
})
