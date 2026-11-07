/**
 * 连接（登录）相关 RPC 的测试。
 *
 * 用假的 subprocess 回放 lark-cli 的输出，保证断言不依赖真实的登录态——
 * 真实令牌过期或换机会让测试变成随机失败，那是测试设计的问题。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { handleMethod, shapeAuthStatus, AUTH_SCOPES } = await import('../index.js').then((mod) => mod.__test)

/** 造一个只回放固定 stdout 的假 subprocess。 */
function makeCtx(stdout, { exitCode = 0 } = {}) {
  return {
    logger: { warn() {}, info() {} },
    subprocess: {
      spawn() {
        const done = Promise.resolve({ exitCode, signal: null })
        return {
          done,
          terminate() {},
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
  }
}

const STATUS_JSON = JSON.stringify({
  ok: true,
  appId: 'cli_test123',
  identity: 'user',
  tokenType: 'DPoP',
  identities: {
    bot: { status: 'ready' },
    user: {
      status: 'ready',
      userName: '张明',
      openId: 'ou_test',
      tokenStatus: 'valid',
      scope: 'a b c d e',
      expiresAt: '2026-11-02T21:35:37+08:00',
      refreshExpiresAt: '2026-11-09T19:35:37+08:00',
    },
  },
})

test('shapeAuthStatus 只输出界面需要的字段，不外传 scope 原文', () => {
  const shaped = shapeAuthStatus(JSON.parse(STATUS_JSON))
  assert.equal(shaped.userName, '张明')
  assert.equal(shaped.userStatus, 'ready')
  assert.equal(shaped.scopeCount, 5)
  assert.equal(Object.hasOwn(shaped, 'scope'), false, 'scope 原文不应该透给前端')
  assert.equal(shaped.appId, 'cli_test123')
})

test('auth.status 正常返回身份与权限数量', async () => {
  const value = await handleMethod('auth.status', {}, makeCtx(STATUS_JSON))
  assert.equal(value.ok, true)
  assert.equal(value.userName, '张明')
  assert.equal(value.scopeCount, 5)
})

test('auth.status 在缺 ctx 时给出可读错误', async () => {
  const value = await handleMethod('auth.status', {}, undefined)
  assert.equal(value.ok, false)
  assert.match(value.error, /宿主上下文/)
})

test('auth.begin 返回链接、用户码与 deviceCode', async () => {
  const payload = JSON.stringify({
    device_code: 'dc-abc',
    expires_in: 600,
    verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=x&user_code=AB12-CD34',
  })
  const value = await handleMethod('auth.begin', {}, makeCtx(payload))
  assert.equal(value.ok, true)
  assert.equal(value.userCode, 'AB12-CD34', '用户码应从链接里抽出来')
  assert.equal(value.deviceCode, 'dc-abc')
  assert.equal(value.expiresIn, 600)
  assert.ok(Array.isArray(value.scopes) && value.scopes.length === AUTH_SCOPES.length)
})

test('auth.begin 在 CLI 没给链接时报错', async () => {
  const value = await handleMethod('auth.begin', {}, makeCtx(JSON.stringify({ ok: false, error: { message: 'boom' } })))
  assert.equal(value.ok, false)
  assert.match(value.error, /boom/i)
})

test('auth.complete 缺 deviceCode 时拒绝', async () => {
  const value = await handleMethod('auth.complete', {}, makeCtx('{}'))
  assert.equal(value.ok, false)
  assert.match(value.error, /deviceCode/)
})

test('auth.complete 成功返回用户名', async () => {
  const payload = JSON.stringify({ event: 'authorization_complete', user_name: '张明', user_open_id: 'ou_test', newly_granted: ['a'] })
  const value = await handleMethod('auth.complete', { deviceCode: 'dc-abc' }, makeCtx(payload))
  assert.equal(value.ok, true)
  assert.equal(value.userName, '张明')
  assert.equal(value.newlyGranted, 1)
})

test('授权请求只索取最小只读 scope', () => {
  for (const scope of AUTH_SCOPES) {
    assert.ok(
      scope.includes(':readonly') || scope.includes(':read') || scope === 'offline_access',
      `${scope} 不是只读 scope`,
    )
  }
})
