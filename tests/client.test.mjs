import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const clientPath = new URL('../client.js', import.meta.url)
const source = await fs.readFile(clientPath, 'utf8')

const Fragment = Symbol('Fragment')

function createReactRuntime() {
  const slots = []
  let cursor = 0
  let root
  let renderRoot
  let effectDeps = []
  let callbackDeps = []
  let cleanups = []

  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const normalized = children.flat(Infinity).filter((child) => child !== null && child !== false && child !== undefined)
      if (typeof type === 'function') return type({ ...(props ?? {}), children: normalized })
      return { type, props: props ?? {}, children: normalized }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        renderRoot()
      }
      return [slots[index], setState]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn, deps) {
      const index = cursor++
      const changed = !callbackDeps[index] || !deps || deps.some((value, i) => value !== callbackDeps[index].deps[i])
      if (changed) {
        slots[index] = { fn, deps }
        callbackDeps[index] = slots[index]
      }
      return slots[index].fn
    },
    useEffect(effect, deps) {
      const index = cursor++
      const changed = !effectDeps[index] || !deps || deps.some((value, i) => value !== effectDeps[index][i])
      if (changed) {
        cleanups[index]?.()
        effectDeps[index] = deps
        // React runs effects after the render commits. Deferring here prevents
        // synchronous state updates at the start of an async effect from
        // recursively re-entering the render stub.
        queueMicrotask(() => { cleanups[index] = effect() })
      }
    },
  }

  function mount(Component, props = {}) {
    renderRoot = () => {
      cursor = 0
      root = Component(props)
      return root
    }
    renderRoot()
    return { get root() { return root }, rerender: renderRoot }
  }
  return { React, mount }
}

async function loadPanel() {
  const runtime = createReactRuntime()
  let Panel
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(module) {
          const result = module.factory((name) => {
            assert.equal(name, 'react')
            return runtime.React
          })
          const ctx = {
            slots: {
              inject(name, callback) {
                if (name === 'main') callback()
              },
              register(definition, component) {
                if (definition.key === 'feishu-mcp') Panel = component
                return definition
              },
            },
            inject(_dependencies, callback) {
              callback({ connection: {} })
            },
          }
          result.apply(ctx)
        },
      },
    },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(typeof Panel, 'function')
  return { Panel, runtime }
}

function walk(node, output = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return output
  if (typeof node === 'string' || typeof node === 'number') {
    output.push(node)
    return output
  }
  if (node.type !== Fragment) output.push(node)
  for (const child of node.children ?? []) walk(child, output)
  return output
}

function text(root) {
  return walk(root).filter((item) => typeof item === 'string' || typeof item === 'number').join('')
}

function elements(root, predicate = () => true) {
  return walk(root).filter((item) => typeof item === 'object' && predicate(item))
}

function findButton(root, label) {
  return elements(root, (node) => node.type === 'button' && text(node) === label)[0]
}

function findInput(root, id) {
  return elements(root, (node) => node.type === 'input' && node.props.id === id)[0]
}

// ⛔ 2026-11-07 删除 changeInput 辅助函数：凭据表单移除后已无任何用例调用它。

const tick = () => new Promise((resolve) => setImmediate(resolve))

function mountWithRpc(rpcCall, options = {}) {
  return loadPanel().then(({ Panel, runtime }) => {
    // 面板挂载时会同时读配置和登录状态。这里的用例多数只关心配置，
    // 所以给 auth.status 一个默认应答，避免每个用例都重复写。
    const call = async (method, payload) => {
      if (method === 'auth.status' && options.handleAuth !== true) {
        return options.authStatus ?? { ok: true, userStatus: 'missing', scopeCount: 0 }
      }
      return rpcCall(method, payload)
    }
    const mounted = runtime.mount(Panel, { rpcCall: call })
    return { mounted, runtime, ...options }
  })
}

const savedConfig = (overrides = {}) => ({
  backend: 'lark-cli',
  configPath: 'C:\\Users\\test\\.dsh\\lark-cli',
  ...overrides,
})

test('config load failure can be retried and then renders the panel', async () => {
  let calls = 0
  const mounted = await mountWithRpc(async (method) => {
    assert.equal(method, 'config.get')
    calls++
    if (calls === 1) throw new Error('temporary failure')
    return savedConfig()
  })
  await tick()
  assert.match(text(mounted.mounted.root), /状态读取失败/)
  const retry = findButton(mounted.mounted.root, '重新读取')
  assert.ok(retry)
  retry.props.onClick()
  await tick()
  assert.equal(calls, 2)
  assert.doesNotMatch(text(mounted.mounted.root), /状态读取失败/)
})

test('a rejected config response shows retry without leaking empty form fields', async () => {
  const mounted = await mountWithRpc(async () => ({ ok: false, error: 'invalid configuration' }))
  await tick()
  assert.match(text(mounted.mounted.root), /状态读取失败/)
  // 凭据表单已移除：任何情况下都不该再出现 App ID / App Secret 输入框。
  assert.equal(findInput(mounted.mounted.root, 'feishu-appId'), undefined)
  assert.equal(findInput(mounted.mounted.root, 'feishu-appSecret'), undefined)
  assert.equal(findButton(mounted.mounted.root, '保存配置'), undefined)
  assert.ok(findButton(mounted.mounted.root, '重新读取'))
})

test('凭据表单与握手按钮已彻底移除，页面不再出现这些控件', async () => {
  const mounted = await mountWithRpc(async () => savedConfig())
  await tick()
  assert.equal(findInput(mounted.mounted.root, 'feishu-appId'), undefined)
  assert.equal(findInput(mounted.mounted.root, 'feishu-appSecret'), undefined)
  assert.equal(findInput(mounted.mounted.root, 'feishu-tools'), undefined)
  assert.equal(findButton(mounted.mounted.root, '保存配置'), undefined)
  assert.equal(findButton(mounted.mounted.root, '测试 MCP 握手'), undefined)
})

test('config.get 只用于诊断，不再回传凭据字段', async () => {
  const calls = []
  const mounted = await mountWithRpc(async (method, payload) => {
    calls.push({ method, payload })
    return savedConfig()
  })
  await tick()
  // 只应拉取一次配置，且不存在任何写入/握手类调用。
  assert.deepEqual(calls.map((call) => call.method), ['config.get'])
  assert.equal(calls.some((call) => call.method === 'config.set'), false)
  assert.equal(calls.some((call) => call.method === 'handshake.test'), false)
})

test('面板展示当前后端为 lark-cli，避免让人误以为仍在用 MCP', async () => {
  const mounted = await mountWithRpc(async () => savedConfig())
  await tick()
  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /lark-cli/)
  assert.doesNotMatch(rootText, /飞书 MCP/)
})

test('诊断信息展示配置路径', async () => {
  const mounted = await mountWithRpc(async () => savedConfig())
  await tick()
  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /诊断信息/)
  assert.match(rootText, /lark-cli/)
})

// ---------------------------------------------------------------- 连接卡片

test('未登录时展示授权入口', async () => {
  const mounted = await mountWithRpc(async () => savedConfig())
  await tick()
  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /连接/)
  assert.match(rootText, /未连接/)
  assert.ok(findButton(mounted.mounted.root, '授权登录'))
  assert.equal(findButton(mounted.mounted.root, '我已完成授权'), undefined)
})

test('已登录时展示账号与到期时间', async () => {
  const mounted = await mountWithRpc(async () => savedConfig(), {
    authStatus: {
      ok: true,
      userStatus: 'ready',
      userName: '张明',
      expiresAt: '2026-11-02T21:35:37+08:00',
      scopeCount: 172,
    },
  })
  await tick()
  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /飞书账号已授权/)
  assert.match(rootText, /张明/)
  assert.match(rootText, /172 项/)
  assert.ok(findButton(mounted.mounted.root, '重新授权'))
})

test('点击授权登录会拿到链接与用户码', async () => {
  const calls = []
  const mounted = await mountWithRpc(async (method, payload) => {
    if (method === 'config.get') return savedConfig()
    calls.push({ method, payload })
    if (method === 'auth.status') return { ok: true, userStatus: 'missing', scopeCount: 0 }
    if (method === 'auth.begin') {
      return {
        ok: true,
        verificationUrl: 'https://accounts.example.com/verify?user_code=AB12',
        userCode: 'AB12',
        deviceCode: 'dc-1',
        expiresIn: 600,
      }
    }
    return { ok: true }
  }, { handleAuth: true })
  await tick()

  const button = findButton(mounted.mounted.root, '授权登录')
  assert.ok(button)
  button.props.onClick()
  await tick()

  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /accounts\.example\.com\/verify/)
  assert.match(rootText, /AB12/)
  assert.ok(findButton(mounted.mounted.root, '我已完成授权'))
  assert.ok(calls.some((call) => call.method === 'auth.begin'))
})

test('完成授权会用 deviceCode 收尾并刷新状态', async () => {
  let statusCalls = 0
  let completedPayload = null
  const mounted = await mountWithRpc(async (method, payload) => {
    if (method === 'config.get') return savedConfig()
    if (method === 'auth.status') {
      statusCalls++
      return statusCalls > 1
        ? { ok: true, userStatus: 'ready', userName: '张明', scopeCount: 172 }
        : { ok: true, userStatus: 'missing', scopeCount: 0 }
    }
    if (method === 'auth.begin') {
      return { ok: true, verificationUrl: 'https://x.example/y', userCode: 'CD34', deviceCode: 'dc-9', expiresIn: 600 }
    }
    if (method === 'auth.complete') {
      completedPayload = payload
      return { ok: true, userName: '张明' }
    }
    return { ok: true }
  }, { handleAuth: true })
  await tick()

  findButton(mounted.mounted.root, '授权登录').props.onClick()
  await tick()
  const finish = findButton(mounted.mounted.root, '我已完成授权')
  assert.ok(finish)
  finish.props.onClick()
  await tick()

  assert.equal(completedPayload?.deviceCode, 'dc-9')
  assert.match(text(mounted.mounted.root), /授权完成：张明/)
  assert.match(text(mounted.mounted.root), /飞书账号已授权/)
})

test('再次进入面板时命中缓存，不重复拉取状态', async () => {
  const { Panel, runtime } = await loadPanel()
  let statusCalls = 0
  // 同一个 rpcCall 实例：生产环境里它由 apply() 创建一次，跨挂载是同一个。
  const rpc = async (method) => {
    if (method === 'auth.status') {
      statusCalls++
      return { ok: true, userStatus: 'ready', userName: '张明', scopeCount: 172 }
    }
    return savedConfig()
  }
  const first = runtime.mount(Panel, { rpcCall: rpc })
  await tick()
  assert.equal(statusCalls, 1)
  assert.match(text(first.root), /张明/)

  const second = runtime.mount(Panel, { rpcCall: rpc })
  await tick()
  assert.equal(statusCalls, 1, '第二次进入应直接读缓存')
  assert.match(text(second.root), /张明/)
})

test('状态读取失败时显示「状态未知」而不是「未连接」', async () => {
  const mounted = await mountWithRpc(async (method) => {
    if (method === 'config.get') return savedConfig()
    throw new Error('network down')
  }, { handleAuth: true })
  await tick()
  const rootText = text(mounted.mounted.root)
  assert.match(rootText, /状态未知/)
  assert.match(rootText, /读取失败/)
  assert.doesNotMatch(rootText, /未连接/)
  assert.ok(findButton(mounted.mounted.root, '重试'))
})
