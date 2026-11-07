/**
 * skill 附件（references）通路的测试。
 *
 * 背景：`lark-cli skills list` 是单层列举（像 ls），附件得自己走目录树；
 * DSH 的 resourceBase 只是提示文案，不会替我们读文件。所以这里验证：
 *   1. 能枚举到 `<skill>/references/*.md`；
 *   2. 正文尾部附上清单，且给出可直接执行的 feishu_cli 命令；
 *   3. entry 带上 opaque 的 resourceBase 提示。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSkillProvider,
  listResourceFiles,
  renderResourceAppendix,
  toSkillEntries,
} from '../lib/skills.js'

const FILE_A = 'lark-sheets/references/lark-sheets-chart.md'
const FILE_B = 'lark-sheets/references/lark-sheets-filter.md'
const FILE_C = 'lark-sheets/references/lark-sheets-read-data.md'

function makeRunCli() {
  const calls = []
  const runCli = async (args) => {
    calls.push(args)
    if (args[0] === 'skills' && args[1] === 'list' && args[2] === '--json') {
      return { ok: true, json: { ok: true, skills: [{ name: 'lark-sheets', description: 'd' }] } }
    }
    if (args[0] === 'skills' && args[1] === 'list' && args[2] === 'lark-sheets') {
      return {
        ok: true,
        json: {
          ok: true,
          entries: [
            { path: 'lark-sheets/SKILL.md', is_dir: false },
            { path: 'lark-sheets/references', is_dir: true },
          ],
        },
      }
    }
    if (args[0] === 'skills' && args[1] === 'list' && args[2] === 'lark-sheets/references') {
      return {
        ok: true,
        json: {
          ok: true,
          entries: [FILE_A, FILE_B, FILE_C].map((path) => ({ path, is_dir: false })),
        },
      }
    }
    if (args[0] === 'skills' && args[1] === 'read') {
      return { ok: true, stdout: '---\nname: lark-sheets\n---\n\n# sheets\n正文' }
    }
    return { ok: false, error: `unexpected: ${args.join(' ')}` }
  }
  return { runCli, calls }
}

test('listResourceFiles 递归列出附件并跳过 SKILL.md', async () => {
  const { runCli } = makeRunCli()
  const files = await listResourceFiles(runCli, 'lark-sheets')
  assert.deepEqual(files, [FILE_A, FILE_B, FILE_C])
})

test('listResourceFiles 在目录缺失时返回空数组而不是抛错', async () => {
  const runCli = async () => ({ ok: false, error: 'boom' })
  assert.deepEqual(await listResourceFiles(runCli, 'lark-sheets'), [])
})

test('renderResourceAppendix 去掉 skill 前缀并给出可执行命令', () => {
  const text = renderResourceAppendix('lark-sheets', [FILE_A])
  assert.ok(text.includes('lark-sheets-chart.md'))
  assert.ok(!text.includes('lark-sheets/references/lark-sheets-chart.md'), '应展示相对路径')
  assert.ok(text.includes('feishu_cli'))
  assert.ok(text.includes('skills","read","lark-sheets"'))
  assert.equal(renderResourceAppendix('lark-sheets', []), '')
})

test('entry 带 opaque 的 resourceBase 提示', () => {
  const entries = toSkillEntries([{ name: 'lark-sheets', description: 'd' }], 'all')
  assert.equal(entries[0].resourceBase.kind, 'opaque')
  assert.ok(entries[0].resourceBase.description.includes('lark-sheets'))
  assert.ok(entries[0].resourceBase.description.includes('skills'))
})

test('provider.get 把附件清单追加到正文尾部', async () => {
  const { runCli } = makeRunCli()
  const provider = createSkillProvider({ runCli, mode: 'core' })
  const entries = await provider.list()
  const loaded = await provider.get(entries[0])
  assert.ok(loaded.content.startsWith('# sheets'))
  assert.ok(loaded.content.includes('本 skill 的附件（3 个）'))
  assert.ok(loaded.content.includes('lark-sheets-chart.md'))
  assert.equal(loaded.resourceBase.kind, 'opaque', 'summary 必须带出 resourceBase')
})

test('附件枚举失败不影响正文加载', async () => {
  const runCli = async (args) => {
    if (args[1] === 'read') return { ok: true, stdout: '# 正文' }
    return { ok: false, error: 'list failed' }
  }
  const provider = createSkillProvider({ runCli, mode: 'core' })
  const loaded = await provider.get({ name: 'lark-sheets', locator: 'lark-sheets' })
  assert.equal(loaded.content, '# 正文')
})
