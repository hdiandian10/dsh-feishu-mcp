/**
 * 写操作审计日志。
 *
 * ## 为什么需要
 *
 * 阶段 1 之后，任何飞书写操作都能通过 `feishu_cli` 一次调用完成，出事时唯一的
 * 回溯依据就是这份日志：什么时候、用什么身份、对哪个文档、改之前是什么样。
 *
 * ## 为什么是 JSONL
 *
 * 追加写、单行可解析、坏了只坏一行，不需要读全文件再改。路径放在
 * `~/.dsh/feishu-mcp/audit.jsonl`，与配置文件同目录，卸载插件时可一并删除。
 *
 * ## 失败不影响主流程
 *
 * 审计写不进去（磁盘满、权限错）时只返回 false，绝不让写操作因此失败——
 * 用户要的是把表格改对，不是把日志写全。
 */

import { createReadStream, mkdirSync, appendFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUDIT_DIR = join(homedir(), '.dsh', 'feishu-mcp')
const AUDIT_FILE = join(AUDIT_DIR, 'audit.jsonl')

/** 单行上限，防止把整表内容写进日志。 */
const MAX_FIELD_CHARS = 2_000

export function auditPath() {
  return AUDIT_FILE
}

function clamp(value) {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}…[truncated ${value.length - MAX_FIELD_CHARS}]`
  }
  return value
}

/**
 * 追加一条审计记录。
 *
 * `record` 里所有字符串字段会被截断，避免整表 CSV 撑爆日志。
 */
export function appendAudit(record) {
  try {
    if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true })
    const line = {}
    for (const [key, value] of Object.entries(record ?? {})) {
      line[key] = clamp(value)
    }
    line.ts = line.ts ?? new Date().toISOString()
    appendFileSync(AUDIT_FILE, `${JSON.stringify(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读取最近 `limit` 条，供状态面板展示；读不到就返回空数组。 */
export async function tailAudit(limit = 10) {
  const count = Number.isInteger(limit) && limit > 0 ? limit : 10
  try {
    if (!existsSync(AUDIT_FILE)) return []
    const size = statSync(AUDIT_FILE).size
    if (size === 0) return []
    // 只回读尾部一段：日志可能已经很大，不必整文件读入。
    const windowBytes = Math.min(size, 64 * 1024)
    const chunks = []
    const stream = createReadStream(AUDIT_FILE, { start: size - windowBytes, encoding: 'utf8' })
    return new Promise((resolve) => {
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', () => resolve([]))
      stream.on('end', () => {
        const text = chunks.join('')
        const lines = text.split('\n').filter((line) => line.trim().length > 0)
        const parsed = []
        for (const line of lines.slice(-count)) {
          try { parsed.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
        }
        resolve(parsed)
      })
    })
  } catch {
    return []
  }
}
