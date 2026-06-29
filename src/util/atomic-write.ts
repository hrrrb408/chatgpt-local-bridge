import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomically write `data` to `target`.
 *
 * Strategy: open a randomly-named temp file with `wx` (exclusive create — fails if the path
 * already exists or is a symlink) in the SAME directory, write, close, then `rename` over the
 * target. `rename` does NOT follow symlinks, so the LEAF target cannot be swapped for a symlink
 * to redirect the write. Partial writes never reach the target on failure (the temp is cleaned up).
 *
 * Scope: this defends a leaf (target) symlink swap only. A DIRECTORY-component swap (replacing the
 * target's parent directory with a symlink between validation and the write) is NOT handled here —
 * callers must pass a target produced by safeWriteTarget(), which re-resolves the parent realpath
 * immediately before this call to shrink that window.
 */
export async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.${randomBytes(6).toString("hex")}.tmp`);

  const fh = await fs.open(tmp, "wx");
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }

  try {
    await fs.rename(tmp, target);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
