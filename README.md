# chatgpt-local-bridge

**中文 | [English](README.en.md)**

> 让 ChatGPT（以及任何 MCP 客户端）**安全地**读写本地文件、执行命令——基于 Model Context Protocol。

ChatGPT 网页版/桌面版无法访问你的文件系统。`chatgpt-local-bridge` 是一个本地 MCP 服务，把你的文件（以及可选的 shell 命令）暴露给 ChatGPT、Claude Desktop、Cursor 等 MCP 客户端——并把**路径白名单、权限分级、危险操作确认**作为一等公民来设计。

## 为什么做

在 ChatGPT 和编辑器之间来回粘贴代码太慢。现有方案要么只读、要么没有权限模型、要么是半成品。这个项目的全部卖点就是**可推理的安全性**：

- 📁 **路径白名单** —— 只有你授权的目录可访问。穿越攻击（`../`）、符号链接、双重编码、null 字节全部拦截。
- 🔐 **三级权限** —— 只读 / 编辑 / 完整（含命令）。默认 *编辑*。
- ✅ **分层确认** —— 删除、覆盖、执行命令需经宿主原生审批、MCP elicitation、或两步 `confirm_action` token 确认。
- 🛡️ **命令注入防御** —— `run_command` 用 `spawn(shell:false)`，拒绝 shell 运算符/替换/glob 及可配置黑名单。
- 🔌 **零配置启动** —— `npx chatgpt-local-bridge` 即可跑起来。

## 快速开始

```bash
# 直接运行（无需安装）
npx chatgpt-local-bridge

# 或全局安装
npm install -g chatgpt-local-bridge
chatgpt-local-bridge
```

首次运行会生成 `~/.chatgpt-local-bridge/config.yaml`（默认：`~/Desktop`、`~/Documents` 可写，Level 1）。编辑 `allowed_paths` 后重启。

## 连接 ChatGPT（重要）

ChatGPT 的服务器需要能访问到你的 MCP 地址，所以 **`localhost` 不能被 ChatGPT 直接访问**——必须通过隧道暴露成公网 HTTPS：

```bash
# 1. 启动 bridge（监听 127.0.0.1:3456）
npx chatgpt-local-bridge

# 2. 另开一个终端，把它暴露成公网 HTTPS
cloudflared tunnel --url http://localhost:3456
#   → https://<随机>.trycloudflare.com
# （或：ngrok http 3456）
```

然后在 ChatGPT 里：

1. **Settings → Connectors（Apps）→ Advanced → 开启 Developer Mode**
2. **Create** 新建连接器（选「服务器 URL」）
3. 粘贴 `https://<你的地址>/mcp`
4. 身份验证选 **未授权 / No authentication** → 连接。

> **Claude Desktop / Cursor** 支持直连 `localhost`——无需隧道。地址填 `http://127.0.0.1:3456/mcp`。

> 用完记得关隧道。bridge 只监听 `127.0.0.1`；隧道是唯一的公网入口，由你开关。

## 配置

`~/.chatgpt-local-bridge/config.yaml`：

```yaml
server:
  port: 3456
  host: "127.0.0.1"        # 只监听本地
  # allowed_hosts:          # 可选 DNS 重绑定防护（Host 头白名单）
  # log_requests: true      # 打印每个 MCP 请求（排查客户端兼容；默认关）

permissions:
  level: 1                  # 0 = 只读, 1 = 编辑, 2 = 完整（+ run_command）
  allowed_paths: [~/Desktop, ~/Documents, ~/Code]
  denied_paths: [~/.ssh, ~/.gnupg]   # 在 allowed_paths 内部再屏蔽的子路径

limits:
  max_read_size: 524288     # 单次读 500 KB
  max_write_size: 1048576   # 单次写 1 MB
  max_search_results: 50
  command_timeout: 30       # 秒

safety:
  confirm_delete: true
  confirm_overwrite: true
  confirm_command: true
  blocked_commands: [sudo, mkfs, dd, shutdown, reboot, halt]
```

配置非法会**立刻报错**并给出字段级提示（严格 schema 能抓到 `alowed_paths` 这类拼写错误）。

## 工具

| 工具 | 级别 | 说明 |
|------|------|------|
| `read_file` | 0 | 流式读文件（支持行范围、字节上限） |
| `list_directory` | 0 | 列目录（可选有界递归） |
| `search_files` | 0 | 按 glob 找文件 |
| `search_content` | 0 | 按正则搜内容（防 ReDoS、有大小上限） |
| `get_file_info` | 0 | 大小 / 修改时间 / 类型 |
| `get_project_info` | 0 | 识别项目类型 + 顶层结构 |
| `write_file` | 1 | 创建 / 覆盖（覆盖需确认） |
| `edit_file` | 1 | 唯一匹配的查找替换 |
| `move_file` | 1 | 移动/重命名（拒绝覆盖） |
| `delete_file` | 1 | 删除（需确认） |
| `run_command` | 2 | 单条命令、`shell:false`、黑名单、需确认 |
| `confirm_action` | 0 | 确认/取消一个待执行的破坏性操作 |

### 确认机制如何工作

破坏性操作（`delete_file`、覆盖式的 `write_file`、`run_command`）由三层把关，任一生效即满足"确认"：

1. **工具注解**（`destructiveHint`）—— ChatGPT、Claude Desktop 等宿主自动弹原生审批框。
2. **MCP elicitation** —— 客户端支持时，bridge 在工具调用中途弹 yes/no 并立即执行（Claude Desktop 等）。
3. **两步 token** —— 否则工具返回一次性 token，模型再调 `confirm_action(token, "confirm")` 才执行。任何客户端（含 ChatGPT）都可用。

## 安全模型

- bridge **只监听 `127.0.0.1`**。隧道是唯一的公网入口。
- 每个路径都经过校验：URL 解码、拒 null 字节、`~` 展开、规范化、按字符串包含（`dir + sep`）比对白名单，再在 `realpath` 之后二次比对，防止符号链接逃逸。写操作在实际 IO 前重新解析父目录 realpath（防 TOCTOU）。
- `run_command` 从不起 shell。任何需要 shell 特性的（管道、`&&`、重定向、`$()`、glob）一律拒绝。
- 权限分级在任何 IO 之前强制；运行时不可提权。

## 开发

```bash
npm install
npm test            # 单元测试
npm run typecheck
npm run build
node scripts/e2e-smoke.mjs   # 端到端，脚本头部有驱动说明
```

## License

MIT — 详见 [LICENSE](LICENSE)。
