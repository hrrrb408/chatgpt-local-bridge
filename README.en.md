# chatgpt-local-bridge

**[中文](README.md) | English**

> Let ChatGPT (and any MCP client) **securely** read & write your local files and run commands — through the Model Context Protocol.

ChatGPT's web/desktop app can't touch your filesystem. `chatgpt-local-bridge` is a local MCP server that exposes your files (and optionally shell commands) to ChatGPT, Claude Desktop, Cursor, and any other MCP-compatible client — with **path whitelisting, permission levels, and destructive-action confirmation** as first-class citizens.

## Why

Copying code between ChatGPT and your editor is slow. Existing bridges are either read-only, have no permission model, or are half-finished. This project's whole pitch is **safety you can actually reason about**:

- 📁 **Path whitelist** — only directories you allow are reachable. Traversal (`../`), symlinks, double-encoding, and null bytes are all rejected.
- 🔐 **Three permission levels** — read-only / edit / full (commands). Default is *edit*.
- ✅ **Layered confirmation** — deletes, overwrites, and commands require approval via the host's native approval UI, MCP elicitation, or an explicit two-step `confirm_action` token.
- 🛡️ **Command injection defense** — `run_command` uses `spawn(shell:false)`, rejects shell operators/substitution/globs and a configurable blocklist.
- 🔌 **Zero-config start** — `npx chatgpt-local-bridge` and you're running.

## Quick start

```bash
# Run instantly (no install)
npx chatgpt-local-bridge

# …or install globally
npm install -g chatgpt-local-bridge
chatgpt-local-bridge
```

On first run it generates `~/.chatgpt-local-bridge/config.yaml` (defaults: `~/Desktop`, `~/Documents` writable, Level 1). Edit `allowed_paths` and restart.

## Connecting ChatGPT (important)

ChatGPT's servers must be able to reach your MCP URL, so **`localhost` is not directly reachable from ChatGPT** — you expose it through a tunnel:

```bash
# 1. Start the bridge (listens on 127.0.0.1:3456)
npx chatgpt-local-bridge

# 2. In another terminal, expose it over public HTTPS
cloudflared tunnel --url http://localhost:3456
#   → https://<random>.trycloudflare.com
# (or: ngrok http 3456)
```

Then in ChatGPT:

1. **Settings → Connectors (Apps) → Advanced → enable Developer Mode**
2. **Create** a new connector (Server URL)
3. Paste `https://<your-url>/mcp`
4. Auth: **未授权 / No authentication** → Connect.

> **Claude Desktop / Cursor** support direct `localhost` — no tunnel needed. Point them at `http://127.0.0.1:3456/mcp`.

> Close the tunnel when you're done. The bridge binds `127.0.0.1` only; the tunnel is the single public path and is yours to open/close.

## Configuration

`~/.chatgpt-local-bridge/config.yaml`:

```yaml
server:
  port: 3456
  host: "127.0.0.1"        # local only
  # allowed_hosts:          # optional DNS-rebinding protection (Host-header allow-list)
  # log_requests: true      # log every MCP request (debug client interop; off by default)

permissions:
  level: 1                  # 0 = read-only, 1 = edit, 2 = full (+ run_command)
  allowed_paths: [~/Desktop, ~/Documents, ~/Code]
  denied_paths: [~/.ssh, ~/.gnupg]   # block subtrees inside allowed_paths

limits:
  max_read_size: 524288     # 500 KB / read
  max_write_size: 1048576   # 1 MB / write
  max_search_results: 50
  command_timeout: 30       # seconds

safety:
  confirm_delete: true
  confirm_overwrite: true
  confirm_command: true
  blocked_commands: [sudo, mkfs, dd, shutdown, reboot, halt]
```

Invalid config fails loudly with field-level errors (strict schema catches typos like `alowed_paths`).

## Tools

| Tool | Level | Description |
|------|-------|-------------|
| `read_file` | 0 | Stream-read a file (line ranges, byte cap) |
| `list_directory` | 0 | List entries (optional bounded recursion) |
| `search_files` | 0 | Find files by glob |
| `search_content` | 0 | Grep contents by regex (ReDoS/size-bounded) |
| `get_file_info` | 0 | Size / mtime / type |
| `get_project_info` | 0 | Detect project type + top-level structure |
| `write_file` | 1 | Create / overwrite (overwrite is confirmed) |
| `edit_file` | 1 | Unique find-and-replace |
| `move_file` | 1 | Move/rename (refuses to overwrite) |
| `delete_file` | 1 | Delete (confirmed) |
| `run_command` | 2 | Single command, `shell:false`, blocklisted, confirmed |
| `confirm_action` | 0 | Confirm/cancel a pending destructive action |

### How confirmation works

Destructive operations (`delete_file`, overwriting `write_file`, `run_command`) are gated by three layers — whichever applies takes effect:

1. **Tool annotations** (`destructiveHint`) — ChatGPT and Claude Desktop show their own approval prompt automatically.
2. **MCP elicitation** — if the client supports it, the bridge asks a yes/no inline and runs immediately (Claude Desktop etc.).
3. **Two-step token** — otherwise the tool returns a single-use token; the model calls `confirm_action(token, "confirm")` to proceed. Works on every client, including ChatGPT.

## Security model

- The bridge binds **`127.0.0.1` only**. The tunnel is the only public surface.
- Every path is validated: URL-decoded, null-byte-rejected, `~`-expanded, resolved, checked against the whitelist by string containment (`dir + sep`), then re-checked after `realpath` so symlinks can't escape. Writes re-resolve the parent dir's realpath right before the IO (TOCTOU mitigation).
- `run_command` never spawns a shell. Anything requiring shell features (pipes, `&&`, redirects, `$()`, globs) is rejected.
- Permission levels are enforced before any IO; they cannot be raised at runtime.

See [`docs/`](docs/) for the full design (requirements, architecture, detailed design, implementation plan).

## Development

```bash
npm install
npm test            # unit tests
npm run typecheck
npm run build
node scripts/e2e-smoke.mjs   # see scripts/ header for how to drive it
```

## License

MIT
