/**
 * 端到端冒烟：真拉起 lark-cli，验证 skill 正文 + 附件清单。
 *
 * 不是单元测试（会 spawn 子进程、依赖本机安装），单独跑：
 *   node tests/e2e-skills.mjs
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createSkillProvider } from '../lib/skills.js'

const NODE_BIN = process.env.DSH_NODE_BIN ?? join(
  homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
)
const CLI_ENTRY = join(homedir(), '.dsh', 'lark-cli', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js')

async function runCli(args) {
  try {
    const stdout = execFileSync(NODE_BIN, [CLI_ENTRY, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    })
    let json = null
    try { json = JSON.parse(stdout) } catch { /* 非 JSON 输出（如 skills read） */ }
    return { ok: true, stdout, json }
  } catch (error) {
    return { ok: false, error: error.message, stdout: error.stdout ?? '' }
  }
}

const provider = createSkillProvider({ runCli, mode: 'core' })
const entries = await provider.list()
console.log(`provider: ${provider.name}`)
console.log(`core 条目数: ${entries.length}`)
console.log(`条目名: ${entries.map((entry) => entry.name).join(', ')}`)

const sheet = entries.find((entry) => entry.name === 'lark-sheets')
if (!sheet) throw new Error('core 里没有 lark-sheets')

console.log('resourceBase:', JSON.stringify(sheet.resourceBase))
const loaded = await provider.get(sheet)
const bullets = loaded.content.split('\n').filter((line) => line.startsWith('- '))
console.log(`正文长度: ${loaded.content.length} 字符`)
console.log(`附件条数: ${bullets.length}`)
console.log('附件示例:')
for (const line of bullets.slice(0, 3)) console.log(`  ${line}`)
console.log('正文尾部:')
console.log(loaded.content.split('\n').slice(-4).join('\n'))
