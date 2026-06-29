import { z } from "zod";
import path from "node:path";
import os from "node:os";

/**
 * Expand a leading `~` (`~` or `~/x` / `~\x`) to the user's home directory.
 * js-yaml does NOT expand `~`; we must do it ourselves. Idempotent on absolute paths.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** A path string that is `~`-expanded on parse. */
const pathField = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .transform((v) => expandHome(v));

export const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(3456),
        host: z.string().trim().min(1).default("127.0.0.1"),
        // Optional allow-list of permitted Host header values (DNS-rebinding protection). When set,
        // only these hosts are accepted. Left unset by default so dynamic tunnel domains (ngrok,
        // cloudflared) work without configuration; set it to lock down to known hostnames.
        allowed_hosts: z.array(z.string().trim().min(1)).optional(),
        // Log every MCP request (method/accept/status) to stdout. Off by default; turn on to debug
        // client interop (e.g. ChatGPT connection issues).
        log_requests: z.boolean().default(false),
      })
      .default({}),
    permissions: z
      .object({
        // 0 = read-only, 1 = edit (+write/edit/move/delete), 2 = full (+run_command)
        level: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
        allowed_paths: z
          .array(pathField)
          .default(["~/Desktop", "~/Documents"]),
        denied_paths: z.array(pathField).default([]),
      })
      .default({}),
    limits: z
      .object({
        max_read_size: z.number().int().positive().default(524288), // 500 KB
        max_write_size: z.number().int().positive().default(1048576), // 1 MB
        max_search_results: z.number().int().positive().default(50),
        command_timeout: z.number().int().positive().default(30), // seconds
      })
      .default({}),
    safety: z
      .object({
        confirm_delete: z.boolean().default(true),
        confirm_overwrite: z.boolean().default(true),
        confirm_command: z.boolean().default(true),
        blocked_commands: z
          .array(z.string().trim().min(1))
          .default(["rm -rf /", "sudo", "mkfs", "dd if=", "shutdown", "reboot", "halt"]),
      })
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
