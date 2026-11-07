/**
 * lark-cli 桥的冒烟测试。
 *
 * 目的不是覆盖业务逻辑，而是证明三件最容易出错的事：
 *   1. 插件导出的静态 `inject` 声明了 subprocess/tools；
 *   2. apply() 在 tools 能力可用时确实注册了预期工具名；
 *   3. 工具 execute 能真的拉起 lark-cli 并解析出 JSON（用 auth status 这条
 *      不依赖网络与授权的命令）。
 *
 * 用假的 ctx 模拟 DSH 的能力注入，不 import 任何 @deepseek-ai/*。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LARK_CLI_ENTRY = join(homedir(), '.dsh', 'lark-cli', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js')

/**
 * 造一个记录工具注册的假 ctx。
 *
 * 关键：真实 DSH 里 `tools` / `subprocess` 直接挂在 ctx 上（静态 inject 注入），
 * 所以这里也直接挂，而不是靠 ctx.inject 回调。
 */
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
    inject(capabilities, callback) {
      // 模拟：connection 能力在本测试里不存在，回调不触发。
      if (!capabilities.includes('connection')) return
      callback({ ...ctx, connection: { fetch: { register() {} } } })
    },
  }
  return { ctx, registered }
}

/** 用 node:child_process 实现一个最小的 subprocess 能力。 */
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

test('静态 inject 声明了 subprocess 与 tools', async () => {
  const { inject } = await import('../index.js')
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
  assert.ok(inject.includes('tools'), 'inject 必须包含 tools')
  assert.ok(inject.includes('subprocess'), 'inject 必须包含 subprocess')
})

test('apply() 注册了预期的飞书工具', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  const names = [...registered.keys()].sort()
  assert.deepEqual(names, [
    'feishu_auth_login',
    'feishu_auth_login_poll',
    'feishu_auth_status',
    'feishu_cli',
    'feishu_sheets_cells',
    'feishu_sheets_info',
    'feishu_sheets_read',
  ])
})

test('每个工具都声明了合法的 output.schema 与 render', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)
  for (const [name, definition] of registered) {
    assert.equal(typeof definition.description, 'string', `${name} 缺少 description`)
    assert.ok(definition.description.length > 0, `${name} description 为空`)
    assert.equal(typeof definition.output?.render, 'function', `${name} 缺少 output.render`)
    assert.equal(definition.output?.schema?.type, 'object', `${name} output.schema 必须是 object`)
    assert.equal(typeof definition.execute, 'function', `${name} 缺少 execute`)
  }
})

test('feishu_auth_status 能真的拉起 lark-cli 并解析 JSON', async (t) => {
  if (!existsSync(LARK_CLI_ENTRY)) {
    t.skip(`lark-cli 未安装：${LARK_CLI_ENTRY}`)
    return
  }
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)

  const definition = registered.get('feishu_auth_status')
  const value = await definition.execute({}, { signal: undefined })
  assert.equal(value.ok, true, `调用失败：${value.error ?? ''}`)
  assert.ok(['user', 'bot'].includes(value.identity), `意外的 identity：${value.identity}`)
  assert.ok(typeof value.botStatus === 'string')
})

test('缺少 spreadsheetToken 与 url 时给出明确错误', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)

  const definition = registered.get('feishu_sheets_info')
  await assert.rejects(
    () => definition.execute({}, { signal: undefined }),
    /必须提供 spreadsheetToken 或 url/,
  )
})

test('sheetId 与 sheetName 同时给出时报错', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registered } = await makeCtx()
  apply(ctx)

  const definition = registered.get('feishu_sheets_read')
  await assert.rejects(
    () => definition.execute(
      { spreadsheetToken: 'demo', sheetId: 'a', sheetName: 'b' },
      { signal: undefined },
    ),
    /只能填一个/,
  )
})
