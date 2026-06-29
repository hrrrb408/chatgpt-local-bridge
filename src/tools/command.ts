import { z } from "zod";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import type { ToolSpec, ToolResult } from "./registry.js";
import { validatePath } from "../security/path-validator.js";
import { guardCommand } from "../security/command-guard.js";
import { withConfirmation } from "../security/confirm.js";
import { textResult, errorResult } from "../util/errors.js";

const schema = {
  command: z.string().describe("A single shell command (no pipes/redirects/&&)."),
  timeout: z.number().int().min(1).optional().describe("Override command_timeout (seconds)."),
  workdir: z.string().optional().describe("Working directory (validated against the whitelist)."),
};
type Args = { command: string; timeout?: number; workdir?: string };

const MAX_STDOUT = 500_000;
const MAX_STDERR = 200_000;

export const runCommandTool: ToolSpec = {
  name: "run_command",
  description:
    "Execute a single shell command with spawn(shell:false) — no pipes, redirects, &&, globs, " +
    "substitution, backticks, inline env assignments, shells, interpreters, or command wrappers. " +
    "Blocked commands (sudo/mkfs/dd/…) and rm -rf / are rejected. Subject to command_timeout and confirmation.",
  inputSchema: schema,
  annotations: { destructiveHint: true, openWorldHint: true },
  requiredLevel: 2,
  run: async (args: Args, deps, extra) => {
    const guard = guardCommand(args.command, deps.config.safety.blocked_commands);
    if (!guard.allowed || !guard.argv) {
      return errorResult(`Command rejected: ${guard.reason}`);
    }
    const [file, ...cmdArgs] = guard.argv;
    if (!file) return errorResult("Command rejected: empty");

    const timeoutSec = args.timeout ?? deps.config.limits.command_timeout;
    const workdirRaw = args.workdir;

    const resolveWorkdir = async (): Promise<string | undefined> => {
      if (!workdirRaw) return undefined;
      const w = await validatePath(workdirRaw, deps.pathCtx);
      const s = await fsp.stat(w);
      if (!s.isDirectory()) throw new Error(`workdir is not a directory: ${workdirRaw}`);
      return w;
    };

    // Validate workdir at request time so an invalid workdir errors before confirmation.
    let workdir: string | undefined;
    if (workdirRaw) {
      try {
        workdir = await resolveWorkdir();
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }

    const doRun = async (): Promise<ToolResult> => {
      // Re-resolve workdir at execution time (confirmation can happen later).
      let cwd = workdir;
      if (workdirRaw) {
        try {
          cwd = await resolveWorkdir();
        } catch (e) {
          return errorResult((e as Error).message);
        }
      }
      return new Promise<ToolResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let overflowKilled = false;
        let stopped = false;
        const child = spawn(file!, cmdArgs, {
          shell: false,
          cwd,
          timeout: timeoutSec * 1000,
        });
        child.stdout?.on("data", (d: Buffer) => {
          if (stopped) return;
          stdout += d.toString("utf8");
          if (stdout.length > MAX_STDOUT) {
            overflowKilled = true;
            stopped = true;
            child.kill("SIGKILL");
          }
        });
        child.stderr?.on("data", (d: Buffer) => {
          if (stopped) return;
          stderr += d.toString("utf8");
          if (stderr.length > MAX_STDERR) {
            overflowKilled = true;
            stopped = true;
            child.kill("SIGKILL");
          }
        });
        child.on("error", (e) => resolve(errorResult(`Failed to start command: ${e.message}`)));
        child.on("close", (code, signal) => {
          let tag = "";
          if (overflowKilled) tag = `(killed: output exceeded limit)`;
          else if (signal === "SIGTERM" || signal === "SIGKILL") tag = `(timed out after ${timeoutSec}s)`;
          resolve(
            textResult(
              `exit: ${code === null ? `signal:${signal}` : code} ${tag}\n` +
                `--- stdout ---\n${stdout.slice(0, MAX_STDOUT)}\n` +
                `--- stderr ---\n${stderr.slice(0, MAX_STDERR)}`,
            ),
          );
        });
      });
    };

    if (deps.config.safety.confirm_command) {
      return withConfirmation({
        server: deps.server,
        extra,
        pending: deps.pending,
        summary: `Run command: ${args.command}`,
        execute: doRun,
      });
    }
    return doRun();
  },
};
