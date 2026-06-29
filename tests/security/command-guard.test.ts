import { describe, it, expect } from "vitest";
import { guardCommand } from "../../src/security/command-guard.js";

describe("command-guard — basic", () => {
  it("allows a simple command with args", () => {
    const r = guardCommand("echo hello world");
    expect(r.allowed).toBe(true);
    expect(r.argv).toEqual(["echo", "hello", "world"]);
  });
  it("allows common build/inspect tools", () => {
    expect(guardCommand("git status").allowed).toBe(true);
    expect(guardCommand("npm test").allowed).toBe(true);
    expect(guardCommand("ls -la").allowed).toBe(true);
  });
  it("allows rm of a single file", () => {
    expect(guardCommand("rm somefile.tmp").allowed).toBe(true);
  });
  it("does not block chmod of a single file", () => {
    expect(guardCommand("chmod 644 file").allowed).toBe(true);
  });
});

describe("command-guard — blocked names", () => {
  it("blocks dangerous command names", () => {
    expect(guardCommand("sudo rm x").allowed).toBe(false);
    expect(guardCommand("mkfs.ext4 /dev/sda1").allowed).toBe(false);
    expect(guardCommand("dd if=/dev/zero of=/dev/sda").allowed).toBe(false);
  });
  it("strips the directory prefix", () => {
    expect(guardCommand("/bin/sudo x").allowed).toBe(false);
  });
  it("honors user blocked_commands by command name", () => {
    expect(guardCommand("curl http://x", ["curl"]).allowed).toBe(false);
    expect(guardCommand("wget http://x", ["curl"]).allowed).toBe(true);
  });
});

describe("command-guard — injection vectors (interpreter/wrapper bypass)", () => {
  it("blocks shell interpreters", () => {
    expect(guardCommand('bash -c "sudo rm"').allowed).toBe(false);
    expect(guardCommand("sh -c rm").allowed).toBe(false);
    expect(guardCommand("zsh -c x").allowed).toBe(false);
  });
  it("blocks general interpreters that eval inline code", () => {
    expect(guardCommand("python3 -c 'import os'").allowed).toBe(false);
    expect(guardCommand("python -c x").allowed).toBe(false);
    expect(guardCommand('node -e "require(\'fs\')"').allowed).toBe(false);
    expect(guardCommand("perl -e 'x'").allowed).toBe(false);
    expect(guardCommand("ruby -e 'x'").allowed).toBe(false);
  });
  it("blocks command wrappers that run a sub-command", () => {
    expect(guardCommand("env rm -rf /").allowed).toBe(false);
    expect(guardCommand("env sudo rm /").allowed).toBe(false);
    expect(guardCommand("xargs rm").allowed).toBe(false);
    expect(guardCommand("nohup rm x").allowed).toBe(false);
    expect(guardCommand("exec rm x").allowed).toBe(false);
  });
  it("blocks inline env-var prefix assignments", () => {
    expect(guardCommand("FOO=bar sudo x").allowed).toBe(false);
    expect(guardCommand("A=1 B=2 rm -rf /").allowed).toBe(false);
  });
});

describe("command-guard — shell features", () => {
  it("rejects operators / substitution / globs / backticks", () => {
    expect(guardCommand("ls | grep x").allowed).toBe(false);
    expect(guardCommand("a && b").allowed).toBe(false);
    expect(guardCommand("echo $(whoami)").allowed).toBe(false);
    expect(guardCommand("echo `whoami`").allowed).toBe(false);
    expect(guardCommand("echo hi > /etc/passwd").allowed).toBe(false);
    expect(guardCommand("rm *.tmp").allowed).toBe(false);
  });
});

describe("command-guard — recursive destruction", () => {
  it("rejects rm -rf on root / home / cwd / glob", () => {
    expect(guardCommand("rm -rf /").allowed).toBe(false);
    expect(guardCommand("rm -rf /*").allowed).toBe(false);
    expect(guardCommand("rm -fr /").allowed).toBe(false);
    expect(guardCommand("rm --recursive --force /").allowed).toBe(false);
    expect(guardCommand("rm -rf ./").allowed).toBe(false);
    expect(guardCommand("rm -rf ~").allowed).toBe(false);
  });
  it("rejects chmod/chown -R on root/home/cwd", () => {
    expect(guardCommand("chmod -R 777 /").allowed).toBe(false);
    expect(guardCommand("chown -R root ~").allowed).toBe(false);
  });
  it("rejects find -delete / -exec", () => {
    expect(guardCommand("find . -delete").allowed).toBe(false);
    expect(guardCommand("find . -exec rm {} ;").allowed).toBe(false);
  });
});
