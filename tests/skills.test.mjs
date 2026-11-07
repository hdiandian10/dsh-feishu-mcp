/**
 * skill provider 的测试。
 *
 * 重点验证三件事：
 *   1. frontmatter 被剥掉（元信息已在 entry 里，正文重复会浪费上下文）；
 *   2. core / all / off 三种规模的过滤行为；
 *   3. list 有缓存，get 能拿到正文。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CORE_SKILLS,
  PROVIDER_NAME,
  SKILL_MODES,
  createSkillProvider,
  readSkillMode,
  stripFrontmatter,
  toSkillEntries,
} from '../lib/skills.js'

const FAKE_SKILLS = [
  ...CORE_SKILLS.map((name) => ({ name, description: `${name} 的描述`, version: '1.0.0' })),
  { name: 'lark-approval', description: '审批', version: '1.2.0' },
  { name: 'lark-mail', description: '邮件', version: '1.0.0' },
]

function makeRunCli() {
  const calls = []
  const runCli = async (args) => {
    calls.push(args)
    if (args[0] === 'skills' && args[1] === 'list') {
      return { ok: true, json: { ok: true, skills: FAKE_SKILLS }, stdout: '' }
    }
    if (args[0] === 'skills' && args[1] === 'read') {
      return { ok: true, stdout: `---\nname: ${args[2]}\nversion: 1.0.0\n---\n\n# ${args[2]} 正文\n内容` }
    }
    return { ok: false, error: `unexpected: ${args.join(' ')}` }
  }
  return { runCli, calls }
}

test('stripFrontmatter 只剥头部元信息', () => {
  const text = '---\nname: x\nversion: 1\n---\n\n# 标题\n正文'
  assert.equal(stripFrontmatter(text), '# 标题\n正文')
  assert.equal(stripFrontmatter('# 没有 frontmatter'), '# 没有 frontmatter')
  assert.equal(stripFrontmatter(undefined), '')
})

test('toSkillEntries 按 core 过滤并补 rank / locator', () => {
  const entries = toSkillEntries(FAKE_SKILLS, 'core')
  assert.equal(entries.length, CORE_SKILLS.length)
  assert.ok(entries.every((entry) => CORE_SKILLS.includes(entry.name)))
  assert.equal(entries[0].rank, 0)
  assert.equal(entries[0].locator, entries[0].name)
  assert.ok(!entries.some((entry) => entry.name === 'lark-mail'))
})

test('all 与 off 两种规模', () => {
  assert.equal(toSkillEntries(FAKE_SKILLS, 'all').length, FAKE_SKILLS.length)
  assert.equal(toSkillEntries(FAKE_SKILLS, 'off').length, 0)
})

test('设置非法时回落到 core', () => {
  assert.ok(SKILL_MODES.includes(readSkillMode('/definitely/missing/settings.json')))
  assert.equal(readSkillMode('/definitely/missing/settings.json'), 'core')
})

test('provider.list 走 core 且带缓存', async () => {
  const { runCli, calls } = makeRunCli()
  const provider = createSkillProvider({ runCli, mode: 'core' })
  assert.equal(provider.name, PROVIDER_NAME)
  const first = await provider.list()
  const second = await provider.list()
  assert.equal(first.length, CORE_SKILLS.length)
  assert.deepEqual(first, second)
  assert.equal(calls.filter((args) => args[1] === 'list').length, 1, 'list 只应调用一次')
})

for (const mode of ['core', 'all']) {
  test(`provider 的 ${mode} 目录和正文满足 DSH 来源、归属及调用策略契约`, async () => {
    const { runCli } = makeRunCli()
    const provider = createSkillProvider({ runCli, mode })
    const entries = await provider.list()
    assert.ok(entries.length > 0)
    for (const entry of entries) {
      const loaded = await provider.get(entry)
      for (const skill of [entry, loaded]) {
        assert.equal(typeof skill.source, 'string', `${skill.name} 缺少来源`)
        assert.ok(skill.source.length > 0)
        assert.equal(skill.provider, provider.name, `${skill.name} 的 provider 归属错误`)
        assert.equal(skill.invocation?.modelInvocable, true, `${skill.name} 无法供模型调用`)
        assert.equal(skill.invocation?.userInvocable, true, `${skill.name} 无法供用户调用`)
      }
    }
  })
}

test('provider.get 返回去掉 frontmatter 的正文', async () => {
  const { runCli } = makeRunCli()
  const provider = createSkillProvider({ runCli, mode: 'core' })
  const entries = await provider.list()
  const sheet = entries.find((entry) => entry.name === 'lark-sheets')
  assert.ok(sheet, 'core 里必须有 lark-sheets')
  const loaded = await provider.get(sheet, {})
  assert.equal(loaded.name, 'lark-sheets')
  assert.equal(loaded.description, 'lark-sheets 的描述')
  assert.ok(loaded.content.startsWith('# lark-sheets 正文'))
  assert.ok(!loaded.content.includes('---'), 'frontmatter 必须被剥掉')
  assert.equal(loaded.rank, undefined, 'rank 不应透传给内容层')
  assert.equal(loaded.locator, undefined, 'locator 不应透传给内容层')
})

test('provider.get 缺 locator 时抛错', async () => {
  const { runCli } = makeRunCli()
  const provider = createSkillProvider({ runCli, mode: 'core' })
  await assert.rejects(() => provider.get({ name: '' }, {}), /locator/)
})

test('模式 off 时 list 返回空且不调用 CLI', async () => {
  const { runCli, calls } = makeRunCli()
  const provider = createSkillProvider({ runCli, mode: 'off' })
  assert.deepEqual(await provider.list(), [])
  assert.equal(calls.length, 0)
})

test('apply() 在 skills 能力可用时注册 provider', async () => {
  const { apply } = await import('../index.js')
  let factory = null
  const ctx = {
    logger: { warn() {}, info() {} },
    subprocess: { spawn() { throw new Error('本用例不应拉起子进程') } },
    tools: { register() { return () => {} } },
    inject(capabilities, callback) {
      if (!capabilities.includes('skills')) return
      callback({ skills: { registerProvider(fn) { factory = fn } } })
    },
  }
  apply(ctx)
  assert.equal(typeof factory, 'function', 'registerProvider 必须被调用')
  const provider = factory()
  assert.equal(provider.name, 'feishu-connector')
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.get, 'function')
})

test('skills 能力缺失时插件照常加载（不抛错）', async () => {
  const { apply } = await import('../index.js')
  const ctx = {
    logger: { warn() {}, info() {} },
    subprocess: { spawn() { throw new Error('unused') } },
    tools: { register() { return () => {} } },
    inject() { /* 能力缺失，回调不触发 */ },
  }
  assert.doesNotThrow(() => apply(ctx))
})
