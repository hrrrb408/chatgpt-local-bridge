/** Permission levels (see docs/00-requirements.md §4.2 / docs/02-detailed-design.md §2.2). */
export const LEVEL_READONLY = 0 as const;
export const LEVEL_EDIT = 1 as const;
export const LEVEL_FULL = 2 as const;

export type Level = 0 | 1 | 2;

export function levelName(level: number): string {
  return ["read-only", "edit", "full"][level] ?? `level-${level}`;
}

/** Does the configured level permit a tool that requires `required`? */
export function levelAllows(configured: number, required: number): boolean {
  return configured >= required;
}
