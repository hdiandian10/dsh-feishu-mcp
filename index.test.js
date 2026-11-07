import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from './index.js'

test('认证状态只返回摘要字段，不透传 CLI 原始对象', () => {
  const result = __test.shapeAuthStatus({
    appId: 'cli_demo',
    identity: 'user',
    tokenType: 'user',
    identities: {
      user: { status: 'ready', userName: 'Test User', openId: 'ou_test', scope: 'a b c' },
      bot: { status: 'missing' },
    },
    accessToken: 'secret-value',
  })
  assert.equal(result.userStatus, 'ready')
  assert.equal(result.scopeCount, 3)
  assert.equal(Object.hasOwn(result, 'accessToken'), false)
  assert.equal(Object.hasOwn(result, 'raw'), false)
})

test('命令回显会遮罩凭证和敏感请求头', () => {
  const command = __test.commandLine([
    'drive', '+get', '--token', 'secret-token', '--header', 'Authorization: Bearer secret-value',
  ])
  assert.equal(command.includes('secret-token'), false)
  assert.equal(command.includes('secret-value'), false)
  assert.match(command, /--token \[REDACTED\]/)
  assert.match(command, /Authorization: \[REDACTED\]/)
})

test('诊断文本会完整替换密钥，避免截断泄漏', () => {
  const result = __test.redactDiagnostic('prefix secret-value suffix', ['secret-value'])
  assert.equal(result, 'prefix [REDACTED] suffix')
  assert.equal(result.includes('secret-value'), false)
})
