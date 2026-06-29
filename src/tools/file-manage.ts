import { z } from "zod";
import fsp from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { validatePath, safeWriteTarget } from "../security/path-validator.js";
import { withConfirmation } from "../security/confirm.js";
import { textResult, errorResult } from "../util/errors.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- delete_file ----
const deleteSchema = { path: z.string() };
type DeleteArgs = { path: string };

export const deleteFileTool: ToolSpec = {
  name: "delete_file",
  description:
    "Delete a file. Destructive — goes through confirmation (host annotation, elicitation, or a " +
    "confirm_action token). Directories are rejected (use a shell command at Level 2).",
  inputSchema: deleteSchema,
  annotations: { destructiveHint: true },
  requiredLevel: 1,
  run: async (args: DeleteArgs, deps, extra) => {
    let target: string;
    try {
      target = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) {
        return errorResult(`${args.path} is a directory; delete_file only removes files.`);
      }
    } catch (e) {
      return errorResult((e as Error).message);
    }

    const doDelete = async () => {
      // Re-validate at execution time (confirmation can happen up to 60s later): the file may have
      // changed type or its parent may have left the whitelist.
      const t = await validatePath(args.path, deps.pathCtx);
      const s = await fsp.stat(t);
      if (s.isDirectory()) return errorResult(`${args.path} is a directory; delete_file only removes files.`);
      await fsp.rm(t);
      return textResult(`Deleted ${t}.`);
    };

    if (deps.config.safety.confirm_delete) {
      return withConfirmation({
        server: deps.server,
        extra,
        pending: deps.pending,
        summary: `Delete file ${target}`,
        execute: doDelete,
      });
    }
    return doDelete();
  },
};

// ---- move_file ----
const moveSchema = {
  source: z.string(),
  destination: z.string(),
};
type MoveArgs = { source: string; destination: string };

export const moveFileTool: ToolSpec = {
  name: "move_file",
  description:
    "Move/rename a file. Both source and destination are validated against the whitelist. " +
    "Refuses to overwrite an existing destination; the destination's parent directory must exist.",
  inputSchema: moveSchema,
  annotations: { destructiveHint: true },
  requiredLevel: 1,
  run: async (args: MoveArgs, deps) => {
    let source: string;
    let dest: string;
    try {
      source = await validatePath(args.source, deps.pathCtx);
      dest = await validatePath(args.destination, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    if (await exists(dest)) {
      return errorResult(`Destination already exists; move_file refuses to overwrite: ${dest}`);
    }
    try {
      const sstat = await fsp.lstat(source);
      if (!sstat.isFile()) {
        return errorResult(`Source is not a regular file: ${source}`);
      }
      await fsp.rename(source, dest);
      return textResult(`Moved ${source} → ${dest}.`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EXDEV") {
        try {
          const safeDest = await safeWriteTarget(dest, deps.pathCtx);
          await fsp.copyFile(source, safeDest);
          try {
            await fsp.rm(source);
          } catch (rmErr) {
            try {
              await fsp.unlink(safeDest);
            } catch {
              /* best effort */
            }
            return errorResult(
              `Copied to destination but failed to remove source: ${(rmErr as Error).message}. Rolled back the copy.`,
            );
          }
          return textResult(`Moved (cross-device) ${source} → ${safeDest}.`);
        } catch (e2) {
          return errorResult((e2 as Error).message);
        }
      }
      return errorResult(err.message);
    }
  },
};

// ---- get_file_info ----
const infoSchema = { path: z.string() };
type InfoArgs = { path: string };

export const getFileInfoTool: ToolSpec = {
  name: "get_file_info",
  description: "Return file metadata: size, modification time, and type (file/directory/symlink).",
  inputSchema: infoSchema,
  annotations: { readOnlyHint: true },
  requiredLevel: 0,
  run: async (args: InfoArgs, deps) => {
    let target: string;
    try {
      target = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    try {
      const stat = await fsp.lstat(target);
      const type = stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "other";
      return textResult(
        JSON.stringify(
          { path: target, type, size: stat.size, mtime: stat.mtime.toISOString() },
          null,
          2,
        ),
      );
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
