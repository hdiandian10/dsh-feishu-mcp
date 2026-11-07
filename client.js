/* Independent Feishu configuration panel. Host RPC never returns the saved secret. */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 主题自适应令牌：用 currentColor 混出层次，亮色/暗色自动跟随，
    // 不依赖 DSH 是否暴露颜色变量（实测只有布局变量，没有 color 变量）。
    // 强调色取飞书品牌蓝 #3370ff，让面板有产品识别度。
    const mix = (percent) => `color-mix(in srgb, currentColor ${percent}%, transparent)`
    const line = mix(12)
    const border = `1px solid ${line}`
    const ACCENT = '#3370ff'
    const SUCCESS = '#00b578'
    const DANGER = '#e5484d'
    const styles = {
      page: { height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: 'clamp(24px, 4vw, 56px) clamp(20px, 4vw, 40px) 64px' },
      content: { maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 },
      card: {
        border,
        borderRadius: 16,
        padding: 'clamp(18px, 2.4vw, 22px)',
        background: mix(2.5),
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxShadow: '0 1px 2px rgba(16, 24, 40, .04)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      between: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
      hint: { fontSize: 12.5, color: mix(60), lineHeight: 1.6, margin: 0 },
      fieldLabel: { display: 'block', fontSize: 12.5, fontWeight: 600, color: mix(70), marginBottom: 6 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '9px 12px',
        border,
        borderRadius: 10,
        background: mix(3),
        color: 'inherit',
        font: 'inherit',
        fontSize: 13.5,
        outline: 'none',
      },
      primary: {
        padding: '9px 16px',
        border: '1px solid transparent',
        borderRadius: 10,
        background: ACCENT,
        color: '#fff',
        font: 'inherit',
        fontSize: 13.5,
        fontWeight: 500,
        cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(51, 112, 255, .3)',
      },
      button: {
        padding: '9px 16px',
        border,
        borderRadius: 10,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13.5,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border,
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: 11.5,
        color: mix(65),
        whiteSpace: 'nowrap',
      },
      dot: (color) => ({ width: 7, height: 7, borderRadius: 999, background: color, boxShadow: `0 0 0 3px ${color}26`, flex: 'none' }),
      error: { color: DANGER, fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
        color: mix(70),
        margin: 0,
      },
      metaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 },
      metaLabel: { fontSize: 11, color: mix(55), letterSpacing: '.03em', marginBottom: 4 },
      metaValue: { fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' },
      divider: { height: 1, background: line, border: 0, margin: 0 },
      summary: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        fontSize: 13,
        color: mix(70),
        userSelect: 'none',
        listStyle: 'none',
      },
    }
    /** 时间戳转本地可读；解析失败就原样显示，不让界面炸掉。 */
    function formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString('zh-CN', { hour12: false })
    }
    function Field({ id, label, hint, children }) {
      return h('div', null,
        h('label', { htmlFor: id, style: styles.fieldLabel }, label),
        children,
        hint ? h('p', { id: `${id}-hint`, style: { ...styles.hint, marginTop: 6 } }, hint) : null)
    }
    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 7, height: 14, rx: 2 }),
        h('rect', { x: 14, y: 5, width: 7, height: 14, rx: 2 }),
        h('path', { d: 'M8 12h8m-3-3 3 3-3 3' }))
    }
    /**
     * 登录状态缓存。
     *
     * 面板每次进入都会重新挂载，如果每次都拉一次 `auth.status`（约 1.7 秒，
     * 带网络校验），用户会看到「读取中 → 未连接 → 已连接」的闪烁。
     * 这里按 rpcCall 身份 + TTL 缓存，切回来时直接命中。
     */
    let authCache = { value: null, at: 0, rpc: null }
    const AUTH_TTL_MS = 60_000

    function FeishuPanel({ rpcCall }) {
      const [form, setForm] = React.useState({ appId: '', appSecret: '', tools: 'preset.light' })
      const [baseline, setBaseline] = React.useState(null)
      const [customTools, setCustomTools] = React.useState(false)
      const [meta, setMeta] = React.useState({ hasAppSecret: false, installed: false, configPath: '' })
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const gate = React.useRef(false)
      const [notice, setNotice] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [revision, setRevision] = React.useState(0)
      const [testedRevision, setTestedRevision] = React.useState(-1)
      // 连接（登录）状态：与凭据表单解耦，读不到也不该挡住应用配置。
      const [auth, setAuth] = React.useState(() => {
        const cached = authCache.value !== null && Date.now() - authCache.at < AUTH_TTL_MS
        return cached
          ? { loading: false, error: '', status: authCache.value }
          : { loading: true, error: '', status: null }
      })
      const [authBusy, setAuthBusy] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const [authNotice, setAuthNotice] = React.useState('')
      const alive = React.useRef(true)
      const load = React.useCallback(async () => {
        setLoading(true); setLoadError('')
        try {
          if (typeof rpcCall !== 'function') throw new Error('配置服务暂不可用')
          const value = await rpcCall('config.get', {})
          if (value?.ok === false) throw new Error(value.error || '读取失败')
          if (!value || typeof value.appId !== 'string') throw new Error('配置响应无效')
          if (!alive.current) return
          const next = { appId: value.appId, appSecret: '', tools: Array.isArray(value.tools) ? value.tools.join(',') : 'preset.light' }
          setForm(next); setBaseline(next); setMeta(value)
        } catch { if (alive.current) setLoadError('未能读取配置。请重试；现有配置未被修改。') }
        finally { if (alive.current) setLoading(false) }
      }, [rpcCall])
      React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])

      /**
       * 读登录状态。默认命中缓存，`force=true` 时忽略缓存（刷新按钮、授权完成后）。
       */
      const loadAuth = React.useCallback(async (force = false) => {
        const fresh = authCache.rpc === rpcCall
          && authCache.value !== null
          && Date.now() - authCache.at < AUTH_TTL_MS
        if (!force && fresh) {
          setAuth({ loading: false, error: '', status: authCache.value })
          return
        }
        setAuth(previous => ({ ...previous, loading: !fresh, error: '' }))
        try {
          if (typeof rpcCall !== 'function') throw new Error('连接服务暂不可用')
          const raw = await rpcCall('auth.status', {})
          if (raw?.ok === false) throw new Error(raw.error || '读取登录状态失败')
          // 兼容两种封装：直接给状态对象，或再包一层 { value }。
          const value = raw?.result?.value ?? raw?.value ?? raw
          if (!value || typeof value !== 'object') throw new Error('登录状态响应无效')
          authCache = { value, at: Date.now(), rpc: rpcCall }
          if (!alive.current) return
          setAuth({ loading: false, error: '', status: value })
        } catch (error) {
          if (!alive.current) return
          authCache = { value: null, at: 0, rpc: null }
          setAuth({ loading: false, error: error?.message || '未能读取登录状态', status: null })
        }
      }, [rpcCall])
      React.useEffect(() => { void loadAuth() }, [loadAuth])

      const startAuth = async () => {
        if (authBusy) return
        setAuthBusy('begin'); setAuthNotice(''); setPending(null)
        try {
          const value = await rpcCall('auth.begin', {})
          if (!alive.current) return
          if (value?.ok === false) throw new Error(value.error || '发起授权失败')
          if (!value?.verificationUrl) throw new Error('没有拿到授权链接')
          setPending(value)
        } catch (error) {
          if (alive.current) setAuthNotice(error?.message || '发起授权失败')
        } finally {
          if (alive.current) setAuthBusy('')
        }
      }

      const completeAuth = async () => {
        if (authBusy || !pending?.deviceCode) return
        setAuthBusy('complete'); setAuthNotice('')
        try {
          const value = await rpcCall('auth.complete', { deviceCode: pending.deviceCode })
          if (!alive.current) return
          if (value?.ok === false) throw new Error(value.error || '完成授权失败')
          setPending(null)
          setAuthNotice(`授权完成${value?.userName ? `：${value.userName}` : ''}`)
          await loadAuth(true)
        } catch (error) {
          if (alive.current) setAuthNotice(error?.message || '完成授权失败')
        } finally {
          if (alive.current) setAuthBusy('')
        }
      }
      const dirty = baseline !== null && Object.keys(form).some(key => form[key] !== baseline[key])
      const change = (key, value) => {
        setForm(previous => ({ ...previous, [key]: value })); setRevision(n => n + 1)
        setNotice(''); setActionError('')
      }
      const perform = async (kind) => {
        if (gate.current || loading || loadError) return
        const tools = form.tools.split(',').map(item => item.trim()).filter(Boolean)
        if (!/^cli_[A-Za-z0-9]+$/.test(form.appId.trim())) { setActionError('请填写 cli_ 开头的有效 App ID。'); return }
        if (!form.appSecret.trim() && !meta.hasAppSecret) { setActionError('请在本地表单填写 App Secret。'); return }
        if (!tools.length) { setActionError('请至少选择一个工具集。'); return }
        gate.current = true; setBusy(kind); setActionError(''); setNotice('')
        if (kind === 'test') setResult(null)
        try {
          const value = await rpcCall(kind === 'save' ? 'config.set' : 'handshake.test', {
            appId: form.appId.trim(), tools,
            ...(form.appSecret.trim() ? { appSecret: form.appSecret.trim() } : { keepAppSecret: meta.hasAppSecret }),
          })
          if (!alive.current) return
          if (kind === 'test') { setResult(value ?? { ok: false, error: '测试服务没有返回结果' }); setTestedRevision(revision) }
          else {
            if (value?.ok !== true) throw new Error(value?.error || '保存失败')
            const next = { appId: value.appId, appSecret: '', tools: value.tools.join(',') }
            setForm(next); setBaseline(next); setMeta(previous => ({ ...previous, ...value }))
            setNotice('已保存。重启 DSH 后，新配置才会用于会话中的飞书工具。')
          }
        } catch { if (alive.current) setActionError(kind === 'save' ? '保存失败，请检查配置后重试。' : '测试请求失败，请重试。') }
        finally { gate.current = false; if (alive.current) setBusy('') }
      }
      const stale = result && testedRevision !== revision
      const disabled = loading || !!loadError || !!busy
      const input = (key, extra = {}) => h('input', { id: `feishu-${key}`, 'aria-describedby': `feishu-${key}-hint`, style: styles.input, value: form[key], disabled, spellCheck: false, autoComplete: 'off', onChange: e => change(key, e.target.value), ...extra })
      const status = loading ? '读取中' : loadError ? '配置读取失败' : dirty ? '有未保存更改' : meta.hasAppSecret && form.appId ? '配置已保存' : '待配置'
      const connected = auth.status?.userStatus === 'ready'
      const authLabel = auth.loading ? '读取中' : auth.error ? '状态未知' : connected ? '已连接' : '未连接'
      const authDetail = connected
        ? [
          auth.status?.userName ? `账号：${auth.status.userName}` : '',
          auth.status?.expiresAt ? `令牌到期：${formatTime(auth.status.expiresAt)}` : '',
          auth.status?.scopeCount ? `已授权 ${auth.status.scopeCount} 项权限` : '',
        ].filter(Boolean).join(' · ')
        : '尚未用你的飞书账号登录。授权后，DSH 才能读写你个人空间里的文档和表格。'
      const authCard = h('section', { style: styles.card, 'aria-label': '连接飞书' },
        h('div', { style: styles.between },
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 } },
            h('div', {
              style: {
                width: 40, height: 40, borderRadius: 12, flex: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, fontWeight: 650,
                color: connected ? '#fff' : mix(55),
                background: connected ? `linear-gradient(135deg, ${ACCENT}, #6b95ff)` : mix(8),
                boxShadow: connected ? '0 2px 8px rgba(51, 112, 255, .28)' : 'none',
              },
              'aria-hidden': true,
            }, connected ? String(auth.status?.userName || '飞').slice(0, 1) : '?'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('strong', { style: { fontSize: 15, fontWeight: 600 } },
                  connected ? (auth.status?.userName || '已连接') : auth.error ? '状态未知' : '未连接'),
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: mix(60) } },
                  h('span', { style: styles.dot(connected ? SUCCESS : auth.error ? DANGER : mix(35)) }),
                  connected ? '飞书账号已授权' : auth.error ? '读取失败' : '尚未授权')),
              h('span', { style: { fontSize: 12.5, color: mix(58) } }, connected
                ? [auth.status?.tokenType ? `${auth.status.tokenType} 令牌` : '', auth.status?.botStatus === 'ready' ? '机器人身份就绪' : ''].filter(Boolean).join(' · ') || '令牌有效'
                : '授权后即可读写你个人空间里的文档与表格'))),
          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: { ...styles.primary, opacity: authBusy ? .6 : 1 },
              disabled: !!authBusy,
              onClick: () => void startAuth(),
            }, authBusy === 'begin' ? '正在生成…' : connected ? '重新授权' : '授权登录'),
            pending ? h('button', {
              type: 'button',
              style: { ...styles.button, opacity: authBusy ? .6 : 1 },
              disabled: !!authBusy,
              onClick: () => void completeAuth(),
            }, authBusy === 'complete' ? '正在完成…' : '我已完成授权') : null,
            auth.error ? h('button', { type: 'button', style: styles.button, disabled: !!authBusy, onClick: () => void loadAuth(true) }, '重试') : null,
            connected ? h('button', { type: 'button', style: { ...styles.button, color: mix(65) }, disabled: !!authBusy, onClick: () => void loadAuth(true) }, '刷新状态') : null)),
        connected ? h(React.Fragment, null,
          h('hr', { style: styles.divider }),
          h('div', { style: styles.metaGrid },
            h('div', null,
              h('div', { style: styles.metaLabel }, '应用'),
              h('div', { style: styles.metaValue }, auth.status?.appId || '—')),
            h('div', null,
              h('div', { style: styles.metaLabel }, '令牌到期'),
              h('div', { style: styles.metaValue }, auth.status?.expiresAt ? formatTime(auth.status.expiresAt) : '—')),
            h('div', null,
              h('div', { style: styles.metaLabel }, '已授权权限'),
              h('div', { style: styles.metaValue }, auth.status?.scopeCount ? `${auth.status.scopeCount} 项` : '—')))) : null,
        pending ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 12, background: mix(4), border } },
          h('p', { style: styles.hint }, '在浏览器打开下面的链接并确认授权，然后点「我已完成授权」'),
          h('a', { href: pending.verificationUrl, target: '_blank', rel: 'noreferrer', style: { ...styles.mono, color: ACCENT } }, pending.verificationUrl),
          h('p', { style: styles.mono }, `用户码 ${pending.userCode || '（见页面）'} · 约 ${Math.round((pending.expiresIn || 600) / 60)} 分钟内有效`)) : null,
        !connected && !auth.error ? h('p', { style: styles.hint }, authDetail) : null,
        authNotice ? h('p', { role: 'status', style: { ...styles.hint, color: SUCCESS } }, authNotice) : null,
        auth.error ? h('p', { role: 'alert', style: styles.error }, auth.error) : null)
      return h('div', { style: styles.page }, h('div', { style: styles.content },
        h('header', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } },
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('h1', { style: { fontSize: 20, margin: 0, fontWeight: 650, letterSpacing: '-.01em' } }, '飞书 MCP'),
              h('span', { style: styles.badge }, status)),
            h('p', { style: { ...styles.hint, marginTop: 6 } }, '连接飞书自建应用，让 DSH 使用你授权的飞书工具。'))),
        authCard,
        loadError ? h('div', { style: styles.card }, h('p', { role: 'alert', style: styles.error }, loadError),
          h('div', null, h('button', { style: styles.button, onClick: () => void load() }, '重新读取'))) : null,
        loading ? h('p', { role: 'status', style: styles.hint }, '正在读取本地配置…') : null,
        !loading && !loadError ? h('details', { style: { ...styles.card, padding: 0, gap: 0, overflow: 'hidden' } },
          h('summary', { style: { ...styles.summary, padding: '15px 20px', fontWeight: 500 } }, '高级 · 使用自己的应用（默认无需填写）'),
          h('div', { style: { padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 16, borderTop: border }, 'aria-label': '应用配置', 'aria-busy': !!busy },
            h('h2', { style: { fontSize: 13, margin: '18px 0 0', color: mix(60), fontWeight: 600 } }, '应用凭据'),
            h(Field, { id: 'feishu-appId', label: 'App ID', hint: '飞书开放平台 → 开发者后台 → 凭证与基础信息。' }, input('appId', { placeholder: 'cli_xxxxxxxxxxxx' })),
            h(Field, { id: 'feishu-appSecret', label: 'App Secret', hint: meta.hasAppSecret ? '已保存密钥。留空保持原值，填写新值会替换原密钥。' : '密钥保存于本机配置文件中，读取时不回显。' }, input('appSecret', { type: 'password', placeholder: meta.hasAppSecret ? '已配置 · 留空保持' : '填写应用密钥' })),
            h('details', null,
              h('summary', { style: styles.summary }, '高级设置 · 工具集'),
              h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 } },
                h(Field, { id: 'feishu-preset', label: '选择预设' },
                  h('select', { id: 'feishu-preset', style: styles.input, disabled, value: !customTools && form.tools === 'preset.light' ? 'preset.light' : 'custom', onChange: e => { setCustomTools(e.target.value === 'custom'); if (e.target.value !== 'custom') change('tools', e.target.value) } },
                    h('option', { value: 'preset.light' }, '常用工具（推荐）'), h('option', { value: 'custom' }, '自定义工具集（在下方编辑）'))),
                h(Field, { id: 'feishu-tools', label: '工具集标识', hint: '多个工具集用英文逗号分隔，例如 preset.light,preset.calendar.default。实际可用工具取决于安装版本。' }, input('tools')))),
            !meta.installed ? h('p', { role: 'status', style: styles.error }, '未检测到 lark-mcp，请安装后再测试。') : null,
            h('hr', { style: styles.divider }),
            h('div', { style: styles.row },
              h('button', { type: 'button', style: { ...styles.primary, opacity: disabled || !dirty ? .5 : 1 }, disabled: disabled || !dirty, onClick: () => void perform('save') }, busy === 'save' ? '保存中…' : '保存配置'),
              h('button', { type: 'button', style: { ...styles.button, opacity: disabled || !meta.installed ? .5 : 1 }, disabled: disabled || !meta.installed, onClick: () => void perform('test') }, busy === 'test' ? '正在测试…' : '测试 MCP 握手')),
            h('p', { style: styles.hint }, '测试使用当前填写内容，不会保存配置。保存后需重启 DSH 生效。'),
            notice ? h('p', { role: 'status', style: { ...styles.hint, color: SUCCESS } }, notice) : null,
            actionError ? h('p', { role: 'alert', style: styles.error }, actionError) : null)) : null,
        h('section', { style: { ...styles.card, gap: 12 }, 'aria-label': '最近测试结果', 'aria-live': 'polite' },
          h('div', { style: styles.between },
            h('h2', { style: { fontSize: 13, margin: 0, color: mix(60), fontWeight: 600 } }, '最近测试'),
            result && stale ? h('span', { style: styles.badge }, '配置已修改') : null),
          busy === 'test' ? h('p', { style: styles.hint }, '正在启动服务并读取工具列表，最长约一分钟…') :
            !result ? h('p', { style: styles.hint }, '尚未测试。握手用于检查 MCP 服务启动与工具发现，不代表飞书业务权限已验证。') :
              h(React.Fragment, null,
                h('strong', { style: { fontSize: 13.5, fontWeight: 600 } }, stale ? '结果已过期 · 配置已修改，请重新测试' : result.ok ? `握手成功 · 发现 ${result.toolCount} 个工具` : '握手失败'),
                result.ok ? h('p', { style: styles.hint }, '服务可启动并返回工具列表。凭据和具体权限仍需通过实际飞书操作确认；这里不表示会话已连接。') :
                  h('p', { style: styles.error }, result.error || '未知错误'),
                result.serverInfo?.name ? h('p', { style: styles.hint }, `${result.serverInfo.name} ${result.serverInfo.version || ''}`) : null,
                result.ok && Array.isArray(result.tools) ? h('details', null, h('summary', { style: styles.summary }, '查看工具列表'),
                  h('ul', { style: { ...styles.mono, maxHeight: 240, overflowY: 'auto', paddingLeft: 20, margin: '8px 0 0' } }, result.tools.map((name, i) => h('li', { key: `${name}-${i}` }, name)))) : null,
                result.detail ? h('details', null, h('summary', { style: styles.summary }, '错误详情'), h('pre', { style: styles.mono }, result.detail)) : null)),
        h('details', null, h('summary', { style: { ...styles.summary, padding: '4px 2px' } }, '诊断信息'),
          h('p', { style: { ...styles.mono, marginTop: 8 } }, meta.configPath || '配置路径未读取'),
          h('p', { style: { ...styles.hint, marginTop: 6 } }, '测试流程：启动临时 MCP 进程，完成初始化，再读取工具列表。正式工具连接由 DSH 的 MCP 客户端管理。'))))
    }
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call('/api', 'feishu-mcp', { method: endpoint, payload }, signal).then(result => {
          if (result?.ok === true) return result.value
          if (result?.ok === false) throw new Error(result.error?.message || '飞书 MCP 请求失败')
          return result
        })
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'feishu-mcp', order: 62, label: () => '飞书 MCP' }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'feishu-mcp', inject: () => ({ rpcCall }) }, FeishuPanel))
      },
    }
  },
})
