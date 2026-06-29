import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validatePath,
  buildRoots,
  isWithin,
  fullyDecode,
  safeWriteTarget,
  type PathContext,
} from "../../src/security/path-validator.js";

let tmp: string;
let allowed: string;
let allowedReal: string; // realpath form (macOS: /var → /private/var)
let outside: string;
let denied: string;
let ctx: PathContext;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "clb-"));
  allowed = path.join(tmp, "allowed");
  outside = path.join(tmp, "outside");
  denied = path.join(allowed, "denied");
  await fsp.mkdir(allowed, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.mkdir(denied, { recursive: true });
  await fsp.writeFile(path.join(allowed, "file.txt"), "hello world");
  await fsp.writeFile(path.join(outside, "secret.txt"), "secret");
  await fsp.writeFile(path.join(denied, "key.pem"), "PRIVATE");
  allowedReal = await fsp.realpath(allowed);
  const allowedRoots = await buildRoots([allowed]);
  const deniedRoots = await buildRoots([denied]);
  ctx = { allowedRoots, deniedRoots };
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("isWithin / containment boundary", () => {
  it("distinguishes sibling prefixes (/data vs /database)", () => {
    expect(isWithin("/data/x", ["/data"])).toBe(true);
    expect(isWithin("/database/x", ["/data"])).toBe(false);
    expect(isWithin("/data", ["/data"])).toBe(true);
  });

  it("rejects null bytes", () => {
    expect(isWithin("/data/x\0", ["/data"])).toBe(false);
  });
});

describe("fullyDecode", () => {
  it("decodes double-encoded traversal", () => {
    expect(fullyDecode("%252e%252e")).toBe("..");
  });
});

describe("validatePath — happy paths", () => {
  it("allows an existing file inside the root", async () => {
    const p = await validatePath(path.join(allowed, "file.txt"), ctx);
    expect(p).toBe(path.join(allowedReal, "file.txt"));
  });

  it("allows a new file inside an existing directory (ENOENT parent fallback)", async () => {
    const p = await validatePath(path.join(allowed, "new.txt"), ctx);
    // New target returns realpath(parent) + basename, so existing components are already resolved.
    expect(p).toBe(path.join(allowedReal, "new.txt"));
  });

  it("resolves a relative path against the first allowed root", async () => {
    const p = await validatePath("file.txt", ctx);
    expect(p).toBe(path.join(allowedReal, "file.txt"));
  });
});

describe("validatePath — traversal defenses", () => {
  it("rejects ../ traversal to a sibling", async () => {
    await expect(
      validatePath(path.join(allowed, "..", "outside", "secret.txt"), ctx),
    ).rejects.toThrow(/outside the allowed directories/);
  });

  it("rejects an absolute path outside the root", async () => {
    await expect(validatePath(path.join(outside, "secret.txt"), ctx)).rejects.toThrow(
      /outside the allowed directories/,
    );
  });

  it("rejects double-URL-encoded traversal", async () => {
    const enc =
      encodeURIComponent(allowed) + "%2F..%2F" + path.basename(outside) + "%2Fsecret.txt";
    await expect(validatePath(enc, ctx)).rejects.toThrow(/outside the allowed directories/);
  });

  it("rejects null bytes", async () => {
    await expect(validatePath(path.join(allowed, "file.txt") + "\0.evil", ctx)).rejects.toThrow(
      /Null bytes/,
    );
  });
});

describe("validatePath — symlink defenses", () => {
  it("rejects a symlink pointing outside the root (existing target)", async () => {
    const link = path.join(allowed, "evil");
    await fsp.symlink(outside, link);
    await expect(validatePath(path.join(link, "secret.txt"), ctx)).rejects.toThrow(
      /outside the allowed directories/,
    );
  });

  it("rejects writing inside a symlinked directory that escapes the root", async () => {
    const linkDir = path.join(allowed, "escape");
    await fsp.symlink(outside, linkDir);
    await expect(validatePath(path.join(linkDir, "new.txt"), ctx)).rejects.toThrow(
      /outside the allowed directories|Parent directory/,
    );
  });

  it("allows a symlink that stays within the root", async () => {
    await fsp.mkdir(path.join(allowed, "sub"));
    const link = path.join(allowed, "link");
    await fsp.symlink(path.join(allowed, "sub"), link);
    const p = await validatePath(path.join(link), ctx);
    expect(p).toBe(path.join(allowedReal, "sub"));
  });
});

describe("validatePath — denied_paths", () => {
  it("rejects a path under denied_paths", async () => {
    await expect(validatePath(path.join(denied, "key.pem"), ctx)).rejects.toThrow(/denied_paths/);
  });

  it("cannot be bypassed by a symlink into denied_paths", async () => {
    const link = path.join(allowed, "stolen");
    await fsp.symlink(denied, link);
    await expect(validatePath(path.join(link, "key.pem"), ctx)).rejects.toThrow(/denied_paths/);
  });
});

describe("validatePath — macOS /tmp → /private/tmp resilience", () => {
  it("buildRoots keeps both original and realpath forms", async () => {
    // On macOS os.tmpdir() is under /var/folders which symlinks to /private/var/folders.
    // Validating a file under tmp via buildRoots([tmp]) must still succeed.
    const roots = await buildRoots([tmp]);
    const fileCtx: PathContext = { allowedRoots: roots, deniedRoots: [] };
    const target = path.join(tmp, "x.txt");
    await fsp.writeFile(target, "x");
    const p = await validatePath(target, fileCtx);
    expect(p).toBeTruthy();
  });
});

describe("validatePath — non-existent parent", () => {
  it("rejects a new file whose parent directory does not exist", async () => {
    await expect(validatePath(path.join(allowed, "nope", "deep", "new.txt"), ctx)).rejects.toThrow(
      /Parent directory does not exist/,
    );
  });
});

describe("safeWriteTarget — TOCTOU re-resolution", () => {
  it("returns realpath(parent) + basename for a writable new file", async () => {
    const p = await safeWriteTarget(path.join(allowed, "new.txt"), ctx);
    expect(p).toBe(path.join(allowedReal, "new.txt"));
  });

  it("rejects a target whose parent is outside the whitelist", async () => {
    await expect(safeWriteTarget(path.join(outside, "new.txt"), ctx)).rejects.toThrow(
      /outside the allowed directories/,
    );
  });

  it("rejects a denied parent", async () => {
    await expect(safeWriteTarget(path.join(denied, "new.txt"), ctx)).rejects.toThrow(/denied_paths/);
  });
});

// keep `fs` import referenced for symlink stat assertions if extended later
void fs;
