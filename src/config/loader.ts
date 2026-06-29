import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { ConfigSchema, type Config } from "./schema.js";

export function configDir(): string {
  return path.join(os.homedir(), ".chatgpt-local-bridge");
}

export function configPath(): string {
  return path.join(configDir(), "config.yaml");
}

/** Resolved default config (paths already `~`-expanded). */
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** Deep-merge a parsed user object over the defaults. Arrays are replaced, not concatenated. */
function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base)) {
    return (Array.isArray(override) ? override : base) as T;
  }
  if (base && typeof base === "object" && override && typeof override === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override as Record<string, unknown>)) {
      out[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }
  // null is treated as "unset" (fall back to the default) — consistent for scalars and arrays, so a
  // user writing `allowed_paths: null` in YAML gets the default rather than a zod rejection.
  return override === undefined || override === null ? base : (override as T);
}

export interface LoadedConfig {
  config: Config;
  /** true when the config file did not exist and was generated from defaults. */
  created: boolean;
  path: string;
}

/**
 * Load (and on first run, generate) the YAML config, deep-merge over defaults,
 * validate with zod, and return. Throws with a field-path-organized message on invalid config.
 */
export function loadConfig(): LoadedConfig {
  const file = configPath();
  let raw: unknown = {};
  let created = false;

  if (!fs.existsSync(file)) {
    created = true;
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(file, yaml.dump(DEFAULT_CONFIG), "utf8");
  } else {
    const text = fs.readFileSync(file, "utf8");
    raw = yaml.load(text) ?? {};
  }

  const merged = deepMerge(DEFAULT_CONFIG, raw);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const msgs = result.error.issues
      .map((i) => `  - [${i.path.join(".") || "(root)"}] ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config (${file}):\n${msgs}`);
  }

  return { config: result.data, created, path: file };
}
