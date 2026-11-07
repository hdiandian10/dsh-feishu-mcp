/**
 * 网关（feishu_cli）与风险分级的测试。
 *
 * 覆盖三件必须成立的事：
 *   1. 分级纯函数对典型命令给出预期等级（这是安全边界的地基）；
 *   2. 不可逆命令在没有 confirm 时被拦下，且不会真的执行；
 *   3. 只读命令能真的跑通 lark-cli 并返回结构化数据。
 *
 * 刻意不测「不可逆 + confirm:true 真执行」—— 那会真的删数据。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { RISK, classifyCommand, parseHelpRisk, keywordRisk, splitWords, actionToken, needsConfirmation } from '../lib/risk.js'
import { appendAudit, auditPath, tailAudit } from '../lib/audit.js'

// ---------------------------------------------------------------- 分级

test('help 标注能正确映射三档', () => {
  assert.equal(parseHelpRisk('Usage:\n  x\n\nRisk: read\n'), RISK.READ)
  assert.equal(parseHelpRisk('Risk: write'), RISK.WRITE)
  assert.equal(parseHelpRisk('Risk: high-risk-write'), RISK.DESTRUCTIVE)
  assert.equal(parseHelpRisk('no risk line here'), null)
  assert.equal(parseHelpRisk(undefined), null)
})

test('actionToken / splitWords 解析命令段', () => {
  assert.equal(actionToken(['sheets', '+csv-get', '--range', 'A1:B2']), '+csv-get')
  assert.deepEqual(splitWords('+cells-batch-clear'), ['cells', 'batch', 'clear'])
})

test('只读命令判为 read', () => {
  for (const action of ['+csv-get', '+cells-get', '+workbook-info', '+member-list', '+permission-get-setting', '+cells-search']) {
    assert.equal(keywordRisk(['sheets', action], splitWords(action)), RISK.READ, action)
  }
})

test('可回退写入判为 write', () => {
  for (const action of ['+range-copy', '+csv-put', '+cells-set', '+dim-insert', '+update-title']) {
    assert.equal(keywordRisk(['sheets', action], splitWords(action)), RISK.WRITE, action)
  }
})

test('删除、清空、权限变更判为 destructive', () => {
  for (const action of ['+cells-clear', '+cells-batch-clear', '+dim-delete', '+member-add', '+member-remove', 'delete']) {
    assert.equal(keywordRisk(['x', action], splitWords(action)), RISK.DESTRUCTIVE, action)
  }
})

test('--yes 一律升级为 destructive', () => {
  assert.equal(keywordRisk(['sheets', '+csv-put', '--yes'], splitWords('+csv-put')), RISK.DESTRUCTIVE)
})

test('help 与关键字取更严格的一档', () => {
  // help 说 write，但动作是成员变更 → 升级
  const escalated = classifyCommand({ argv: ['x', '+member-add'], helpText: 'Risk: write' })
  assert.equal(escalated.risk, RISK.DESTRUCTIVE)
  // help 说 high-risk-write，关键字判 write → 取 destructive
  const helpWins = classifyCommand({ argv: ['x', '+range-copy'], helpText: 'Risk: high-risk-write' })
  assert.equal(helpWins.risk, RISK.DESTRUCTIVE)
  // 没有 help 时退化为关键字
  assert.equal(classifyCommand({ argv: ['x', '+csv-get'] }).source, 'keyword')
})

test('不可确认风险的动作默认需要确认', () => {
  assert.equal(classifyCommand({ argv: ['drive', '+archive'] }).risk, RISK.UNKNOWN)
  assert.equal(needsConfirmation(RISK.UNKNOWN), true)
  assert.equal(needsConfirmation(RISK.DESTRUCTIVE), true)
  assert.equal(needsConfirmation(RISK.WRITE), false)
  assert.equal(needsConfirmation(RISK.READ), false)
})

// ---------------------------------------------------------------- 审计

test('审计日志可追加且能被尾部读回', async () => {
  const marker = `test-${Date.now()}`
  const ok = appendAudit({ risk: 'write', command: marker, ok: true, revision: 1 })
  assert.equal(ok, true)
  assert.equal(auditPath(), join(homedir(), '.dsh', 'feishu-mcp', 'audit.jsonl'))
  assert.equal(existsSync(auditPath()), true)
  const tail = await tailAudit(20)
  assert.ok(Array.isArray(tail))
  assert.ok(tail.some((row) => row.command === marker), '刚写入的记录应出现在尾部')
})

// ---------------------------------------------------------------- 网关

/** 与真实 DSH 一致：tools / subprocess 直接挂在 ctx 上。 */
async function makeCtx() {
  const registered = new Map()
  const ctx = {
    logger: { warn() {}, info() {} },
    subprocess: await makeSubprocess(),
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    inject() {},
  }
  return { ctx, registered }
}

async function makeSubprocess() {
  const { spawn } = await import('node:child_process')
  return {
    spawn({ argv, cwd, env }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      const done = new Promise((resolve) => {
        child.on('close', (code) => resolve({ exitCode: code ?? 0, signal: null }))
        child.on('error', () => resolve({ exitCode: 1, signal: null }))
      })
      return {
        done,
        terminate() { try { child.kill() } catch { /* 已退出 */ } },
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
      }
    },
  }
}

test('feishu_cli 已注册且声明了合法 schema', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const definition = registered.get('feishu_cli')
  assert.ok(definition, 'feishu_cli 必须被注册')
  assert.equal(definition.parameters.required[0], 'args')
  assert.ok(definition.output.schema)
  assert.equal(typeof definition.output.render, 'function')
})

test('不可逆命令无 confirm 时被拦下', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const tool = registered.get('feishu_cli')
  const result = await tool.execute(
    { args: ['sheets', '+cells-clear', '--range', 'A1:A1', '--sheet-id', 'test'] },
    { signal: undefined },
  )
  assert.equal(result.blocked, true)
  assert.equal(result.ok, false)
  assert.equal(result.risk, RISK.DESTRUCTIVE)
})

test('带 --yes 也被拦下（不能靠 CLI 的 --yes 绕过）', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const tool = registered.get('feishu_cli')
  const result = await tool.execute(
    { args: ['drive', '+delete', '--token', 'x', '--yes'] },
    { signal: undefined },
  )
  assert.equal(result.blocked, true)
})

test('只读命令能真正执行并返回数据', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const tool = registered.get('feishu_cli')
  const result = await tool.execute({ args: ['skills', 'list'] }, { signal: undefined })
  assert.equal(result.ok, true, result.error ?? '')
  assert.equal(result.risk, RISK.READ)
  assert.ok(Array.isArray(result.data?.skills))
  assert.ok(result.data.skills.length >= 20)
})

test('授权类命令被引导到专用工具', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const tool = registered.get('feishu_cli')
  await assert.rejects(
    () => tool.execute({ args: ['auth', 'login'] }, { signal: undefined }),
    /feishu_auth_login/,
  )
})
