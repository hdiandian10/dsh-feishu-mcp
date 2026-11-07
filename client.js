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
      // ⛔ 2026-11-07 凭据表单移除后，以下 state 只服务于已删除的 UI：
      //    form / baseline / customTools / busy / gate / notice / actionError / result /
      //    revision / testedRevision。全部删除。完整原代码见 client.js.bak-20261107-142846。
      const [meta, setMeta] = React.useState({ configPath: '' })
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState('')
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
          if (!value || typeof value !== 'object') throw new Error('配置响应无效')
          if (!alive.current) return
          // 只保留诊断信息（配置路径）。凭据表单已删除，不再需要 form/baseline。
          setMeta({ configPath: typeof value.configPath === 'string' ? value.configPath : '' })
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
      // ⛔ 2026-11-07 移除整段凭据表单的交互逻辑（dirty / change / perform / stale /
      //    disabled / input）。凭据表单与 MCP 握手按钮已删，这些函数不再有任何渲染路径调用。
      //    完整原代码见 client.js.bak-20261107-142846。
      const connected = auth.status?.userStatus === 'ready'
      // 三分支必须保留 auth.error：授权状态读取失败时要显示「状态未知」，
      // 不能退化成「未连接」，否则会误导用户以为需要重新授权。
      const status = loading ? '读取中' : loadError ? '状态读取失败' : auth.error ? '状态未知' : connected ? '已连接' : '未连接'
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
              h('h1', { style: { fontSize: 20, margin: 0, fontWeight: 650, letterSpacing: '-.01em' } }, '飞书'),
              h('span', { style: styles.badge }, status)),
            h('p', { style: { ...styles.hint, marginTop: 6 } }, '用你的飞书账号授权 lark-cli；DSH 的飞书能力（读群、建表、读写单元格、查文档）全部由它提供。'))),
        authCard,
        loadError ? h('div', { style: styles.card }, h('p', { role: 'alert', style: styles.error }, loadError),
          h('div', null, h('button', { style: styles.button, onClick: () => void load() }, '重新读取'))) : null,
        loading ? h('p', { role: 'status', style: styles.hint }, '正在读取本地配置…') : null,
        // ⛔ 2026-11-07 移除「高级 · 使用自己的应用」凭据表单（App ID / App Secret / 工具集 /
        //    保存配置 / 测试 MCP 握手）。原因：lark-mcp 连接行已停用（见
        //    ~/.dsh/profiles/desktop/cordis.patch.yml），这块表单填了也不再有任何消费方，
        //    留着只会误导人以为 mcp__feishu__* 还在。完整原代码见 client.js.bak-20261107-142846。
        // ▶ 要恢复：从备份文件拷回本段即可。
        // 「最近测试」卡片随握手按钮一并移除——没有测试入口，这张卡片只会在页面上留一句「尚未测试」。
        h('details', null, h('summary', { style: { ...styles.summary, padding: '4px 2px' } }, '诊断信息'),
          h('p', { style: { ...styles.mono, marginTop: 8 } }, meta.configPath || '配置路径未读取'),
          h('p', { style: { ...styles.hint, marginTop: 6 } }, '飞书能力当前由 lark-cli（feishu_cli 工具）提供，DSH 侧不再挂载 lark-mcp 的 MCP 连接。'))))
    }
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call('/api', 'feishu-mcp', { method: endpoint, payload }, signal).then(result => {
          if (result?.ok === true) return result.value
          if (result?.ok === false) throw new Error(result.error?.message || '飞书请求失败')
          return result
        })
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'feishu-mcp', order: 62, label: () => '飞书' }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'feishu-mcp', inject: () => ({ rpcCall }) }, FeishuPanel))
      },
    }
  },
})
