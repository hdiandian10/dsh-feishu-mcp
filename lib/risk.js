/**
 * 命令风险分级 —— 纯函数，不碰 IO，全部可单测。
 *
 * ## 为什么需要这一层
 *
 * 飞书的 device flow 里，**令牌拿到的 scope 等于应用已开通的全集**，请求时写
 * 多少个 scope 并不改变令牌能力（实测：请求 4 个只读，令牌仍是 172 个）。
 * 也就是说「授权页收窄」只能让审批页面干净，**不能**收住能力边界。
 *
 * 所以边界必须落在执行层：每个命令先分级，再决定直通、预览还是拒绝。
 *
 * ## 三档
 *
 * - `read`        无副作用，直接执行。
 * - `write`       可回退的写入（改值、加行、建文档），执行前尽量快照旧值。
 * - `destructive` 不可逆（删除、清空、改权限、版本回滚），默认拒绝，需显式确认。
 */

export const RISK = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  DESTRUCTIVE: 'destructive',
  UNKNOWN: 'unknown',
})

/** 由弱到强，用于「取更严格的一档」。未知命令默认要求确认。 */
const ORDER = [RISK.READ, RISK.WRITE, RISK.DESTRUCTIVE, RISK.UNKNOWN]

/** lark-cli 帮助尾部的 `Risk: read | write | high-risk-write` 映射。 */
const HELP_RISK = Object.freeze({
  'read': RISK.READ,
  'write': RISK.WRITE,
  'high-risk-write': RISK.DESTRUCTIVE,
})

/** 只要出现这些词，一律视为不可逆。 */
const DESTRUCTIVE_WORDS = new Set([
  'delete', 'remove', 'clear', 'revoke', 'trash', 'destroy',
  'purge', 'revert', 'transfer', 'reset',
])

/** 无副作用动词。 */
const READ_WORDS = new Set([
  'list', 'get', 'search', 'info', 'status', 'inspect', 'read', 'query',
  'export', 'preview', 'download', 'check', 'scopes', 'history', 'changeset',
  'members', 'agenda', 'schema', 'whoami', 'describe', 'verify', 'find',
  'result', 'show', 'view',
])

/** 已知的可回退写入动词；其余动作视为未知并要求确认。 */
const WRITE_WORDS = new Set([
  'set', 'put', 'create', 'insert', 'append', 'copy', 'move', 'update',
  'rename', 'duplicate', 'sort', 'merge', 'unmerge', 'fill', 'resize',
  'freeze', 'unfreeze', 'hide', 'show', 'batch', 'add',
])

/**
 * 从 lark-cli 的 `--help` 文本里读出风险标注。
 *
 * 行格式固定为 `Risk: high-risk-write`，忽略大小写与行首缩进。
 * 读不到就返回 null，交给关键字兜底。
 */
export function parseHelpRisk(helpText) {
  if (typeof helpText !== 'string' || helpText.length === 0) return null
  const matched = helpText.match(/^[ \t]*Risk:[ \t]*([a-z][a-z-]*)[ \t]*$/mi)
  if (!matched) return null
  return HELP_RISK[matched[1].toLowerCase()] ?? null
}

/** 取 argv 里第一个非 flag 之后的那一段（`sheets +csv-get …` → `+csv-get`）。 */
export function actionToken(argv) {
  if (!Array.isArray(argv)) return ''
  const positional = argv.filter((item) => typeof item === 'string' && item.length > 0 && !item.startsWith('-'))
  return positional[1] ?? positional[0] ?? ''
}

/** `+cells-batch-clear` → ['cells','batch','clear']。 */
export function splitWords(token) {
  if (typeof token !== 'string') return []
  return token.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function hasAny(words, set) {
  return words.some((word) => set.has(word))
}

/**
 * 关键字推断。顺序很重要：
 * 先把 `--yes` 和删除类动词钉死，再放过读动词，最后才落到 write。
 *
 * 特例：`+permission-get-setting` 含 permission 但其实是只读，所以「读动词优先于
 * permission」；而 `+permission-set` 没有读动词，才会被判成 destructive。
 */
export function keywordRisk(argv, words) {
  if (Array.isArray(argv) && argv.includes('--yes')) return RISK.DESTRUCTIVE
  if (hasAny(words, DESTRUCTIVE_WORDS)) return RISK.DESTRUCTIVE
  if (words.includes('member') && (words.includes('add') || words.includes('remove'))) return RISK.DESTRUCTIVE
  if (hasAny(words, READ_WORDS)) return RISK.READ
  if (words.includes('permission') || words.includes('share')) return RISK.DESTRUCTIVE
  if (hasAny(words, WRITE_WORDS)) return RISK.WRITE
  return RISK.UNKNOWN
}

function stricter(a, b) {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b
}

/**
 * 综合 help 标注与关键字，得出最终等级。
 *
 * 两者都在时**取更严格的一档**：CLI 的标注可能低估（例如 `+member-add` 只标
 * write，但它是权限变更），关键字也可能误判，取严保证不会放过危险命令。
 */
export function classifyCommand({ argv = [], helpText } = {}) {
  const action = actionToken(argv)
  const words = splitWords(action)
  const byKeyword = keywordRisk(argv, words)
  const byHelp = parseHelpRisk(helpText)
  if (byHelp === null) {
    return { risk: byKeyword, action, source: 'keyword' }
  }
  return { risk: stricter(byHelp, byKeyword), action, source: 'help+keyword' }
}

/** 不可逆或无法确认风险的操作必须显式确认。 */
export function needsConfirmation(risk) {
  return risk === RISK.DESTRUCTIVE || risk === RISK.UNKNOWN
}

/** 给用户看的一句话解释。 */
export function describeRisk(risk) {
  switch (risk) {
    case RISK.READ:
      return '只读操作，无副作用'
    case RISK.WRITE:
      return '写入操作，可回退（执行前会尽量快照旧值）'
    case RISK.DESTRUCTIVE:
      return '不可逆操作，默认拒绝，需要显式确认'
    case RISK.UNKNOWN:
      return '无法确认风险，默认需要显式确认'
    default:
      return '未知风险等级'
  }
}
