import { z } from "zod";
import type { ToolSpec } from "./registry.js";
import { textResult, errorResult } from "../util/errors.js";

const schema = {
  token: z.string().describe("Pending-action token returned by the destructive tool."),
  decision: z.enum(["confirm", "cancel"]).describe("'confirm' to execute, 'cancel' to abort."),
};
type Args = { token: string; decision: "confirm" | "cancel" };

export const confirmActionTool: ToolSpec = {
  name: "confirm_action",
  description:
    "Confirm or cancel a destructive action that returned a pending token. Single-use; expires in 60s. " +
    "Confirming triggers the original (possibly destructive) operation.",
  inputSchema: schema,
  // No readOnlyHint: confirming triggers the stored destructive operation.
  annotations: { destructiveHint: true },
  requiredLevel: 0,
  run: async (args: Args, deps) => {
    if (args.decision === "cancel") {
      deps.pending.consume(args.token); // single-use even on cancel
      return textResult("Action cancelled.");
    }
    const entry = deps.pending.consume(args.token);
    if (!entry) return errorResult("Invalid or expired confirmation token.");
    try {
      return await entry.execute();
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
