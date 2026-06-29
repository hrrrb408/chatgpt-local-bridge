import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ToolSpec } from "./registry.js";
import { validatePath } from "../security/path-validator.js";
import { walk } from "../util/walk.js";
import { textResult, errorResult } from "../util/errors.js";

// ---- list_directory ----
const listSchema = {
  path: z.string(),
  recursive: z.boolean().optional().describe("Recurse into subdirectories (depth-bounded)."),
};
type ListArgs = { path: string; recursive?: boolean };

export const listDirectoryTool: ToolSpec = {
  name: "list_directory",
  description: "List entries in a directory (name, type, size). Optional bounded recursion.",
  inputSchema: listSchema,
  annotations: { readOnlyHint: true },
  run: async (args: ListArgs, deps) => {
    let dir: string;
    try {
      dir = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    const cap = deps.config.limits.max_search_results;
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) return errorResult(`Not a directory: ${args.path}`);

      const rows: { name: string; type: string; size: number }[] = [];
      if (args.recursive) {
        for await (const full of walk(dir)) {
          if (rows.length >= cap) break;
          try {
            const s = await fs.stat(full);
            rows.push({
              name: path.relative(dir, full) || full,
              type: s.isDirectory() ? "dir" : "file",
              size: s.size,
            });
          } catch {
            /* skip unreadable */
          }
        }
      } else {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (rows.length >= cap) break;
          let size = 0;
          try {
            size = (await fs.stat(path.join(dir, e.name))).size;
          } catch {
            /* leave 0 */
          }
          rows.push({ name: e.name, type: e.isDirectory() ? "dir" : "file", size });
        }
      }
      const truncated = rows.length >= cap ? `\n...[capped at ${cap} entries]` : "";
      return textResult(JSON.stringify(rows, null, 2) + truncated);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};

// ---- search_files (by name/glob) ----
const searchFilesSchema = {
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts' or 'config.*'."),
  path: z.string().optional().describe("Search root (defaults to the first allowed root)."),
};
type SearchFilesArgs = { pattern: string; path?: string };

export const searchFilesTool: ToolSpec = {
  name: "search_files",
  description: "Find files by glob pattern under a directory. Capped at max_search_results.",
  inputSchema: searchFilesSchema,
  annotations: { readOnlyHint: true },
  run: async (args: SearchFilesArgs, deps) => {
    const baseRaw = args.path ?? deps.pathCtx.allowedRoots[0];
    let base: string;
    try {
      base = await validatePath(baseRaw, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    const cap = deps.config.limits.max_search_results;
    try {
      const hits: string[] = [];
      for await (const full of walk(base)) {
        if (hits.length >= cap) break;
        const rel = path.relative(base, full) || full;
        // validate each candidate so a symlink escape is rejected, not returned.
        try {
          await validatePath(full, deps.pathCtx);
        } catch {
          continue;
        }
        if (minimatch(rel, args.pattern, { dot: true, matchBase: true })) {
          hits.push(rel);
        }
      }
      const truncated = hits.length >= cap ? `\n...[capped at ${cap} results]` : "";
      return textResult(JSON.stringify(hits, null, 2) + truncated);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
