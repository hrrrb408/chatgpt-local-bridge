import { z } from "zod";
import fsp from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { validatePath } from "../security/path-validator.js";
import { textResult, errorResult } from "../util/errors.js";

const schema = {
  path: z.string().describe("Project root directory."),
};
type Args = { path: string };

const MARKERS: Record<string, string> = {
  ".git": "git",
  package: "node",
  "package.json": "node",
  "tsconfig.json": "typescript",
  requirements: "python",
  "requirements.txt": "python",
  "pyproject.toml": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "Gemfile": "ruby",
  "composer.json": "php",
};

export const getProjectInfoTool: ToolSpec = {
  name: "get_project_info",
  description:
    "Inspect a directory and report detected project type(s) via marker files and a capped " +
    "top-level structure listing.",
  inputSchema: schema,
  annotations: { readOnlyHint: true },
  requiredLevel: 0,
  run: async (args: Args, deps) => {
    let dir: string;
    try {
      dir = await validatePath(args.path, deps.pathCtx);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    try {
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) return errorResult(`Not a directory: ${args.path}`);

      const types = new Set<string>();
      const files = await fsp.readdir(dir, { withFileTypes: true });
      const present = new Set(files.map((f) => f.name));
      for (const marker of Object.keys(MARKERS)) {
        if (present.has(marker)) types.add(MARKERS[marker]!);
      }

      const topEntries = files
        .slice(0, 100)
        .map((f) => ({ name: f.name, type: f.isDirectory() ? "dir" : "file" }));

      return textResult(
        JSON.stringify(
          {
            path: dir,
            types: [...types],
            topEntries,
            truncated: files.length > 100,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
};
