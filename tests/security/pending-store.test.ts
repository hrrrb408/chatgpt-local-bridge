import { describe, it, expect } from "vitest";
import { PendingStore } from "../../src/security/pending-store.js";
import type { ToolResult } from "../../src/tools/registry.js";

describe("PendingStore", () => {
  it("create + consume is single-use", async () => {
    const store = new PendingStore();
    let ran = 0;
    const ok: ToolResult = { content: [{ type: "text", text: "done" }] };
    const token = store.create("test op", async () => {
      ran++;
      return ok;
    });
    expect(store.has(token)).toBe(true);
    const entry = store.consume(token);
    expect(entry).not.toBeNull();
    expect(await entry!.execute()).toBe(ok);
    expect(ran).toBe(1);
    expect(store.consume(token)).toBeNull(); // single-use
    expect(store.has(token)).toBe(false);
    store.dispose();
  });

  it("unknown token is null", () => {
    const store = new PendingStore();
    expect(store.consume("does-not-exist")).toBeNull();
    expect(store.has("does-not-exist")).toBe(false);
    store.dispose();
  });

  it("dispose clears entries", () => {
    const store = new PendingStore(10_000);
    const t = store.create("op", async () => ({ content: [{ type: "text", text: "x" }] }));
    expect(store.has(t)).toBe(true);
    store.dispose();
    expect(store.has(t)).toBe(false);
  });
});
