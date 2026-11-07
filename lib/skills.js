/**
 * lark-cli 内置 skill 的 DSH provider。
 *
 * ## 为什么不拷贝 SKILL.md
 *
 * Buddy 那一套的「飞书能力」其实分两层：`@larksuite/cli` 提供命令，28 个
 * `SKILL.md` 教模型怎么用这些命令。CLI 从 1.x 起把 skill **内嵌进二进制**
 * （`lark-cli skills list` / `skills read`），所以这里按需读取即可 —— CLI 升级
 * 时说明书自动跟着更新，不需要人工同步目录。
 *
 * ## 为什么默认只挂 core
 *
 * catalog 里的 name + description 是**每轮对话常驻**的。全量 28 个约 7.7k 字符，
 * core 9 个约 3.3k；更麻烦的是 `lark-doc` / `lark-drive` / `lark-wiki` /
 * `lark-markdown` 描述高度重叠，全挂时模型容易挑错。能力不受影响 —— 命令一直在
 * `feishu_cli` 里，skill 只影响「用得对不对」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** provider 在 DSH 里的唯一名字。 */
export const PROVIDER_NAME = 'feishu-connector'

/** 允许的三种规模。 */
export const SKILL_MODES = Object.freeze(['core', 'all', 'off'])

/**
 * 日常高频的 9 个。
 *
 * `lark-shared` 必须在内：其它 skill 的正文都要求先读它（身份/权限/输出契约）。
 */
export const CORE_SKILLS = Object.freeze([
  'lark-shared',
  'lark-sheets',
  'lark-base',
  'lark-doc',
  'lark-wiki',
  'lark-drive',
  'lark-im',
  'lark-calendar',
  'lark-task',
])

/** 设置文件：与审计日志同目录，避免污染 lark-mcp 的配置。 */
const SETTINGS_FILE = join(homedir(), '.dsh', 'feishu-mcp', 'settings.json')

/** list 结果的缓存时长：skill 只在 CLI 升级时变化。 */
const LIST_TTL_MS = 5 * 60 * 1000

/** 读取 skills 规模设置，非法值一律回落到 core。 */
export function readSkillMode(settingsFile = SETTINGS_FILE) {
  try {
    if (!existsSync(settingsFile)) return 'core'
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'))
    const mode = typeof parsed?.skillsMode === 'string' ? parsed.skillsMode.trim() : ''
    return SKILL_MODES.includes(mode) ? mode : 'core'
  } catch {
    return 'core'
  }
}

/** 剥掉 YAML frontmatter —— 元信息已经在 entry 里，正文里重复会浪费上下文。 */
export function stripFrontmatter(text) {
  if (typeof text !== 'string') return ''
  const matched = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!matched) return text
  return text.slice(matched[0].length).replace(/^\s+/, '')
}

/**
 * 把 `skills list` 的返回映射成 DSH 的 entry 列表。
 *
 * DSH 校验来源与 provider 归属，并用 invocation 筛选可调用的技能。
 * `rank` 用于排序，`locator` 交给 `get` 定位正文。
 *
 * `resourceBase` 只影响模型看到的提示文案：附件不在 DSH 侧加载，而是由
 * `lark-cli skills read <skill> <路径>` 逐文件取回，所以这里用 `opaque` 并写明
 * 具体调用方式，避免模型拿着一个读不到的目录路径乱试。
 */
export function toSkillEntries(skills, mode = 'core') {
  if (mode === 'off') return []
  const items = Array.isArray(skills) ? skills : []
  const allow = mode === 'all' ? null : new Set(CORE_SKILLS)
  const entries = []
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name : ''
    if (name.length === 0) continue
    if (allow !== null && !allow.has(name)) continue
    entries.push({
      name,
      description: typeof item.description === 'string' ? item.description : `飞书能力：${name}`,
      source: 'bundled',
      provider: PROVIDER_NAME,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'opaque', description: resourceHint(name) },
      version: typeof item.version === 'string' ? item.version : undefined,
      metadata: item.metadata ?? undefined,
      rank: entries.length,
      locator: name,
    })
  }
  return entries
}

/** 附件读取提示：给模型一条可执行的命令，而不是一个不存在的目录。 */
function resourceHint(skillName) {
  return `附件由 lark-cli 内嵌，用 feishu_cli 逐文件读取：args=["skills","read","${skillName}","<相对路径>"]`
}

/** 单个 skill 最多列出的附件数，避免把 lark-sheets 这类大 skill 撑爆。 */
const MAX_RESOURCE_FILES = 30

/** 目录递归深度：`<skill>/references/*.md` 只要两层。 */
const MAX_RESOURCE_DEPTH = 2

/**
 * 枚举某个 skill 携带的附件（相对路径）。
 *
 * `lark-cli skills list <path>` 是「像 ls 一样」单层列举，所以要自己走目录树。
 * 失败一律返回空数组：附件读不到不该让整个 skill 加载失败。
 */
export async function listResourceFiles(runCli, skillName, options = {}) {
  if (typeof skillName !== 'string' || skillName.length === 0) return []
  const files = []
  const queue = [{ path: skillName, depth: 0 }]
  const visited = new Set()

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current.path)) continue
    visited.add(current.path)
    if (current.depth > MAX_RESOURCE_DEPTH) continue

    let result
    try {
      result = await runCli(['skills', 'list', current.path, '--json'], options)
    } catch {
      continue
    }
    const entries = result?.json?.entries
    if (!Array.isArray(entries)) continue

    for (const entry of entries) {
      const path = typeof entry?.path === 'string' ? entry.path : ''
      if (path.length === 0) continue
      if (entry.is_dir === true) {
        queue.push({ path, depth: current.depth + 1 })
        continue
      }
      if (path.endsWith('SKILL.md')) continue
      files.push(path)
      if (files.length >= MAX_RESOURCE_FILES) return files
    }
  }
  return files
}

/** 把附件清单渲染成正文尾部的一小节；没有附件就返回空串。 */
export function renderResourceAppendix(skillName, files) {
  if (!Array.isArray(files) || files.length === 0) return ''
  const prefix = `${skillName}/`
  const lines = [
    '',
    '---',
    '',
    `## 本 skill 的附件（${files.length} 个）`,
    '',
    `读取任意一个：\`feishu_cli({"args":["skills","read","${skillName}","<相对路径>"]})\``,
    '',
  ]
  for (const file of files) {
    lines.push(`- ${file.startsWith(prefix) ? file.slice(prefix.length) : file}`)
  }
  return lines.join('\n')
}

/**
 * 造一个 provider。
 *
 * `runCli(args, options)` 由调用方注入，便于单测替换；返回
 * `{ ok, stdout, json, error }`。
 */
export function createSkillProvider({ runCli, mode = 'core', now = () => Date.now() } = {}) {
  let cache = null
  let cachedAt = 0
  let inflight = null

  async function loadEntries(options = {}) {
    const fresh = cache !== null && now() - cachedAt < LIST_TTL_MS
    if (fresh) return cache
    if (inflight) return inflight

    inflight = (async () => {
      const result = await runCli(['skills', 'list', '--json'], options)
      if (!result?.ok || !Array.isArray(result.json?.skills)) {
        throw new Error(result?.error ?? 'lark-cli skills list 未返回可用的 skill 列表')
      }
      const entries = toSkillEntries(result.json.skills, mode)
      cache = entries
      cachedAt = now()
      return entries
    })()

    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return {
    name: PROVIDER_NAME,
    async list(options = {}) {
      if (mode === 'off') return []
      return await loadEntries(options)
    },
    async get(entry, options = {}) {
      const locator = typeof entry?.locator === 'string' && entry.locator.length > 0
        ? entry.locator
        : entry?.name
      if (typeof locator !== 'string' || locator.length === 0) {
        throw new Error('skill entry 缺少 locator，无法读取正文')
      }
      const result = await runCli(['skills', 'read', locator], options)
      if (!result?.ok) {
        throw new Error(result?.error ?? `读取 skill ${locator} 失败`)
      }
      // 正文里的 `references/xxx.md` 是相对路径，DSH 侧不会替我们解析，
      // 所以在尾部附上真实可读的清单，并给出可直接执行的那条命令。
      const files = await listResourceFiles(runCli, locator, options)
      const { rank, locator: _locator, ...summary } = entry
      return {
        ...summary,
        content: stripFrontmatter(result.stdout ?? '') + renderResourceAppendix(locator, files),
      }
    },
  }
}
