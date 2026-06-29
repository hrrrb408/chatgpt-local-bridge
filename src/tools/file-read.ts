import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";
import type { ToolSpec } from "./registry.js";
import { validatePath } from "../security/path-validator.js";
import { textResult, errorResult } from "../util/errors.js";

const inputSchema = {
  path: z.string().describe("Absolute path, or relative to the first allowed root."),
  offset: z.number().int().min(0).optional().describe("Number of lines to skip from the top (0-based)."),
  limit: z.number().int().min(1).optional().describe("Max number of lines to return."),
};
type Args = { path: string; offset?: number; limit?: number };

/**
 * Reads a file as a STREAM of lines so the whole file is never held in memory. Output is capped at
 * max_read_size bytes (truncated with a notice). This also bounds ranged reads — a previous version
 * read the entire file before slicing, which OOM'd on large files even with offset/limit set.
 */
export const readFileTool: ToolSpec = {
  name: "read_file",
  description:
    "Read a UTF-8 text file as a stream. Returns the content, optionally a line range " +
    "[offset+1 .. offset+limit]. Output is capped at max_read_size bytes (truncated with a notice); " +
    "use offset/limit to page through larger files. Never loads the whole file into memory.",
  inputSchema,
  annotations: { readOnlyHint: true },
  run: async (args: Args, deps) => {
    let file: string;
    try {
      file = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }

    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return errorResult(`Not a regular file: ${args.path}`);

      const max = deps.config.limits.max_read_size;
      const offset = args.offset ?? 0;
      const limit = args.limit;
      const ranged = args.offset != null || args.limit != null;

      const stream = fs.createReadStream(file);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let body = "";
      let bytes = 0;
      let lineNo = 0;
      let captured = 0;
      let firstLine = -1;
      let lastLine = -1;
      let truncated = false;

      for await (const line of rl) {
        lineNo++;
        if (lineNo <= offset) continue;
        if (limit != null && captured >= limit) break;

        if (firstLine === -1) firstLine = lineNo;
        const piece = captured === 0 ? line : "\n" + line;
        const pieceBytes = Buffer.byteLength(piece, "utf8");
        if (bytes + pieceBytes > max) {
          const remaining = max - bytes;
          if (remaining > 0) {
            body += Buffer.from(piece, "utf8").subarray(0, remaining).toString("utf8");
          }
          truncated = true;
          lastLine = lineNo;
          break;
        }
        body += piece;
        bytes += pieceBytes;
        lastLine = lineNo;
        captured++;
      }
      rl.close();
      stream.destroy();

      let prefix = "";
      if (ranged) {
        prefix =
          firstLine === -1
            ? `[empty range — offset ${offset} is at or past end of file]`
            : `[lines ${firstLine}-${lastLine}]`;
      }
      const notice = truncated ? `\n...[truncated at ~${max} bytes]` : "";
      return textResult((prefix ? prefix + "\n" : "") + body + notice);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
