import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PendingStore } from "./pending-store.js";
import type { ToolResult } from "../tools/registry.js";

export interface ConfirmOptions {
  server: McpServer;
  /** SDK RequestHandlerExtra — carries sendRequest for elicitation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: any;
  pending: PendingStore;
  summary: string;
  execute: () => Promise<ToolResult>;
}

/**
 * Layered confirmation for destructive operations (docs/00 §4 D5):
 *   Layer 2 (elicitation) — if the client declared the elicitation capability, ask yes/no inline and
 *     execute on accept (Claude Desktop etc.).
 *   Layer 3 (pending-token) — otherwise, stash the op behind a single-use token (in the session's own
 *     PendingStore) and instruct the model to call confirm_action(token). Works on any client.
 * Layer 1 (destructiveHint annotation) is set at registration time and handled by the host.
 */
export async function withConfirmation(opts: ConfirmOptions): Promise<ToolResult> {
  const caps = opts.server.server.getClientCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supportsElicitation = !!(caps && (caps as any).elicitation && opts.extra?.sendRequest);

  if (supportsElicitation) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await opts.extra.sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: `Confirm action:\n${opts.summary}`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Confirm", default: false } },
              required: ["confirm"],
            },
          },
        },
        ElicitResultSchema,
      );
      if (res?.action === "accept" && res?.content?.confirm === true) {
        return opts.execute();
      }
      return {
        content: [
          {
            type: "text",
            text: `Action not confirmed (user ${res?.action ?? "declined"}). Nothing was changed.`,
          },
        ],
      };
    } catch {
      // Elicitation rejected/failed — fall through to the pending-token path.
    }
  }

  const token = opts.pending.create(opts.summary, opts.execute);
  return {
    content: [
      {
        type: "text",
        text:
          `⚠ Confirmation required: ${opts.summary}\n` +
          `Call confirm_action with token="${token}" and decision="confirm" to execute, ` +
          `or decision="cancel" to abort. The token is single-use and expires in 60s.`,
      },
    ],
  };
}
