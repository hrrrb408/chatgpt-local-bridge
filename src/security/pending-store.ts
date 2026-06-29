import { nanoid } from "nanoid";
import type { ToolResult } from "../tools/registry.js";

export interface PendingAction {
  token: string;
  summary: string;
  execute: () => Promise<ToolResult>;
  createdAt: number;
  ttlMs: number;
  timer: NodeJS.Timeout;
}

/**
 * Per-session store for Layer-3 pending confirmations. A destructive tool that can't use elicitation
 * stashes its operation behind a single-use token; confirm_action(token) consumes it and runs the
 * captured `execute` closure. Constructed once per session (see server.ts makeServer) so tokens are
 * inherently session-scoped and die with the session — no cross-session consumption, no process-wide
 * singleton leak. Each entry also self-expires via setTimeout, and a periodic sweep is a backstop.
 */
export class PendingStore {
  private store = new Map<string, PendingAction>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
    this.sweeper = setInterval(() => this.sweep(), Math.max(ttlMs, 60_000));
    // Don't keep the event loop alive solely for expiry sweeps.
    this.sweeper.unref();
  }

  create(summary: string, execute: () => Promise<ToolResult>): string {
    const token = nanoid();
    const timer = setTimeout(() => this.remove(token), this.ttlMs);
    timer.unref();
    this.store.set(token, { token, summary, execute, createdAt: Date.now(), ttlMs: this.ttlMs, timer });
    return token;
  }

  private fresh(token: string): PendingAction | null {
    const entry = this.store.get(token);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.remove(token);
      return null;
    }
    return entry;
  }

  has(token: string): boolean {
    return this.fresh(token) !== null;
  }

  /** Remove and return a live pending action (single-use). */
  consume(token: string): PendingAction | null {
    const entry = this.fresh(token);
    if (entry) this.remove(token);
    return entry;
  }

  private remove(token: string): void {
    const entry = this.store.get(token);
    if (entry) clearTimeout(entry.timer);
    this.store.delete(token);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.store) {
      if (now - entry.createdAt > entry.ttlMs) this.remove(token);
    }
  }

  /** Called when the owning session closes — clears the sweeper and all pending entries. */
  dispose(): void {
    clearInterval(this.sweeper);
    for (const token of [...this.store.keys()]) this.remove(token);
  }
}
