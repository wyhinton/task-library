import * as vscode from 'vscode';

/**
 * Template placeholders: `{{NAME}}` or `{{NAME:default}}` anywhere in a task
 * definition's string values. Unlike `${input:...}` (which VS Code prompts for
 * at *run* time), placeholders are filled in when the task is inserted into a
 * workspace or run from the library — the library keeps the template.
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::([^}]*))?\}\}/g;

export interface Placeholder {
  name: string;
  defaultValue?: string;
}

/** Find all distinct placeholders in a value's string leaves (first default wins). */
export function findPlaceholders(value: unknown): Placeholder[] {
  const found = new Map<string, Placeholder>();
  walkStrings(value, (s) => {
    for (const m of s.matchAll(PLACEHOLDER_RE)) {
      const existing = found.get(m[1]);
      if (!existing) {
        found.set(m[1], { name: m[1], defaultValue: m[2] });
      } else if (existing.defaultValue === undefined && m[2] !== undefined) {
        existing.defaultValue = m[2];
      }
    }
    return s;
  });
  return [...found.values()];
}

/**
 * Prompt for each placeholder value. Returns undefined if the user cancels.
 */
export async function promptPlaceholders(
  placeholders: Placeholder[],
  taskLabel: string
): Promise<Map<string, string> | undefined> {
  const values = new Map<string, string>();
  for (let i = 0; i < placeholders.length; i++) {
    const p = placeholders[i];
    const value = await vscode.window.showInputBox({
      title: `"${taskLabel}" — fill in placeholders (${i + 1}/${placeholders.length})`,
      prompt: `Value for {{${p.name}}}`,
      value: p.defaultValue ?? '',
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return undefined;
    }
    values.set(p.name, value);
  }
  return values;
}

/** Return a deep copy of `value` with all placeholders replaced. */
export function substitutePlaceholders<T>(value: T, values: Map<string, string>): T {
  return walkStrings(deepClone(value), (s) =>
    s.replace(PLACEHOLDER_RE, (whole, name: string, def: string | undefined) =>
      values.get(name) ?? def ?? whole
    )
  ) as T;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Apply `fn` to every string leaf, in place for objects/arrays; returns the (possibly new) value. */
function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') {
    return fn(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = walkStrings(value[i], fn);
    }
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = walkStrings(obj[key], fn);
    }
    return value;
  }
  return value;
}
