import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LibraryTask } from './types';
import { parseTasksDocument } from './tasksJson';

/**
 * "Works on my machine" checks run before a task is inserted into a
 * workspace: is the command on PATH, do ${workspaceFolder} paths exist,
 * does the cwd exist, do carried input ids collide with different ones
 * already in the target tasks.json?
 */

/** Shell builtins and common aliases we can't (and shouldn't) look up on PATH. */
const SHELL_BUILTINS = new Set([
  'cd', 'echo', 'set', 'exit', 'start', 'dir', 'type', 'copy', 'move', 'del',
  'source', 'export', 'alias', 'true', 'false', 'test', 'exec', 'eval',
]);

export function preflightEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('tasksLibrary')
    .get<boolean>('preflight.enabled', true);
}

export function preflightTask(
  folder: vscode.WorkspaceFolder,
  task: LibraryTask,
  targetTasksJsonText: string | undefined
): string[] {
  const issues: string[] = [];
  const def = task.definition;

  checkCommand(def, issues);
  checkWorkspacePaths(folder, def, issues);
  checkCwd(folder, def, issues);
  checkInputCollisions(task, targetTasksJsonText, issues);

  return issues;
}

function commandString(def: Record<string, unknown>): string | undefined {
  const cmd = def.command;
  if (typeof cmd === 'string') {
    return cmd;
  }
  if (cmd && typeof cmd === 'object' && typeof (cmd as Record<string, unknown>).value === 'string') {
    return (cmd as Record<string, string>).value;
  }
  return undefined;
}

function checkCommand(def: Record<string, unknown>, issues: string[]): void {
  if (def.type === 'npm') {
    return; // npm itself being present is a safe assumption in a JS workspace.
  }
  const cmd = commandString(def);
  if (!cmd) {
    return;
  }
  const first = cmd.trim().split(/\s+/)[0];
  if (
    !first ||
    first.includes('${') ||
    first.includes('/') ||
    first.includes('\\') ||
    first.startsWith('"') ||
    first.startsWith("'") ||
    SHELL_BUILTINS.has(first.toLowerCase())
  ) {
    return;
  }
  if (!commandOnPath(first)) {
    issues.push(`Command "${first}" was not found on PATH.`);
  }
}

function commandOnPath(cmd: string): boolean {
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, cmd + ext)) || fs.existsSync(path.join(dir, cmd))) {
          return true;
        }
      } catch {
        // Unreadable PATH entries don't count against the task.
      }
    }
  }
  return false;
}

function checkWorkspacePaths(
  folder: vscode.WorkspaceFolder,
  def: Record<string, unknown>,
  issues: string[]
): void {
  const text = JSON.stringify(def);
  const re = /\$\{workspaceFolder\}([^"\s,${}]*)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rel = m[1].replace(/\\\\/g, path.sep); // JSON-escaped backslashes
    if (!rel || rel === '/' || rel === '\\' || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const full = path.join(folder.uri.fsPath, rel);
    if (!fs.existsSync(full)) {
      issues.push(`Path \${workspaceFolder}${m[1]} does not exist in "${folder.name}".`);
    }
  }
}

function checkCwd(
  folder: vscode.WorkspaceFolder,
  def: Record<string, unknown>,
  issues: string[]
): void {
  const options = def.options as Record<string, unknown> | undefined;
  const cwd = options?.cwd;
  if (typeof cwd !== 'string' || !cwd) {
    return;
  }
  let resolved = cwd.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
  if (resolved.includes('${')) {
    return; // other variables we can't resolve statically
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.join(folder.uri.fsPath, resolved);
  }
  if (!fs.existsSync(resolved)) {
    issues.push(`Working directory "${cwd}" does not exist.`);
  }
}

function checkInputCollisions(
  task: LibraryTask,
  targetText: string | undefined,
  issues: string[]
): void {
  if (!task.inputs?.length || !targetText) {
    return;
  }
  const { json } = parseTasksDocument(targetText);
  const existing = Array.isArray(json?.inputs)
    ? (json!.inputs as Record<string, unknown>[])
    : [];
  for (const input of task.inputs) {
    const clash = existing.find((i) => i?.id === input.id);
    if (clash && JSON.stringify(clash) !== JSON.stringify(input)) {
      issues.push(
        `Input id "${String(input.id)}" already exists in the target tasks.json with a different definition (the existing one will be kept).`
      );
    }
  }
}
