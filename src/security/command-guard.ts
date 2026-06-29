import { parse as shellParse } from "shell-quote";
import path from "node:path";

/**
 * Guards run_command against command injection and dangerous commands (docs/02 §2.4).
 *
 * run_command ultimately calls spawn(file, args, { shell: false }), so the ONLY way to inject is a
 * program that re-interprets its own arguments — i.e. a shell/interpreter (`bash -c`, `python -c`,
 * `node -e`) or a wrapper that runs a sub-command (`env rm`, `xargs rm`). Those are blocked
 * outright. Anything requiring shell features (pipes, &&, redirects, $(), globs, backticks) is
 * rejected because shell:false can't honor it and spawning a shell would reintroduce injection.
 */
export interface GuardResult {
  allowed: boolean;
  reason?: string;
  argv?: string[];
}

// Blocked outright in ANY invocation. Shells/interpreters re-interpret their args (defeating
// argv checks); wrappers run a hidden sub-command; destructive utils are system-level hazards.
const BLOCKED = new Set([
  // shells
  "sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish", "ash", "rksh", "mksh",
  // interpreters (execute injected code via -c/-e/scripts)
  "python", "python2", "python3", "perl", "ruby", "php", "lua", "luajit", "node", "nodejs",
  "awk", "gawk", "mawk", "sed", "osascript", "tclsh", "wish", "r", "rscript", "jshell", "ghci",
  // command wrappers (run a sub-command, bypassing the blocklist)
  "env", "xargs", "exec", "nohup", "time", "strace", "ltrace", "runuser", "setsid", "nice",
  "command", "builtin", "pkexec", "doas", "su", "sudo", "gosu", "chroot",
  // destructive system utilities
  "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "shred", "mkswap",
]);

function firstWord(entry: string): string {
  return (entry.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

function isAssignment(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

function nameMatches(cmdName: string, names: Set<string>): boolean {
  return names.has(cmdName) || [...names].some((n) => cmdName.startsWith(n + "."));
}

interface Split {
  shortFlags: string;
  longFlags: Set<string>;
  targets: string[];
}
function splitArgs(args: string[]): Split {
  const longFlags = new Set<string>();
  let shortFlags = "";
  const targets: string[] = [];
  let endOfOpts = false;
  for (const a of args) {
    if (endOfOpts) {
      targets.push(a);
    } else if (a === "--") {
      endOfOpts = true;
    } else if (a.startsWith("--")) {
      longFlags.add(a.toLowerCase());
    } else if (a.startsWith("-") && a.length > 1) {
      shortFlags += a.slice(1);
    } else {
      targets.push(a);
    }
  }
  return { shortFlags, longFlags, targets };
}

function isDangerousTarget(t: string): boolean {
  return (
    t === "" ||
    t === "/" ||
    t === "/*" ||
    t === "*" ||
    t === "~" ||
    t.startsWith("~/") ||
    t === "." ||
    t === "./" ||
    t === "../"
  );
}

export function guardCommand(command: string, blocked: string[] = []): GuardResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty command" };
  if (trimmed.includes("`")) return { allowed: false, reason: "backticks are not allowed" };

  let tokens: unknown[];
  try {
    tokens = shellParse(trimmed);
  } catch {
    return { allowed: false, reason: "failed to parse command" };
  }

  const argv: string[] = [];
  for (const tok of tokens) {
    if (typeof tok === "string") {
      argv.push(tok);
    } else {
      return {
        allowed: false,
        reason: `shell operators/globs/substitution are not supported (run a single command); detected: ${JSON.stringify(tok)}`,
      };
    }
  }
  if (argv.length === 0) return { allowed: false, reason: "no command" };

  // Reject inline env-var assignments (KEY=VALUE) — they shift argv[0] and aren't needed here.
  if (argv.some(isAssignment)) {
    return { allowed: false, reason: "inline environment assignments (KEY=VALUE) are not allowed" };
  }

  const userBlocked = new Set(blocked.map(firstWord).filter(Boolean));
  const cmdName = path.basename(argv[0]).toLowerCase();
  if (nameMatches(cmdName, BLOCKED) || nameMatches(cmdName, userBlocked)) {
    return { allowed: false, reason: `blocked command: ${cmdName}` };
  }

  const { shortFlags, longFlags, targets } = splitArgs(argv.slice(1));
  const recursive = /[rR]/.test(shortFlags) || longFlags.has("--recursive");
  const force = /f/.test(shortFlags) || longFlags.has("--force");
  const anyDangerous = targets.some(isDangerousTarget);

  if (cmdName === "rm" && recursive && force && anyDangerous) {
    return { allowed: false, reason: "rm -rf targeting root/home/cwd/glob" };
  }
  if ((cmdName === "chmod" || cmdName === "chown" || cmdName === "chgrp") && recursive && anyDangerous) {
    return { allowed: false, reason: `${cmdName} -R targeting root/home/cwd/glob` };
  }
  if (
    cmdName === "find" &&
    argv.slice(1).some((t) => t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok")
  ) {
    return { allowed: false, reason: "find with -delete/-exec is not allowed" };
  }

  return { allowed: true, argv };
}
