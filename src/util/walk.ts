import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Recursively yield every entry under `dir`. Each returned path is later validated individually
 * (validatePath), so a symlinked escape is caught at use-time rather than here. `maxDepth` bounds
 * runaway traversal.
 */
export async function* walk(dir: string, opts?: { maxDepth?: number }): AsyncGenerator<string> {
  const maxDepth = opts?.maxDepth ?? 25;
  async function* rec(d: string, depth: number): AsyncGenerator<string> {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      yield full;
      if (e.isDirectory()) {
        yield* rec(full, depth + 1);
      }
    }
  }
  yield* rec(dir, 0);
}
