import { z } from "zod";
import fsp from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { validatePath, safeWriteTarget } from "../security/path-validator.js";
import { withConfirmation } from "../security/confirm.js";
import { atomicWrite } from "../util/atomic-write.js";
import { textResult, errorResult } from "../util/errors.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- write_file ----
const writeSchema = {
  path: z.string(),
  content: z.string().describe("Full new file content (UTF-8)."),
};
type WriteArgs = { path: string; content: string };

export const writeFileTool: ToolSpec = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Overwriting an existing file is destructive " +
    "and goes through confirmation (host annotation, elicitation, or a confirm_action token). " +
    "Subject to max_write_size.",
  inputSchema: writeSchema,
  annotations: { destructiveHint: true },
  requiredLevel: 1,
  run: async (args: WriteArgs, deps, extra) => {
    let target: string;
    try {
      target = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > deps.config.limits.max_write_size) {
      return errorResult(
        `Content is ${bytes} bytes, exceeds max_write_size (${deps.config.limits.max_write_size}).`,
      );
    }
    const alreadyExists = await exists(target);

    const doWrite = async () => {
      const t = await safeWriteTarget(target, deps.pathCtx);
      await atomicWrite(t, args.content);
      return textResult(`${alreadyExists ? "Overwrote" : "Created"} ${t} (${bytes} bytes).`);
    };

    if (alreadyExists && deps.config.safety.confirm_overwrite) {
      return withConfirmation({
        server: deps.server,
        extra,
        pending: deps.pending,
        summary: `Overwrite existing file ${target} (${bytes} bytes)`,
        execute: doWrite,
      });
    }
    return doWrite();
  },
};

// ---- edit_file ----
const editSchema = {
  path: z.string(),
  old_text: z.string().describe("The exact text to find. Must occur exactly once."),
  new_text: z.string().describe("Replacement text."),
};
type EditArgs = { path: string; old_text: string; new_text: string };

export const editFileTool: ToolSpec = {
  name: "edit_file",
  description:
    "Replace a single, unique occurrence of old_text with new_text without touching the rest of " +
    "the file. Errors if old_text is empty, not found, or not unique.",
  inputSchema: editSchema,
  annotations: { destructiveHint: true },
  requiredLevel: 1,
  run: async (args: EditArgs, deps) => {
    if (args.old_text.length === 0) return errorResult("old_text must not be empty.");
    let target: string;
    try {
      target = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    try {
      const original = await fsp.readFile(target, "utf8");
      const first = original.indexOf(args.old_text);
      if (first === -1) return errorResult("old_text not found in the file.");
      if (original.indexOf(args.old_text, first + 1) !== -1) {
        return errorResult("old_text is not unique — include more surrounding context.");
      }
      const updated =
        original.slice(0, first) + args.new_text + original.slice(first + args.old_text.length);
      const bytes = Buffer.byteLength(updated, "utf8");
      if (bytes > deps.config.limits.max_write_size) {
        return errorResult(`Result would be ${bytes} bytes, exceeds max_write_size.`);
      }
      target = await safeWriteTarget(target, deps.pathCtx);
      await atomicWrite(target, updated);
      return textResult(`Edited 1 occurrence in ${target}.`);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
