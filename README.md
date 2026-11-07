# dsh-feishu-mcp

飞书 / Lark 连接器插件，为 [DeepSeek Harness](https://github.com/)（DSH）提供**以你本人身份**操作飞书的能力：文档、电子表格、多维表格、消息、日历、任务、审批、云盘、知识库。

> A Feishu / Lark connector plugin for DeepSeek Harness. It authenticates as **the user** (OAuth device flow) instead of a bot, wraps the official `@larksuite/cli` behind a risk-graded gateway, and injects the CLI's bundled skills so the agent knows how to use them.

---

## 为什么需要它

飞书有两条接入路径，能力完全不同：

| 路径 | 身份 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| MCP 服务（`@larksuiteoapi/lark-mcp`） | 应用机器人（`tenant_access_token`） | 调应用可见的开放接口 | 读不到你个人空间里的文档与表格；也没有读取单元格值的工具 |
| CLI（`@larksuite/cli`） | 用户本人（OAuth 设备码） | 你本人能看到、能操作的都能做 | 需要一次浏览器授权 |

这个插件把第二条路径封装成 DSH 原生的三件东西：

1. **一个「连接」面板** —— 点两下完成登录，不需要手填 App ID / App Secret；
2. **一个受控执行网关 `feishu_cli`** —— 覆盖 23 个业务域，按可逆性分三档拦截；
3. **一套 skill provider** —— 把 `lark-cli` 内置的 28 个 skill 动态注入 DSH 的能力目录。

---

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 连接面板 | 设备码授权，浏览器确认后自动收尾；显示账号、令牌到期、已授权权限数 |
| `feishu_cli` 网关 | 执行任意 `lark-cli` 命令，自动补 `--json`，返回结构化结果 |
| 风险分级 | 只读直通 / 可回退写入先快照 / 不可逆操作默认拦截 |
| 审计日志 | 所有写操作记入 `~/.dsh/feishu-mcp/audit.jsonl`（含被拦截的尝试） |
| skill 注入 | 默认 9 个核心 skill，可切 `all`（28 个）或 `off` |
| 附件清单 | 加载 skill 时自动列出它的 `references/*.md`，并给出可直接执行的读取命令 |
| 表格工具 | `feishu_sheets_info` / `feishu_sheets_read` / `feishu_sheets_cells`（兼容旧用法） |

---

## 安装

前置条件：

- Node.js ≥ 18（DSH 自带的运行时即可）
- 一个飞书自建应用（App ID 形如 `cli_xxxxxxxx`），并已开通所需权限

### 1. 安装 lark-cli

```bash
mkdir -p ~/.dsh/lark-cli && cd ~/.dsh/lark-cli
npm init -y
npm install @larksuite/cli
```

### 2. 配置应用

```bash
node ~/.dsh/lark-cli/node_modules/@larksuite/cli/scripts/run.js \
  config init --app-id cli_xxxxxxxx --app-secret-stdin < secret.txt
```

### 3. 安装插件

把本仓库放进 DSH profile 的 `node_modules`（或 `link:` 到源码目录），并确认 profile 的 `cordis.patch.yml` 包含：

```yaml
- insert:
    - id: feishu-mcp
      name: 'dsh-feishu-mcp'
```

### 4. 重启 DSH

左侧导航会出现「飞书 MCP」，点进去 →「授权登录」→ 浏览器确认 →「我已完成授权」。

---

## 使用

### 登录与状态

面板顶部显示当前身份：

- **张明 · 飞书账号已授权** —— 正常，可读写你个人空间的资源
- **未连接 · 尚未授权** —— 还没登录，点「授权登录」
- **状态未知 · 读取失败** —— 调用出错，红字会写明原因，点「重试」

状态结果有 60 秒缓存，切回面板不会重新拉取。「刷新状态」会强制刷新。

### 调用命令

```js
feishu_cli({
  args: ["sheets", "+csv-get", "--spreadsheet-token", "xxx", "--sheet-id", "yyy", "--range", "A1:T30"],
})
```

不熟悉命令时，先查：

```js
feishu_cli({ args: ["sheets", "--help"] })
feishu_cli({ args: ["skills", "list"] })
```

### 风险分级

网关按 `lark-cli --help` 尾部的 `Risk:` 标注 + 关键字判断，取更严格的一档：

| 等级 | 例子 | 行为 |
| --- | --- | --- |
| `read` | `+csv-get`、`+workbook-info` | 直接执行 |
| `write` | `+csv-put`、`+range-copy` | 执行前快照旧值，执行后记录 revision |
| `destructive` | `+cells-clear`、`+delete`、`+member-add` | 默认拒绝，需传 `confirm: true` |

不可逆操作被拦下时会先跑一次 `--dry-run`，把真实请求体展示出来。

---

## 配置文件与路径

| 路径 | 用途 |
| --- | --- |
| `~/.dsh/lark-cli/` | lark-cli 本体 |
| `~/.lark-cli/config.json` | lark-cli 的应用配置与登录态（密钥存 Windows 凭据管理器） |
| `~/.dsh/feishu-mcp/settings.json` | 插件设置，目前只有 `{"skillsMode": "core" \| "all" \| "off"}` |
| `~/.dsh/feishu-mcp/audit.jsonl` | 写操作审计 |

`skillsMode` 在插件加载时读取，修改后需要重启 DSH。

---

## 目录结构

```
index.js              Host 半边：RPC 端点、工具注册、skill provider 装配
client.js             面板（__ModuleLoader__ 格式，React.createElement）
lib/risk.js           命令风险分级（纯函数，全部可单测）
lib/audit.js          JSONL 审计日志
lib/skills.js         lark-cli skill provider + 附件枚举
cordis.patch.yml      bundle 补丁
tests/                61 个测试
```

---

## 测试

```bash
node --test tests/client.test.mjs tests/auth.test.mjs tests/skills.test.mjs \
  tests/skills-resources.test.mjs tests/gateway.test.mjs \
  tests/lark-cli-bridge.test.mjs tests/handshake.test.mjs
```

端到端冒烟（需要本机已安装并登录 lark-cli）：

```bash
node tests/e2e-skills.mjs
```

---

## 常见问题

**面板显示「状态未知 · 读取失败」**
宿主进程还是旧版本，没有 `auth.status` 端点。重启 DSH。

**表格读不到，报 `99991672`**
应用没开通对应权限，或该文档没有授权给这个应用。注意：应用 scope ≠ 文档权限，即使 scope 齐全，文档本身也要把你或应用加为协作者。

**读到的数据是空的，但没报错**
很可能在用 `bot` 身份调用户资源。机器人查用户资源会**返回空成功而不是报错**，这点很容易误判。

**`skills` 目录里看不到 lark-* 条目**
`skillsMode` 是 `off`，或 DSH 的 skills 服务不可用。检查 `~/.dsh/feishu-mcp/settings.json`。

---

## 安全说明

- App Secret 只在本机，lark-cli 通过 Windows 凭据管理器与 DPoP 绑定保存令牌；面板永不回显。
- 授权页请求的是**最小只读 scope 集**。飞书的 device flow 下令牌实际按应用已开通范围发放，请求范围只影响授权页展示 —— 所以真正的能力边界由网关的风险分级把守，而不是靠 scope。
- 所有写操作（含被拦截的尝试）都会记审计。

---

## License

MIT
