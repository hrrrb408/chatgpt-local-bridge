import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import type { PathContext } from "../security/path-validator.js";
import type { PendingStore } from "../security/pending-store.js";

/** Shared dependencies passed to every tool handler. */
export interface ToolDeps {
  config: Config;
  pathCtx: PathContext;
  server: McpServer;
  pending: PendingStore;
}

/** Minimal MCP tool result shape (structurally compatible with SDK CallToolResult). */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Tool annotations — structurally compatible with the SDK's ToolAnnotations. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
  /** Minimum permission level required to invoke this tool (0=read, 1=edit, 2=full). Defaults to 0. */
  requiredLevel?: 0 | 1 | 2;
  /**
   * Handler. `extra` is the SDK RequestHandlerExtra (carries sendRequest for elicitation); typed
   * loosely so tools that don't use it can ignore it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, deps: ToolDeps, extra: any) => Promise<ToolResult>;
}

/** Register one tool spec onto the MCP server, wiring shared deps + a permission gate into its handler. */
export function registerTool(server: McpServer, spec: ToolSpec, deps: ToolDeps): void {
  const requiredLevel = spec.requiredLevel ?? 0;
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any, extra: any) => {
      // Permission gate — checked first (cheapest, fail-fast, no IO).
      if (deps.config.permissions.level < requiredLevel) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: this tool requires Level ${requiredLevel}, current level is ${deps.config.permissions.level}. Raise permissions.level in config and restart.`,
            },
          ],
          isError: true,
        };
      }
      return spec.run(args, deps, extra) as unknown as {
        content: { type: "text"; text: string }[];
        isError?: boolean;
      };
    },
  );
}
