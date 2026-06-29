import path from "node:path";
import fs from "node:fs/promises";
import { expandHome } from "../config/schema.js";

/**
 * Path whitelist + traversal/symlink defense.
 *
 * Ported & simplified from the official @modelcontextprotocol/server-filesystem
 * (src/filesystem/path-validation.ts `isPathWithinAllowedDirectories` and lib.ts `validatePath`).
 *
 * Pipeline: fullyDecode → reject NUL → expandHome → resolve absolute → string containment
 *           → realpath containment (symlink defense) → on ENOENT, parent-dir containment fallback
 *           → denied_paths containment (against realpath, prevents symlink bypass).
 */

/** Recursively URL-decode, defending against double-encoding (`%252F` → `%2F` → `/`). */
export function fullyDecode(input: string): string {
  let result = String(input);
  for (let i = 0; i < 10; i++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break; // URIError on malformed percent-encoding
    }
  }
  return result;
}

/**
 * Is `absPath` inside any of `dirs`? The critical detail is the `+ path.sep` suffix on the
 * prefix check — without it `/data` would wrongly match `/database`. Double-normalize both
 * sides to defeat normalization-differential attacks.
 */
export function isWithin(absPath: string, dirs: string[]): boolean {
  if (typeof absPath !== "string" || absPath.length === 0 || absPath.includes("\0")) return false;
  let n: string;
  try {
    n = path.resolve(path.normalize(absPath));
  } catch {
    return false;
  }
  if (!path.isAbsolute(n)) return false;

  return dirs.some((d) => {
    if (typeof d !== "string" || d.length === 0 || d.includes("\0")) return false;
    let nd: string;
    try {
      nd = path.resolve(path.normalize(d));
    } catch {
      return false;
    }
    if (!path.isAbsolute(nd)) return false;

    if (n === nd) return true;
    if (nd === path.sep) return n.startsWith(path.sep); // Unix root — avoid double slash
    // Windows drive-letter root, e.g. C:\
    if (path.sep === "\\" && /^[A-Za-z]:\\?$/.test(nd)) {
      const sameDrive = nd.charAt(0).toLowerCase() === n.charAt(0).toLowerCase();
      return sameDrive && n.startsWith(nd.replace(/\\?$/, "\\"));
    }
    return n.startsWith(nd + path.sep);
  });
}

export interface PathContext {
  /** allowed_roots: realpath-expanded, with the original normalized path also kept (macOS /tmp → /private/tmp). */
  allowedRoots: string[];
  /** denied_roots: same treatment as allowedRoots. */
  deniedRoots: string[];
}

/**
 * Build the roots list for a set of raw (possibly `~`-relative, possibly non-existent) paths.
 * For each root we realpath it and keep BOTH the resolved and original normalized forms, so that
 * a root configured as `/tmp` still matches on macOS where `/tmp` → `/private/tmp`.
 */
export async function buildRoots(rawRoots: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of rawRoots) {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    const normalizedOriginal = path.resolve(path.normalize(absolute));
    try {
      const resolved = await fs.realpath(absolute);
      const normalizedResolved = path.resolve(path.normalize(resolved));
      roots.push(normalizedResolved);
      if (normalizedOriginal !== normalizedResolved) roots.push(normalizedOriginal);
    } catch {
      // Root does not exist yet — allow it (creation may happen later); keep normalized form.
      roots.push(normalizedOriginal);
    }
  }
  return Array.from(new Set(roots));
}

/**
 * Validate and canonicalize a user-supplied path. Returns the realpath (existing target) or the
 * normalized absolute path (new target whose parent is inside the whitelist). Throws on any denial.
 */
export async function validatePath(requestedPath: string, ctx: PathContext): Promise<string> {
  // 1. decode + reject NUL bytes (C-string truncation)
  const decoded = fullyDecode(requestedPath);
  if (decoded.includes("\0")) throw new Error("Null bytes are not allowed in paths");

  // 2. expand ~ and resolve to absolute (relative paths resolve against the first allowed root)
  const expanded = expandHome(decoded);
  const base = ctx.allowedRoots[0] ?? process.cwd();
  const absolute = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(base, expanded);
  const normalizedRequested = path.resolve(path.normalize(absolute));

  // 3. string containment
  if (!isWithin(normalizedRequested, ctx.allowedRoots)) {
    throw new Error("Access denied — path is outside the allowed directories");
  }

  // 4. symlink realpath containment (with ENOENT → parent-dir fallback for new files)
  let realPath: string;
  try {
    const rp = await fs.realpath(absolute);
    const normalizedReal = path.resolve(path.normalize(rp));
    if (!isWithin(normalizedReal, ctx.allowedRoots)) {
      throw new Error("Access denied — symlink target is outside the allowed directories");
    }
    realPath = normalizedReal;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      const parentDir = path.dirname(absolute);
      let realParent: string;
      try {
        realParent = await fs.realpath(parentDir);
      } catch {
        throw new Error("Parent directory does not exist");
      }
      const normalizedParent = path.resolve(path.normalize(realParent));
      if (!isWithin(normalizedParent, ctx.allowedRoots)) {
        throw new Error("Access denied — parent directory is outside the allowed directories");
      }
      // Return the realpath-resolved parent joined with the (verified non-existent) basename, so the
      // returned path's existing components are already resolved rather than re-traversing symlinks.
      realPath = path.join(normalizedParent, path.basename(normalizedRequested));
    } else {
      throw e;
    }
  }

  // 5. denied_paths — checked against the realpath so a symlink can't bypass it
  if (ctx.deniedRoots.length > 0 && isWithin(realPath, ctx.deniedRoots)) {
    throw new Error("Access denied — path is listed in denied_paths");
  }

  return realPath;
}

/**
 * Re-resolve a write target's parent directory realpath immediately before writing, returning a
 * target whose existing parent is fully resolved. This mitigates TOCTOU: validatePath may have run
 * earlier in the request, so we re-confirm the parent dir's real location (defeating a
 * directory-symlink swap between validation and the write) right before the caller opens the file.
 * The residual window between this re-resolve and the actual open is small; full
 * O_NOFOLLOW-per-component hardening is tracked as future work.
 */
export async function safeWriteTarget(target: string, ctx: PathContext): Promise<string> {
  const parent = path.dirname(target);
  const realParent = await fs.realpath(parent); // throws if the parent directory does not exist
  const np = path.resolve(path.normalize(realParent));
  if (!isWithin(np, ctx.allowedRoots)) {
    throw new Error("Access denied — parent directory is outside the allowed directories");
  }
  if (ctx.deniedRoots.length > 0 && isWithin(np, ctx.deniedRoots)) {
    throw new Error("Access denied — parent directory is listed in denied_paths");
  }
  return path.join(np, path.basename(target));
}
