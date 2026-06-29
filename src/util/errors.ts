/**
 * Helpers for building MCP CallToolResult objects consistently.
 * Business / security errors are returned with isError:true (never thrown out of a handler).
 */

export type TextContent = { type: "text"; text: string };

export function textResult(text: string): { content: TextContent[]; isError?: false } {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): { content: TextContent[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap an async op; on BridgeError/thrown, return errorResult instead of throwing. */
export async function safe<T extends { content: TextContent[]; isError?: boolean }>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message) as T;
  }
}
