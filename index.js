/**
 * dsh-feishu-mcp —— 飞书 / Lark 连接器的 Host 半边。
 *
 * 职责有三件：
 * 1. 桥接 `lark-cli`：把 agent 发起的飞书调用翻译成 CLI 命令并执行，
 *    统一处理 `--json`、脱敏、审计与可逆性保护（不可逆操作先做快照再放行）；
 * 2. 注册 `feishu_auth_*` 系列工具，用 device flow 完成用户授权与状态查询；
 * 3. 挂载飞书相关技能（skills provider），把 lark-cli 的文档作为可检索资源暴露。
 *
 * ## 历史：为什么这里没有 lark-mcp 了
 *
 * 早先本插件同时挂两条链路：`lark-cli`（工具 `feishu_cli`）与官方
 * `@larksuiteoapi/lark-mcp` 子进程（工具 `mcp__feishu__*`）。
 *
 * lark-mcp 依赖 `keytar` 原生模块把 user token 存进系统凭据管理器。若 `keytar`
 * 未编译成功，其 StorageManager 会把 isInitializedStorageSuccess 置为 false，
 * saveStorageData() 直接 return —— 令牌只活在内存，子进程每次重启必然丢失，
 * 持续报 `Current user_access_token is invalid or expired`。
 *
 * 实测两条链路能力重叠，且读群 / 建表 / 读写单元格 / 查文档全部由 lark-cli 承担，
 * 因此 2026-11-07 彻底移除 lark-mcp：连接行、凭据表单、握手测试一并撤除。
 * 现行架构只有 lark-cli 一条路，令牌由它自行持久化并自动刷新。
 *
 * ## 为什么 connection 是惰性注入
 *
 * `connection` 只由 Web bundle 提供，headless / CLI profile 里不存在。
 * 静态 inject 会让本插件在那些 profile 里永久 pending，进而让整个 profile
 * 启动失败。因此用 `ctx.inject(['connection'], …)` 惰性挂载。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { appendAudit, auditPath } from './lib/audit.js'
import { RISK, classifyCommand, describeRisk, needsConfirmation } from './lib/risk.js'
import { createSkillProvider, readSkillMode } from './lib/skills.js'

export const name = 'feishu-mcp'

/**
 * 静态能力依赖。
 *
 * `tools` / `subprocess` 必须写在静态 `inject` 里而不是用 `ctx.inject()` 惰性挂载：
 * agent 的工具清单在插件 apply 阶段就装配完成，惰性回调晚于装配时机，
 * 注册的工具不会出现在清单中（实测：面板端点正常、工具完全不可见）。
 *
 * `connection` 不在静态列表里——它只由 Web bundle 提供，headless profile 没有，
 * 静态依赖会让本插件在那些 profile 里永久 pending。
 */
export const inject = ['subprocess', 'tools']

/** lark-cli 的安装位置（本插件自带的用户身份 CLI，与 Buddy 的互不干扰）。 */
const LARK_CLI_HOME = join(homedir(), '.dsh', 'lark-cli')
const LARK_CLI_ENTRY = join(LARK_CLI_HOME, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js')

/** 单次 CLI 调用超时。表格整表读取可能较慢，给足余量。 */
const CLI_TIMEOUT_MS = 120_000

/** RPC 端点名（Client 侧 `connection.rpc.call('/api', 'feishu-mcp', …)`）。 */
const ENDPOINT = 'feishu-mcp'

// ⛔ 2026-11-07 删除 LARK_HOME / LARK_CLI / LARK_CONFIG / HANDSHAKE_TIMEOUT_MS /
//    DEFAULT_DOMAIN / DEFAULT_TOOLS 六个常量。它们只被已删除的 lark-mcp 握手与凭据表单使用；
//    lark-cli 桥用的是下面的 LARK_CLI_HOME / LARK_CLI_ENTRY，与它们无关。

/**
 * 授权时请求的 scope 集。
 *
 * 实测：飞书 device flow 下，令牌拿到的 scope **等于应用已开通的全集**，请求
 * 范围只决定授权页展示什么。所以这里取最小只读集 —— 页面干净、不出现「需要
 * 申请」的条目，而实际能力仍由 feishu_cli 的风险分级把关。
 */
const AUTH_SCOPES = [
  'sheets:spreadsheet:readonly',
  'drive:drive.metadata:readonly',
  'wiki:node:read',
  'base:record:read',
  'docx:document:readonly',
  'offline_access',
]

/**
 * 把 `auth status --json` 的返回压成界面要的字段。
 *
 * `scope` 是一长串（172 项、几千字符），界面只关心数量，所以这里直接算成
 * count，不外传原文 —— 既省带宽也避免把权限清单摊到前端。
 */
function shapeAuthStatus(json) {
  const identities = json?.identities ?? {}
  const user = identities.user ?? {}
  const bot = identities.bot ?? {}
  const scopeCount = typeof user.scope === 'string' && user.scope.trim().length > 0
    ? user.scope.trim().split(/\s+/).length
    : 0
  return {
    appId: json?.appId,
    identity: json?.identity,
    tokenType: json?.tokenType,
    userStatus: user.status,
    userName: user.userName,
    userOpenId: user.openId,
    userTokenStatus: user.tokenStatus,
    expiresAt: user.expiresAt,
    refreshExpiresAt: user.refreshExpiresAt,
    scopeCount,
    botStatus: bot.status,
  }
}

/**
 * 定位 node 可执行文件。
 *
 * DSH 宿主可能跑在 Electron 里，此时 `process.execPath` 是应用 exe 而非 node；
 * 用 `ELECTRON_RUN_AS_NODE=1` 可以让它退化成语义等价的 node。但在 Windows 上
 * 这条路径不如直接用安装好的 bundled node 稳，所以优先找它。
 */
function resolveNodeBin() {
  const candidates = [
    process.env.DSH_NODE_BIN,
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
  ].filter((item) => typeof item === 'string' && item.length > 0)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { bin: candidate, electronShim: false }
  }
  // 兜底：宿主自身的可执行文件；Electron 下靠 ELECTRON_RUN_AS_NODE 当 node 用。
  return { bin: process.execPath, electronShim: true }
}

// ⛔ 2026-11-07 删除 parseConfigText（原 140-161 行）。它只被 loadConfig 调用，
//    而 loadConfig 已随凭据表单一起删除。原实现见 index.js.bak-20261107-145442。

/**
 * 抹掉诊断文本里的敏感串。
 *
 * 原用于握手错误的脱敏；握手已删除，但 `__test` 仍导出本函数，且它是通用工具，
 * 后续诊断信息仍可能用到，因此保留。
 */
function redactDiagnostic(value, secrets = []) {
  let text = String(value ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[REDACTED]')
  }
  return text
}

// ⛔ 2026-11-07 删除本段 lark-mcp 死代码（原 163-349 行）。
//    删除内容：loadConfig / writeConfigFile / validateAppId / parseConfigText 的调用方 /
//    runHandshake（手写 MCP 握手）。这些函数只服务于已移除的「凭据表单 + 测试握手」UI，
//    config.set 与 handshake.test 两个 RPC 分支也已在 handleMethod 中删除。
//    保留目标：feishu_cli 走 lark-cli，与此段无关。
//    完整原实现见 index.js.bak-before-tools / index.js.bak-20261107-145442。
// ---------------------------------------------------------------- lark-cli 桥

/**
 * 跑一次 `lark-cli`，返回 `{ ok, code, stdout, stderr, json }`。
 *
 * 为什么不用 shell 拼串：`--range A1:F30`、中文 sheet 名、带引号的 token 都会
 * 在 Windows 的 cmd 解析里被拆散；直接给 argv 数组没有 shell 参与。
 *
 * 为什么每次都显式传 `--format json`：lark-cli 默认就是 json，但显式写死能
 * 避免将来默认值变化导致解析失败。
 */
async function runLarkCli(ctx, args, { signal, cwd, timeoutMs } = {}) {
  const budgetMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLI_TIMEOUT_MS
  if (!existsSync(LARK_CLI_ENTRY)) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      json: null,
      error: `lark-cli 未安装：找不到 ${LARK_CLI_ENTRY}`,
      hint: '在 ~/.dsh/lark-cli 下执行 npm install @larksuite/cli',
    }
  }

  const { bin, electronShim } = resolveNodeBin()
  const handle = ctx.subprocess.spawn({
    argv: [bin, LARK_CLI_ENTRY, ...args],
    cwd: cwd ?? LARK_CLI_HOME,
    stdio: {
      stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
      stderr: { maxBytes: 512 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
    },
    graceMs: 3_000,
    signal,
    env: {
      ...process.env,
      // 关掉更新/技能提示，避免 `_notice` 污染 JSON 输出。
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      ...(electronShim ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { handle.terminate() } catch { /* 已退出 */ }
  }, budgetMs)

  let outcome
  try {
    outcome = await handle.done
  } finally {
    clearTimeout(timer)
  }

  const read = (reader) => {
    if (!reader) return ''
    try { return reader.readFrom(0).text ?? '' } catch { return '' }
  }
  const stdout = read(handle.collected?.stdout)
  const stderr = read(handle.collected?.stderr)

  // lark-cli 的成功信封是 `{ ok: true, data: ... }`，失败是 `{ ok: false, error: {...} }`。
  let json = null
  const trimmed = stdout.trim()
  if (trimmed.length > 0) {
    try { json = JSON.parse(trimmed) } catch { /* 非 JSON 输出，保留原文 */ }
  }

  const ok = outcome.exitCode === 0 && !timedOut && json?.ok !== false
  return {
    ok,
    code: outcome.exitCode,
    timedOut,
    stdout,
    stderr,
    json,
    error: timedOut
      ? `lark-cli 超过 ${Math.round(budgetMs / 1000)} 秒未返回`
      : json?.ok === false
        ? (json?.error?.message ?? 'lark-cli 返回失败')
        : undefined,
  }
}

/**
 * 从 CLI 的失败信封里抽出可行动信息。
 *
 * 飞书在缺权限时会给出 `missing_scopes` 与 `console_url`，这两个必须原样
 * 转给用户——它们是唯一能自助修复的入口。
 */
function describeCliFailure(result) {
  const err = result.json?.error
  if (!err) return result.error ?? result.stderr?.slice(-800) ?? '未知错误'
  const parts = [err.message ?? String(err)]
  if (Array.isArray(err.missing_scopes) && err.missing_scopes.length > 0) {
    parts.push(`缺少权限：${err.missing_scopes.join(', ')}`)
  }
  if (typeof err.console_url === 'string' && err.console_url.length > 0) {
    parts.push(`开通入口：${err.console_url}`)
  }
  if (typeof err.hint === 'string' && err.hint.length > 0) parts.push(err.hint)
  return parts.join('\n')
}

/** 表格定位参数：token 与 url 二选一，统一转成 CLI 的 flag。 */
function spreadsheetLocator(args) {
  const token = typeof args?.spreadsheetToken === 'string' ? args.spreadsheetToken.trim() : ''
  const url = typeof args?.url === 'string' ? args.url.trim() : ''
  if (token.length > 0 && url.length > 0) {
    throw new Error('spreadsheetToken 与 url 只能填一个')
  }
  if (token.length === 0 && url.length === 0) {
    throw new Error('必须提供 spreadsheetToken 或 url')
  }
  return token.length > 0 ? ['--spreadsheet-token', token] : ['--url', url]
}

/**
 * 剥掉值为 `undefined` 的键。
 *
 * DSH 要求工具输出是**无损 JSON**：`{ userName: undefined }` 会在序列化时
 * 直接抛 "value is not lossless JSON"。可选字段必须整键省略，不能留 undefined。
 */
function stripUndefined(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripUndefined).filter((item) => item !== undefined)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = stripUndefined(item)
  }
  return out
}

// ---------------------------------------------------------------- 网关辅助

/**
 * `--help` 文本缓存。
 *
 * 每个命令的 help 都要拉起一次进程（约 1 秒），而风险等级对同一个命令是常量，
 * 所以按 `domain action` 缓存，只付一次成本。
 */
const helpCache = new Map()

/** 补上 `--json`；已经有 `--json` 或 `--format` 就不动。 */
function ensureJsonFlag(argv) {
  const hasJson = argv.some((item) => item === '--json' || item === '--format' || item.startsWith('--format='))
  return hasJson ? argv.slice() : [...argv, '--json']
}

/** 取 `--flag value` 里的 value；没有就返回空串。 */
function flagValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index < 0) return ''
  const value = argv[index + 1]
  return typeof value === 'string' && !value.startsWith('-') ? value : ''
}

/** 需要从命令回显与审计日志中隐藏值的参数。 */
const SENSITIVE_FLAGS = new Set([
  '--token', '--spreadsheet-token', '--access-token', '--app-secret', '--client-secret',
  '--cookie', '--authorization', '--auth', '--password', '--secret', '--api-key',
])

/** 对命令参数做结构化脱敏，避免凭证进入模型上下文或 audit.jsonl。 */
function redactCommandArgv(argv) {
  const out = []
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index])
    const equals = item.indexOf('=')
    const flag = equals > 0 ? item.slice(0, equals) : item
    if (SENSITIVE_FLAGS.has(flag)) {
      out.push(flag, '[REDACTED]')
      if (equals < 0) index += 1
      continue
    }
    if (item.startsWith('--header=')) {
      const header = item.slice('--header='.length)
      out.push(header.includes(':') && /^(authorization|cookie|x-api-key):/i.test(header)
        ? `--header=${header.split(':', 1)[0]}: [REDACTED]`
        : item)
      continue
    }
    if (item === '--header' && typeof argv[index + 1] === 'string') {
      const header = argv[index + 1]
      out.push(item, /^(authorization|cookie|x-api-key):/i.test(header) ? `${header.split(':', 1)[0]}: [REDACTED]` : header)
      index += 1
      continue
    }
    out.push(item)
  }
  return out
}

/** 还原成可读命令行，带空格的参数加引号。 */
function commandLine(argv) {
  return redactCommandArgv(argv).map((item) => (/\s/.test(item) ? JSON.stringify(item) : item)).join(' ')
}

/** 单个字符串字段的保留上限：`auth status` 的 scope 串有 4k+ 字符，没有阅读价值。 */
const MAX_STRING_FIELD = 2_000

/**
 * 压缩返回值里的超长字符串。
 *
 * 典型受害者是 `auth status` 的 `scope`：172 个权限拼成一整串，把一次状态查询变成
 * 几千字。保留头部够识别即可，不是丢数据——需要全量时加 `--jq` 自己取。
 */
function compactData(value, depth = 0) {
  if (depth > 6) return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING_FIELD
      ? `${value.slice(0, 300)}…[+${value.length - 300} chars]`
      : value
  }
  if (Array.isArray(value)) return value.map((item) => compactData(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = compactData(item, depth + 1)
    return out
  }
  return value
}

/** 拉一条命令的 `--help`，失败返回空串（交给关键字兜底）。 */
async function resolveHelpText(ctx, argv, signal) {
  const head = argv.filter((item) => !item.startsWith('-')).slice(0, 2)
  if (head.length === 0) return ''
  const key = head.join(' ')
  const cached = helpCache.get(key)
  if (cached !== undefined) return cached
  const result = await runLarkCli(ctx, [...head, '--help'], { signal, timeoutMs: 20_000 })
  const text = result.stdout ?? ''
  if (result.ok && text.length > 0) helpCache.set(key, text)
  return text
}

/**
 * 写入前的旧值快照。
 *
 * 只覆盖「表格 + 明确 range + 明确 token」这一种最常见也最危险的情况：一旦写坏，
 * 审计日志里还有原值可以照着恢复。其它形态返回空串，不阻断主流程。
 */
async function snapshotBefore(ctx, argv, signal) {
  const head = argv.filter((item) => !item.startsWith('-'))[0]
  if (head !== 'sheets') return ''
  const range = flagValue(argv, '--range')
  const sheetId = flagValue(argv, '--sheet-id')
  const sheetName = flagValue(argv, '--sheet-name')
  const token = flagValue(argv, '--spreadsheet-token')
  const url = flagValue(argv, '--url')
  if (range.length === 0) return ''
  if (sheetId.length === 0 && sheetName.length === 0) return ''
  if (token.length === 0 && url.length === 0) return ''

  const readArgs = [
    'sheets', '+csv-get',
    ...(token.length > 0 ? ['--spreadsheet-token', token] : ['--url', url]),
    ...(sheetId.length > 0 ? ['--sheet-id', sheetId] : ['--sheet-name', sheetName]),
    '--range', range,
    '--json',
  ]
  const result = await runLarkCli(ctx, readArgs, { signal, timeoutMs: 30_000 })
  if (!result.ok) return ''
  const csv = result.json?.data?.annotated_csv
  return typeof csv === 'string' ? csv : ''
}

/** 不可逆操作被拦下时，用 `--dry-run` 给用户看清楚它到底要做什么。 */
async function tryDryRun(ctx, argv, signal) {
  const withoutJson = argv.filter((item) => item !== '--json')
  const result = await runLarkCli(ctx, [...withoutJson, '--dry-run', '--json'], { signal, timeoutMs: 20_000 })
  return result.json ?? null
}

// ⛔ 2026-11-07 删除 resolveCredentialInput（原 411-429 行）。它只服务于已移除的
//    config.set / handshake.test，且内部调用已删除的 loadConfig。原实现见 index.js.bak-20261107-145442。

/** 处理一条 RPC 调用。所有分支都必须返回可 JSON 序列化的普通对象。 */
async function handleMethod(method, payload, ctx) {
  switch (method) {
    // ⛔ 2026-11-07 移除 config.set / handshake.test 分支，并把 config.get 缩为纯诊断信息。
    //    原因：lark-mcp 链路已废弃（见 cordis.patch.yml 注释），凭据表单也已从 client.js 删除，
    //    这三个分支不再有任何调用方，且会去读已被删除的 ~/.dsh/lark-mcp/lark-config.json。
    //    完整原实现见 index.js.bak-20261107-*。
    case 'config.get': {
      return {
        ok: true,
        // 凭据由 lark-cli 自行管理，DSH 侧不再持有 App Secret。
        backend: 'lark-cli',
        configPath: LARK_CLI_HOME,
      }
    }

    // ------------------------------------------------------------ 连接（阶段 3）

    case 'auth.status': {
      if (!ctx) return { ok: false, error: '宿主上下文不可用，无法查询登录状态' }
      const result = await runLarkCli(ctx, ['auth', 'status', '--json', '--verify'], { timeoutMs: 30_000 })
      if (!result.json) return { ok: false, error: describeCliFailure(result) }
      return { ok: true, ...shapeAuthStatus(result.json) }
    }

    case 'auth.begin': {
      if (!ctx) return { ok: false, error: '宿主上下文不可用，无法发起授权' }
      // 只请最小集：令牌实际按应用已开通范围发放，请求范围仅影响授权页展示。
      const args = ['auth', 'login']
      for (const scope of AUTH_SCOPES) args.push('--scope', scope)
      args.push('--no-wait', '--json')
      const result = await runLarkCli(ctx, args, { timeoutMs: 45_000 })
      if (!result.json?.verification_url) {
        return { ok: false, error: describeCliFailure(result) }
      }
      let userCode = ''
      try {
        userCode = new URL(result.json.verification_url).searchParams.get('user_code') ?? ''
      } catch { /* 链接异常时留空，界面只展示链接 */ }
      return {
        ok: true,
        verificationUrl: result.json.verification_url,
        userCode,
        deviceCode: result.json.device_code,
        expiresIn: result.json.expires_in,
        scopes: AUTH_SCOPES,
      }
    }

    case 'auth.complete': {
      if (!ctx) return { ok: false, error: '宿主上下文不可用，无法完成授权' }
      const deviceCode = typeof payload?.deviceCode === 'string' ? payload.deviceCode.trim() : ''
      if (deviceCode.length === 0) return { ok: false, error: '缺少 deviceCode，请重新发起授权' }
      const result = await runLarkCli(ctx, ['auth', 'login', '--device-code', deviceCode, '--json'], { timeoutMs: 60_000 })
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      const json = result.json ?? {}
      return {
        ok: true,
        userName: json.user_name,
        userOpenId: json.user_open_id,
        newlyGranted: Array.isArray(json.newly_granted) ? json.newly_granted.length : 0,
      }
    }

    case 'auth.logout': {
      if (!ctx) return { ok: false, error: '宿主上下文不可用，无法退出登录' }
      const result = await runLarkCli(ctx, ['auth', 'logout', '--json'], { timeoutMs: 30_000 })
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      return { ok: true }
    }

    default:
      return { ok: false, error: `未知方法：${method}` }
  }
}

/** 注册 HTTP 端点。只接受 POST + JSON，与 DSH 其他管理端点同一套约定。 */
function registerEndpoint(ctx, connection) {
  connection.fetch.register({
    path: `/api/${ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      // ⚠️ 响应封装的字段名必须是 `result`：DSH 的 connection.rpc.call 按
      //    `{ type: 'server-response', rpcId, result }` 解包，写成 `payload`
      //    会让客户端永远拿不到值（Jet Hub 的 reply() 也是这个形状）。
      const reply = (payload) => new Response(JSON.stringify({
        type: 'server-response',
        rpcId,
        result: payload,
      }), { status: 200, headers: { 'content-type': 'application/json' } })

      if (
        message?.type !== 'client-request'
        || typeof message.rpcId !== 'string'
        || message.method !== ENDPOINT
        || !call || typeof call.method !== 'string'
      ) {
        return reply({ ok: false, error: { code: 'bad-request', message: 'Invalid request.', details: {} } })
      }

      try {
        return reply({ ok: true, value: await handleMethod(call.method, call.payload, ctx) })
      } catch (error) {
        ctx.logger?.warn?.(`[feishu-mcp] ${call.method} 失败：${error?.message ?? String(error)}`)
        return reply({
          ok: false,
          // ⚠️ `details` 不可省：connection 的 parseConnectionResponse 要求
          //    error.details 是对象，缺了会抛 invalid server-response failure。
          error: { code: 'internal', message: error?.message ?? String(error), details: {} },
        })
      }
    },
  })
}

export const __test = { redactDiagnostic, redactCommandArgv, commandLine, shapeAuthStatus, handleMethod, AUTH_SCOPES }

/**
 * 注册 agent 工具。
 *
 * 这层才是「Buddy 那种能力」的真正来源：lark-mcp（MCP 子进程）只有 im/docx/
 * wiki/bitable，**没有任何读取表格单元格的工具**，且飞书的 sheets:* 权限在
 * 平台层面只支持 user 身份 —— 所以表格必须走 lark-cli（用户身份）这条独立通路。
 *
 * 两者共存：MCP 继续提供 im/docx/bitable，本插件补上表格与身份管理。
 */
function registerTools(ctx) {
  // 所有 execute 的返回值都过一遍 stripUndefined：DSH 拒绝含 undefined 的输出。
  const tool = (definition) => ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      return stripUndefined(await definition.execute(args, exec))
    },
  })

  // ---------------------------------------------------------------- 身份

  tool({
    name: 'feishu_auth_status',
    description:
      '查询飞书 CLI 的登录状态：当前生效身份（user 用户 / bot 应用）、各自是否就绪、用户姓名与 open_id。' +
      '读飞书表格必须用 user 身份；若 user.status 是 missing，说明还没授权，需先调用 feishu_auth_login。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          identity: { type: 'string', description: '当前生效身份：user 或 bot' },
          userStatus: { type: 'string', description: 'user 身份状态：ready / missing / expired' },
          userName: { type: 'string' },
          userOpenId: { type: 'string' },
          botStatus: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `查询失败：${value.error ?? '未知错误'}` }]
        const lines = [
          `当前身份：${value.identity ?? '未知'}`,
          `用户身份：${value.userStatus ?? '未知'}${value.userName ? `（${value.userName}）` : ''}`,
          `应用身份：${value.botStatus ?? '未知'}`,
        ]
        if (value.userStatus !== 'ready') lines.push('', '⚠️ 用户身份未就绪，读表格会失败。请调用 feishu_auth_login 完成授权。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const result = await runLarkCli(ctx, ['auth', 'status', '--json', '--verify'], { signal: exec.signal })
      if (!result.json) {
        return { ok: false, error: describeCliFailure(result) }
      }
      const identities = result.json.identities ?? {}
      return {
        ok: true,
        identity: result.json.identity,
        userStatus: identities.user?.status,
        userName: identities.user?.userName,
        userOpenId: identities.user?.openId,
        botStatus: identities.bot?.status,
      }
    },
  })

  tool({
    name: 'feishu_auth_login',
    description:
      '发起飞书用户授权（设备码流程），返回一个授权链接和用户码。' +
      '用户需在浏览器打开链接并确认，授权后本机保存登录态，之后读表格即可用 user 身份。' +
      '链接 10 分钟内有效。默认只申请表格相关权限（sheets/drive/wiki），可用 domains 覆盖。',
    parameters: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: '业务域列表，默认 ["sheets","drive","wiki"]。可选：docs/im/calendar/task/base/contact 等。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          verificationUrl: { type: 'string', description: '授权链接，原样转给用户' },
          userCode: { type: 'string', description: '页面上的用户码' },
          deviceCode: { type: 'string', description: '设备码，授权后用它完成登录' },
          expiresIn: { type: 'integer', description: '有效期（秒）' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `发起授权失败：${value.error ?? '未知错误'}` }]
        return [{
          type: 'text',
          text: [
            '请打开下面的链接完成飞书授权：',
            value.verificationUrl ?? '',
            '',
            `用户码：${value.userCode ?? ''}`,
            `有效期：${Math.round((value.expiresIn ?? 600) / 60)} 分钟`,
            '',
            '授权完成后调用 feishu_auth_login_poll 并传入 deviceCode 收尾。',
          ].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const domains = Array.isArray(args?.domains) && args.domains.length > 0
        ? args.domains.filter((item) => typeof item === 'string')
        : ['sheets', 'drive', 'wiki']
      const result = await runLarkCli(
        ctx,
        ['auth', 'login', ...domains.flatMap((domain) => ['--domain', domain]), '--no-wait', '--json'],
        { signal: exec.signal },
      )
      const json = result.json
      if (!json?.verification_url) {
        return { ok: false, error: describeCliFailure(result) }
      }
      // user_code 藏在链接的 query 里，抽出来单独展示更方便用户核对。
      let userCode = ''
      try { userCode = new URL(json.verification_url).searchParams.get('user_code') ?? '' } catch { /* 保持空 */ }
      return {
        ok: true,
        verificationUrl: json.verification_url,
        userCode,
        deviceCode: json.device_code,
        expiresIn: json.expires_in,
      }
    },
  })

  tool({
    name: 'feishu_auth_login_poll',
    description:
      '在用户确认授权后调用，用 deviceCode 完成登录并保存用户身份。' +
      '成功返回后 feishu_sheets_* 系列工具才能读到数据。',
    parameters: {
      type: 'object',
      properties: {
        deviceCode: { type: 'string', description: 'feishu_auth_login 返回的 deviceCode' },
      },
      required: ['deviceCode'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          userName: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `授权未完成：${value.error ?? '未知错误'}` }]
        return [{ type: 'text', text: `授权成功${value.userName ? `，当前用户：${value.userName}` : ''}。现在可以读取表格了。` }]
      },
    },
    async execute(args, exec) {
      const deviceCode = typeof args?.deviceCode === 'string' ? args.deviceCode.trim() : ''
      if (deviceCode.length === 0) throw new Error('deviceCode 不能为空')
      const result = await runLarkCli(
        ctx,
        ['auth', 'login', '--device-code', deviceCode, '--json'],
        { signal: exec.signal },
      )
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      // 登录成功后回读一次状态，把用户名带回给模型；状态读取失败需要显式反馈。
      const status = await runLarkCli(ctx, ['auth', 'status', '--json'], { signal: exec.signal })
      if (!status.ok || !status.json) {
        return {
          ok: false,
          loginCompleted: true,
          error: `授权已完成，但登录状态读取失败：${describeCliFailure(status)}`,
        }
      }
      return { ok: true, userName: status.json?.identities?.user?.userName }
    },
  })

  // ---------------------------------------------------------------- 表格

  tool({
    name: 'feishu_sheets_info',
    description:
      '列出一个飞书电子表格的所有子表（sheet）：sheet_id、标题、行列数、是否隐藏、冻结状态。' +
      '读取任何表格内容前先调用本工具拿 sheet_id，再传给 feishu_sheets_read。',
    parameters: {
      type: 'object',
      properties: {
        spreadsheetToken: { type: 'string', description: '电子表格 token（与 url 二选一）' },
        url: { type: 'string', description: '电子表格完整链接（与 spreadsheetToken 二选一）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sheetId: { type: 'string' },
                title: { type: 'string' },
                rowCount: { type: 'integer' },
                columnCount: { type: 'integer' },
                hidden: { type: 'boolean' },
              },
              additionalProperties: true,
            },
          },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `读取子表失败：${value.error ?? '未知错误'}` }]
        const sheets = value.sheets ?? []
        if (sheets.length === 0) return [{ type: 'text', text: '该表格没有子表。' }]
        const lines = [`共 ${sheets.length} 个子表：`]
        for (const sheet of sheets) {
          lines.push(`  · ${sheet.title}（${sheet.sheetId}）${sheet.rowCount}×${sheet.columnCount}${sheet.hidden ? ' [隐藏]' : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const result = await runLarkCli(
        ctx,
        ['sheets', '+workbook-info', ...spreadsheetLocator(args), '--json'],
        { signal: exec.signal },
      )
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      const raw = result.json?.data ?? result.json
      const list = raw?.sheets ?? raw?.items ?? []
      return {
        ok: true,
        sheets: list.map((item) => ({
          sheetId: item.sheet_id ?? item.sheetId,
          title: item.title ?? item.name ?? item.sheet_name ?? item.sheetName ?? item.properties?.title,
          rowCount: item.row_count ?? item.grid_properties?.row_count ?? item.gridProperties?.rowCount,
          columnCount: item.column_count ?? item.grid_properties?.column_count ?? item.gridProperties?.columnCount,
          hidden: Boolean(item.is_hidden ?? item.hidden ?? item.properties?.hidden),
        })),
      }
    },
  })

  tool({
    name: 'feishu_sheets_read',
    description:
      '把一个飞书电子表格的区域读成 CSV（纯值，不含公式与样式）。' +
      '适合快速看数据、统计、给用户展示表格内容。需要公式/样式时改用 feishu_sheets_cells。' +
      '省略 range 时读取整张子表（按实际数据边界裁剪）。',
    parameters: {
      type: 'object',
      properties: {
        spreadsheetToken: { type: 'string', description: '电子表格 token（与 url 二选一）' },
        url: { type: 'string', description: '电子表格完整链接（与 spreadsheetToken 二选一）' },
        sheetId: { type: 'string', description: '子表 id（与 sheetName 二选一），先用 feishu_sheets_info 获取' },
        sheetName: { type: 'string', description: '子表名称（与 sheetId 二选一）' },
        range: { type: 'string', description: 'A1 表示法区域，如 A1:F30。不写 sheet 前缀。省略则读整表。' },
        skipHidden: { type: 'boolean', description: '是否跳过隐藏的行列，默认 false' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          csv: { type: 'string', description: 'CSV 文本，每行带 [row=N] 前缀' },
          actualRange: { type: 'string', description: '实际读取到的区域' },
          rowCount: { type: 'integer' },
          hasMore: { type: 'boolean', description: '是否因大小限制被截断' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `读取失败：${value.error ?? '未知错误'}` }]
        const head = value.actualRange ? `区域 ${value.actualRange}，共 ${value.rowCount ?? '?'} 行` : `共 ${value.rowCount ?? '?'} 行`
        const body = String(value.csv ?? '').slice(0, 12_000)
        const more = String(value.csv ?? '').length > 12_000 ? '\n…（内容较长，已截断显示）' : ''
        return [{ type: 'text', text: `${head}\n\n${body}${more}` }]
      },
    },
    async execute(args, exec) {
      const sheetArgs = []
      const sheetId = typeof args?.sheetId === 'string' ? args.sheetId.trim() : ''
      const sheetName = typeof args?.sheetName === 'string' ? args.sheetName.trim() : ''
      if (sheetId.length > 0 && sheetName.length > 0) throw new Error('sheetId 与 sheetName 只能填一个')
      if (sheetId.length === 0 && sheetName.length === 0) throw new Error('必须提供 sheetId 或 sheetName')
      if (sheetId.length > 0) sheetArgs.push('--sheet-id', sheetId)
      else sheetArgs.push('--sheet-name', sheetName)

      const range = typeof args?.range === 'string' ? args.range.trim() : ''
      if (range.length > 0) sheetArgs.push('--range', range)
      if (args?.skipHidden === true) sheetArgs.push('--skip-hidden')

      const result = await runLarkCli(
        ctx,
        ['sheets', '+csv-get', ...spreadsheetLocator(args), ...sheetArgs, '--json'],
        { signal: exec.signal },
      )
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      const data = result.json?.data ?? result.json
      const csv = typeof data?.csv === 'string'
        ? data.csv
        : typeof data?.annotated_csv === 'string'
          ? data.annotated_csv
          : typeof data?.values === 'object' && data.values !== null
            ? JSON.stringify(data.values)
            : String(result.stdout ?? '')
      return {
        ok: true,
        csv,
        actualRange: data?.actual_range ?? data?.range,
        rowCount: typeof csv === 'string' ? csv.split(/\r?\n/).length : undefined,
        hasMore: Boolean(data?.has_more),
      }
    },
  })

  tool({
    name: 'feishu_sheets_cells',
    description:
      '读取飞书电子表格区域的完整信息：值、公式、样式、批注。' +
      '需要看公式或格式时用本工具；只看数据用 feishu_sheets_read 更快。',
    parameters: {
      type: 'object',
      properties: {
        spreadsheetToken: { type: 'string', description: '电子表格 token（与 url 二选一）' },
        url: { type: 'string', description: '电子表格完整链接（与 spreadsheetToken 二选一）' },
        sheetId: { type: 'string', description: '子表 id（与 sheetName 二选一）' },
        sheetName: { type: 'string', description: '子表名称（与 sheetId 二选一）' },
        range: { type: 'string', description: '必填，A1 区域如 A1:F10（不带 sheet 前缀）' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: '要包含的信息类别：value / formula / style / comment / data_validation / conditional_format。默认 ["value","formula"]',
        },
      },
      required: ['range'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          cells: { type: 'object', additionalProperties: true, description: 'CLI 返回的单元格数据' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.ok === false) return [{ type: 'text', text: `读取失败：${value.error ?? '未知错误'}` }]
        return [{ type: 'text', text: JSON.stringify(value.cells, null, 2).slice(0, 12_000) }]
      },
    },
    async execute(args, exec) {
      const range = typeof args?.range === 'string' ? args.range.trim() : ''
      if (range.length === 0) throw new Error('range 不能为空')

      const sheetArgs = []
      const sheetId = typeof args?.sheetId === 'string' ? args.sheetId.trim() : ''
      const sheetName = typeof args?.sheetName === 'string' ? args.sheetName.trim() : ''
      if (sheetId.length > 0 && sheetName.length > 0) throw new Error('sheetId 与 sheetName 只能填一个')
      if (sheetId.length === 0 && sheetName.length === 0) throw new Error('必须提供 sheetId 或 sheetName')
      if (sheetId.length > 0) sheetArgs.push('--sheet-id', sheetId)
      else sheetArgs.push('--sheet-name', sheetName)

      const include = Array.isArray(args?.include) && args.include.length > 0
        ? args.include.filter((item) => typeof item === 'string')
        : ['value', 'formula']

      const result = await runLarkCli(
        ctx,
        [
          'sheets', '+cells-get',
          ...spreadsheetLocator(args),
          ...sheetArgs,
          '--range', range,
          '--include', include.join(','),
          '--json',
        ],
        { signal: exec.signal },
      )
      if (!result.ok) return { ok: false, error: describeCliFailure(result) }
      return { ok: true, cells: result.json?.data ?? result.json }
    },
  })

  // ---------------------------------------------------------------- 通用网关

  tool({
    name: 'feishu_cli',
    description:
      '执行任意 lark-cli 命令，覆盖飞书全产品能力（文档、电子表格、多维表格、消息、日历、任务、审批、云盘、知识库等）。' +
      '不熟悉命令时先用 args=["<domain>","--help"] 或 ["skills","list"] 查。' +
      '风险规则：只读命令直接执行；可回退的写入会先快照旧值；不可逆命令（删除、清空、改权限）默认拒绝，必须传 confirm:true。' +
      '示例：["sheets","+csv-get","--spreadsheet-token","xxx","--sheet-id","yyy","--range","A1:T30"]。',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'lark-cli 的参数数组，不带 shell 引号，例如 ["sheets","+csv-get","--range","A1:B2"]',
        },
        as: { type: 'string', enum: ['user', 'bot'], description: '调用身份，默认按 CLI 当前配置（通常是 user）' },
        dryRun: { type: 'boolean', description: '只预览请求，不真正执行' },
        confirm: { type: 'boolean', description: '不可逆操作必须显式传 true 才会执行' },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 120000' },
      },
      required: ['args'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          blocked: { type: 'boolean', description: '是否被风险策略拦下' },
          dryRun: { type: 'boolean' },
          risk: { type: 'string', description: 'read / write / destructive / unknown' },
          command: { type: 'string' },
          identity: { type: 'string' },
          revision: { type: 'integer', description: '写操作之后的文档版本号' },
          data: { type: 'object', additionalProperties: true },
          preview: { type: 'object', additionalProperties: true },
          before: { type: 'string', description: '写入前的旧值快照（CSV）' },
          error: { type: 'string' },
          durationMs: { type: 'integer' },
          auditPath: { type: 'string' },
          auditWritten: { type: 'boolean', description: '审计记录是否成功写入' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.blocked === true) {
          const preview = value.preview
            ? JSON.stringify(value.preview).slice(0, 2_000)
            : '（该命令不支持 --dry-run 预览）'
          return [{
            type: 'text',
            text: `已拦截（${value.risk}）：${value.command}\n${value.error ?? ''}\n\n将要执行的内容：\n${preview}`,
          }]
        }
        if (value.ok === false) {
          return [{ type: 'text', text: `执行失败：${value.command}\n${value.error ?? '未知错误'}` }]
        }
        const head = `✅ ${value.command}${value.revision ? `（revision ${value.revision}）` : ''}`
        return [{ type: 'text', text: `${head}\n${JSON.stringify(value.data, null, 2).slice(0, 8_000)}` }]
      },
    },
    async execute(args, exec) {
      const raw = args?.args
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('args 必须是非空数组，例如 ["sheets","+csv-get","--range","A1:B2"]')
      }
      const argv = raw.map((item) => String(item))
      if (argv.some((item) => item.trim().length === 0)) throw new Error('args 里不能有空参数')

      // 授权必须走专用工具：那里封装了设备码轮询和配置落盘，散着调容易把登录态搞坏。
      if (argv[0] === 'auth' && argv.some((item) => item === 'login' || item === 'logout')) {
        throw new Error('授权相关操作请用 feishu_auth_status / feishu_auth_login / feishu_auth_login_poll')
      }

      const as = args?.as
      if (as !== undefined && as !== 'user' && as !== 'bot') throw new Error('as 只能是 user 或 bot')

      const finalArgs = ensureJsonFlag(as ? [...argv, '--as', as] : argv)
      const helpText = await resolveHelpText(ctx, finalArgs, exec.signal)
      const classified = classifyCommand({ argv: finalArgs, helpText })
      const command = commandLine(finalArgs)

      if (needsConfirmation(classified.risk) && args?.confirm !== true) {
        const preview = await tryDryRun(ctx, finalArgs, exec.signal)
        // 被拦截的尝试也要留痕：反复试探越界本身就是值得追的信号。
        const auditWritten = appendAudit({
          risk: classified.risk,
          command,
          identity: as ?? 'auto',
          ok: false,
          blocked: true,
          error: '被可逆性保护策略拦截',
        })
        return {
          ok: false,
          blocked: true,
          risk: classified.risk,
          command,
          preview,
          auditWritten,
          auditPath: auditPath(),
          error: `${describeRisk(classified.risk)}。确认无误后传 confirm:true 再执行。`,
        }
      }

      if (args?.dryRun === true) {
        const preview = await tryDryRun(ctx, finalArgs, exec.signal)
        return { ok: preview !== null, dryRun: true, risk: classified.risk, command, preview }
      }

      const startedAt = Date.now()
      // 只在可回退的写入上取快照；只读没必要，不可逆的直接被拦。
      const before = classified.risk === RISK.WRITE ? await snapshotBefore(ctx, finalArgs, exec.signal) : ''
      const result = await runLarkCli(ctx, finalArgs, { signal: exec.signal, timeoutMs: args?.timeoutMs })
      const revision = result.json?.data?.revision

      const auditWritten = appendAudit({
        risk: classified.risk,
        command,
        identity: as ?? 'auto',
        ok: result.ok,
        revision,
        before,
        error: result.ok ? undefined : describeCliFailure(result),
      })

      if (!result.ok) {
        return {
          ok: false,
          risk: classified.risk,
          command,
          error: describeCliFailure(result),
          revision,
          auditPath: auditPath(),
          auditWritten,
        }
      }

      // 整表读取可能几十万字符，直接塞进上下文会挤掉真正需要的信息。
      const payload = compactData(result.json?.data ?? result.json)
      const serialized = JSON.stringify(payload ?? null)
      const data = serialized.length > 120_000
        ? {
          truncated: true,
          note: `原始返回 ${serialized.length} 字符，已截断；请缩小 --range 或加 --jq 过滤`,
          preview: serialized.slice(0, 60_000),
        }
        : payload

      return {
        ok: true,
        risk: classified.risk,
        command,
        identity: result.json?.identity ?? as ?? 'auto',
        revision,
        data,
        before,
        durationMs: Date.now() - startedAt,
        auditPath: auditPath(),
        auditWritten,
      }
    },
  })
}

/**
 * 把 lark-cli 内置的 skill 接到 DSH 的能力目录里。
 *
 * 规模由 `~/.dsh/feishu-mcp/settings.json` 的 `skillsMode` 决定（core / all / off），
 * 在插件加载时读取，改配置需要重启 DSH 才生效。
 *
 * **为什么走惰性注入而不是静态 inject**：`skills` 服务只在带 skill 能力的 profile
 * 里存在。写进静态 inject 的话，缺这个服务的 profile 会让整个插件永久 pending，
 * 连 `feishu_cli` 和表格工具一起消失——那是比「skill 没挂上」严重得多的故障。
 */
function registerSkills(ctx, skills) {
  if (!skills || typeof skills.registerProvider !== 'function') {
    ctx.logger?.warn?.('skills 能力不可用，跳过飞书 skill provider 注册')
    return
  }
  const mode = readSkillMode()
  if (mode === 'off') return

  // provider 只建一次：内部有 list 缓存，反复 new 会让缓存失效。
  const provider = createSkillProvider({
    mode,
    runCli: (args, options = {}) => runLarkCli(ctx, args, {
      signal: options.signal,
      timeoutMs: 30_000,
    }),
  })
  skills.registerProvider(() => provider)
}

export function apply(ctx) {
  // 工具必须在插件加载时**同步**注册：agent 的工具清单在会话建立时就固化了，
  // 晚于此时注册的工具不会出现在清单里（这也是 ego 插件用静态 inject 的原因）。
  registerTools(ctx)
  // skill provider 与 connection 一样惰性挂载：能力缺失时只少功能，不拖垮插件。
  ctx.inject(['skills'], (scoped) => {
    registerSkills(ctx, scoped.skills)
  })
  // 面板端点：`connection` 只由 Web bundle 提供，必须惰性挂载，
  // 否则 headless profile 里本插件会永久 pending。
  ctx.inject(['connection'], (scoped) => {
    registerEndpoint(ctx, scoped.connection)
  })
}
