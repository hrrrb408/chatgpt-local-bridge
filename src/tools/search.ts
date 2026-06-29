import { z } from "zod";
import fsp from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ToolSpec } from "./registry.js";
import { validatePath } from "../security/path-validator.js";
import { walk } from "../util/walk.js";
import { textResult, errorResult } from "../util/errors.js";

// Defensive caps to bound resource use against adversarial inputs (large files / ReDoS).
const MAX_PATTERN_LEN = 500;
const MAX_LINE_LEN = 8192; // truncate each line before regex.test to curb catastrophic backtracking
const MAX_SCAN_FILE_SIZE = 10 * 1024 * 1024; // skip files larger than 10 MB

const schema = {
  pattern: z.string().describe("Regular expression to match within each line."),
  path: z.string().optional().describe("Search root (defaults to the first allowed root)."),
  file_glob: z
    .string()
    .optional()
    .describe("Restrict to files matching this glob, e.g. '**/*.ts' or '*.ts' (matches at any depth)."),
};
type Args = { pattern: string; path?: string; file_glob?: string };

function looksBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export const searchContentTool: ToolSpec = {
  name: "search_content",
  description:
    "Search file contents by regular expression. Returns file:line matches. Skips binary files " +
    "and files larger than 10 MB. Each line is truncated before matching (ReDoS mitigation). " +
    "Capped at max_search_results.",
  inputSchema: schema,
  annotations: { readOnlyHint: true },
  run: async (args: Args, deps) => {
    if (args.pattern.length > MAX_PATTERN_LEN) {
      return errorResult(`pattern is too long (max ${MAX_PATTERN_LEN} chars).`);
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      return errorResult(`Invalid regex: ${(e as Error).message}`);
    }

    const baseRaw = args.path ?? deps.pathCtx.allowedRoots[0];
    let base: string;
    try {
      base = await validatePath(baseRaw, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    const cap = deps.config.limits.max_search_results;

    try {
      const matches: { file: string; line: number; text: string }[] = [];
      let skippedLarge = 0;
      for await (const full of walk(base)) {
        if (matches.length >= cap) break;
        let validated: string;
        try {
          validated = await validatePath(full, deps.pathCtx);
        } catch {
          continue; // symlink escape or denied — skip
        }
        try {
          const stat = await fsp.stat(validated);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_SCAN_FILE_SIZE) {
            skippedLarge++;
            continue;
          }
          if (args.file_glob) {
            const rel = path.relative(base, validated);
            // matchBase so '*.ts' matches at any depth — consistent with search_files.
            if (!minimatch(rel, args.file_glob, { dot: true, matchBase: true })) continue;
          }
          const buf = await fsp.readFile(validated);
          if (looksBinary(buf)) continue;
          const text = buf.toString("utf8");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= cap) break;
            const raw = lines[i] ?? "";
            const candidate = raw.length > MAX_LINE_LEN ? raw.slice(0, MAX_LINE_LEN) : raw;
            if (re.test(candidate)) {
              matches.push({
                file: path.relative(base, validated) || validated,
                line: i + 1,
                text: raw.slice(0, 500),
              });
            }
          }
        } catch {
          /* skip unreadable */
        }
      }
      const truncated = matches.length >= cap ? `\n...[capped at ${cap} matches]` : "";
      const skippedNote = skippedLarge > 0 ? `\n(skipped ${skippedLarge} file(s) larger than 10 MB)` : "";
      return textResult(JSON.stringify(matches, null, 2) + truncated + skippedNote);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
