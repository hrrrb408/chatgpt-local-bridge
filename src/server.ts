import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config/schema.js";
import { buildRoots, type PathContext } from "./security/path-validator.js";
import { PendingStore } from "./security/pending-store.js";
import { registerAllTools } from "./tools/index.js";

export interface StartResult {
  app: Express;
  pathCtx: PathContext;
  close: () => Promise<void>;
}

const SESSION_IDLE_MS = 60 * 60 * 1000; // reap sessions idle longer than 1h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function jsonError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  pending: PendingStore;
  lastActivity: number;
}

/**
 * Build the MCP server and wire Streamable HTTP transport onto an Express app at /mcp. Correctness
 * notes (from adversarial review):
 *  - One McpServer + one PendingStore PER SESSION (SDK throws on re-connect; tokens must be
 *    session-scoped). Sessions are reaped when idle to avoid leaks from clients that drop TCP
 *    without sending DELETE (transport.onclose only fires on an explicit close).
 *  - We build the Express app ourselves so we can raise the JSON body limit above the SDK's 100kb
 *    default and keep Host-header validation opt-in (for dynamic tunnel domains).
 */
export async function startServer(config: Config): Promise<StartResult> {
  const allowedRoots = await buildRoots(config.permissions.allowed_paths);
  const deniedRoots = await buildRoots(config.permissions.denied_paths);
  const pathCtx: PathContext = { allowedRoots, deniedRoots };

  const app = express();
  const bodyLimitKb = Math.max(256, Math.ceil((config.limits.max_write_size * 1.5) / 1024));
  app.use(express.json({ limit: `${bodyLimitKb}kb` }));

  // Request log — off unless server.log_requests is set (for debugging client interop).
  const log = config.server.log_requests
    ? (msg: string) => process.stdout.write(`[mcp ${new Date().toISOString()}] ${msg}\n`)
    : (_msg: string) => {
        /* no-op */
      };

  const allowedHosts = config.server.allowed_hosts;
  if (allowedHosts && allowedHosts.length > 0) {
    const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
    app.use((req: Request, res: Response, next: NextFunction) => {
      const h = (req.hostname || "").toLowerCase();
      if (h && !hostSet.has(h)) return jsonError(res, 403, -32000, `Forbidden Host: ${h}`);
      next();
    });
  }

  const sessions = new Map<string, Session>();

  function makeSession(): { server: McpServer; pending: PendingStore } {
    const pending = new PendingStore();
    const server = new McpServer(
      { name: "chatgpt-local-bridge", version: "0.1.0" },
      { capabilities: { tools: {}, logging: {} } },
    );
    registerAllTools(server, { config, pathCtx, server, pending });
    return { server, pending };
  }

  async function reapSession(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
      await s.transport.close();
    } catch {
      /* ignore */
    }
    try {
      await s.server.close();
    } catch {
      /* ignore */
    }
    s.pending.dispose();
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    const rpc = req.body?.method;
    log(`POST rpc=${rpc || "-"} accept=${req.headers.accept || "-"} ct=${req.headers["content-type"] || "-"}`);
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        if (!isInitializeRequest(req.body)) {
          // SDK convention: a request carrying an unknown/expired Mcp-Session-Id returns 404 so the
          // client re-initializes; a request with no session-id that isn't initialize returns 400.
          if (sessionId) {
            log(`POST 404 (unknown session) rpc=${rpc || "-"}`);
            return jsonError(res, 404, -32000, "Session not found or expired");
          }
          log(`POST 400 (no session / not initialize) rpc=${rpc || "-"}`);
          return jsonError(res, 400, -32600, "Bad Request: initialize or valid Mcp-Session-Id required");
        }
        const { server, pending } = makeSession();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, { transport, server, pending, lastActivity: Date.now() });
            transport.onclose = () => {
              void reapSession(id);
            };
          },
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        log(`POST init done status=${res.statusCode}`);
        return;
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      log(`POST done rpc=${rpc || "-"} status=${res.statusCode}`);
    } catch (e) {
      log(`POST ERROR rpc=${rpc || "-"}: ${(e as Error)?.message || e}`);
      if (!res.headersSent) jsonError(res, 500, -32603, "Internal error");
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      log(`GET ${sessionId ? 404 : 400} (no valid session)`);
      return jsonError(res, sessionId ? 404 : 400, -32000, "Session not found or expired");
    }
    log(`GET session=yes accept=${req.headers.accept || "-"}`);
    session.lastActivity = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (e) {
      log(`GET ERROR: ${(e as Error)?.message || e}`);
      if (!res.headersSent) jsonError(res, 500, -32603, "Internal error");
    }
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    log(`DELETE session=${sessionId ? "yes" : "no"}`);
    if (sessionId) await reapSession(sessionId);
    res.status(200).json({});
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActivity > SESSION_IDLE_MS) void reapSession(id);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const close = async (): Promise<void> => {
    clearInterval(sweeper);
    for (const id of [...sessions.keys()]) await reapSession(id);
  };

  return { app, pathCtx, close };
}
