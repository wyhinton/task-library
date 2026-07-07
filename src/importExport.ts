import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { TaskLibrary } from './library';
import { LibraryFile, LibraryTask, computeLabel } from './types';
import { collectReferencedInputs } from './tasksJson';

/**
 * Sharing without infrastructure: export a subset of the library to a JSON
 * file or the clipboard; import from a saved file, a raw URL, or a GitHub
 * gist. Imports understand every format we produce plus plain tasks.json.
 */

interface ImportedTask {
  def: Record<string, unknown>;
  inputs?: Record<string, unknown>[];
  meta?: Pick<Partial<LibraryTask>, 'group' | 'tags' | 'color' | 'description'>;
}

// --- export ------------------------------------------------------------------

export async function exportTasks(
  library: TaskLibrary,
  preselected?: LibraryTask[]
): Promise<void> {
  let tasks = preselected;
  if (!tasks?.length) {
    const all = library.all();
    if (!all.length) {
      vscode.window.showInformationMessage('The task library is empty.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      all
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((task) => ({
          label: task.label,
          description: (task.tags ?? []).map((t) => `#${t}`).join(' '),
          detail: task.group,
          picked: true,
          task,
        })),
      { canPickMany: true, placeHolder: 'Select tasks to export' }
    );
    if (!picked?.length) {
      return;
    }
    tasks = picked.map((p) => p.task);
  }

  // Strip personal state (pins, usage counters); keep shareable metadata.
  const exported: LibraryFile = {
    version: 1,
    tasks: tasks.map((t) => ({
      id: t.id,
      label: t.label,
      definition: t.definition,
      inputs: t.inputs,
      group: t.group,
      tags: t.tags,
      color: t.color,
      description: t.description,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  };
  const json = JSON.stringify(exported, null, 2) + '\n';

  const dest = await vscode.window.showQuickPick(
    [
      { label: '$(save) Save to file…', dest: 'file' as const },
      { label: '$(clippy) Copy to clipboard', dest: 'clipboard' as const },
    ],
    { placeHolder: `Export ${tasks.length} task${tasks.length === 1 ? '' : 's'} to…` }
  );
  if (!dest) {
    return;
  }
  if (dest.dest === 'clipboard') {
    await vscode.env.clipboard.writeText(json);
    vscode.window.showInformationMessage(
      `Task Library: copied ${tasks.length} task${tasks.length === 1 ? '' : 's'} to the clipboard.`
    );
    return;
  }
  const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${defaultDir}/task-library-export.json`),
    filters: { JSON: ['json'] },
  });
  if (!target) {
    return;
  }
  fs.writeFileSync(target.fsPath, json, 'utf8');
  vscode.window.showInformationMessage(
    `Task Library: exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${target.fsPath}.`
  );
}

// --- import ------------------------------------------------------------------

export async function importFromUrl(library: TaskLibrary): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: 'Task Library: Import from URL',
    prompt: 'URL of a task-library JSON export, a tasks.json, or a GitHub gist',
    placeHolder: 'https://gist.github.com/… or https://raw.githubusercontent.com/…/tasks.json',
    ignoreFocusOut: true,
  });
  if (!url?.trim()) {
    return;
  }
  let text: string;
  try {
    text = await fetchText(url.trim());
  } catch (err) {
    vscode.window.showErrorMessage(`Task Library: could not fetch ${url}: ${String(err)}`);
    return;
  }
  await importFromText(library, text, url.trim());
}

export async function importFromFile(library: TaskLibrary): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { JSON: ['json'] },
    title: 'Import tasks from a JSON file',
  });
  if (!picked?.length) {
    return;
  }
  const text = fs.readFileSync(picked[0].fsPath, 'utf8');
  await importFromText(library, text, picked[0].fsPath);
}

async function fetchText(url: string): Promise<string> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!fetchFn) {
    throw new Error('this VS Code version has no fetch support');
  }
  const gist = /gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]{8,})/.exec(url);
  if (gist) {
    const res = await fetchFn(`https://api.github.com/gists/${gist[1]}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      throw new Error(`gist API returned ${res.status}`);
    }
    const data = (await res.json()) as {
      files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
    };
    for (const file of Object.values(data.files ?? {})) {
      if (file.truncated && file.raw_url) {
        const raw = await fetchFn(file.raw_url);
        return raw.text();
      }
      if (file.content && looksLikeTasks(file.content)) {
        return file.content;
      }
    }
    const first = Object.values(data.files ?? {})[0];
    if (first?.content) {
      return first.content;
    }
    throw new Error('gist has no usable files');
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`server returned ${res.status}`);
  }
  return res.text();
}

function looksLikeTasks(text: string): boolean {
  try {
    return normalizeImport(JSON.parse(text)).length > 0;
  } catch {
    return false;
  }
}

async function importFromText(
  library: TaskLibrary,
  text: string,
  sourceDesc: string
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    vscode.window.showErrorMessage(`Task Library: ${sourceDesc} is not valid JSON.`);
    return;
  }
  const candidates = normalizeImport(json);
  if (!candidates.length) {
    vscode.window.showErrorMessage(
      `Task Library: no tasks found in ${sourceDesc} (expected a library export, a tasks.json, or an array of task definitions).`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: computeLabel(c.def),
      description: typeof c.def.type === 'string' ? c.def.type : undefined,
      detail: c.meta?.description,
      picked: true,
      candidate: c,
    })),
    { canPickMany: true, placeHolder: `Import which tasks from ${sourceDesc}?` }
  );
  if (!picked?.length) {
    return;
  }

  // Decide once what to do with label collisions.
  const collisions = picked.filter((p) => {
    const existing = library.findByLabel(p.label);
    return existing && JSON.stringify(existing.definition) !== JSON.stringify(p.candidate.def);
  });
  let overwrite = true;
  if (collisions.length) {
    const choice = await vscode.window.showWarningMessage(
      `${collisions.length} imported task${collisions.length === 1 ? '' : 's'} already exist${collisions.length === 1 ? 's' : ''} in the library with a different definition.`,
      { modal: true },
      'Overwrite Existing',
      'Skip Existing'
    );
    if (!choice) {
      return;
    }
    overwrite = choice === 'Overwrite Existing';
  }

  library.snapshotNow(0); // safety copy before a bulk write

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const p of picked) {
    const existing = library.findByLabel(p.label);
    if (existing) {
      if (JSON.stringify(existing.definition) === JSON.stringify(p.candidate.def)) {
        skipped++;
        continue;
      }
      if (!overwrite) {
        skipped++;
        continue;
      }
      library.update(existing.id, {
        definition: p.candidate.def,
        inputs: p.candidate.inputs?.length ? p.candidate.inputs : undefined,
        ...p.candidate.meta,
      });
      updated++;
      continue;
    }
    library.upsert({
      id: library.newId(),
      label: p.label,
      definition: p.candidate.def,
      inputs: p.candidate.inputs?.length ? p.candidate.inputs : undefined,
      tags: [],
      ...p.candidate.meta,
      createdAt: now,
      updatedAt: now,
    });
    added++;
  }
  vscode.window.showInformationMessage(
    `Task Library: imported ${added} new, updated ${updated}, skipped ${skipped}.`
  );
}

/** Accepts a library export, an array of LibraryTasks, a tasks.json, or a bare array of definitions. */
function normalizeImport(json: unknown): ImportedTask[] {
  if (!json || typeof json !== 'object') {
    return [];
  }
  const obj = json as Record<string, unknown>;

  const fromLibraryTasks = (arr: unknown[]): ImportedTask[] =>
    arr
      .filter(
        (t): t is Record<string, unknown> =>
          !!t && typeof t === 'object' && !!(t as Record<string, unknown>).definition
      )
      .map((t) => {
        const meta: ImportedTask['meta'] = {};
        if (typeof t.group === 'string') {
          meta.group = t.group;
        }
        if (Array.isArray(t.tags)) {
          meta.tags = (t.tags as unknown[]).filter((x): x is string => typeof x === 'string');
        }
        if (typeof t.color === 'string') {
          meta.color = t.color;
        }
        if (typeof t.description === 'string') {
          meta.description = t.description;
        }
        return {
          def: t.definition as Record<string, unknown>,
          inputs: Array.isArray(t.inputs) ? (t.inputs as Record<string, unknown>[]) : undefined,
          meta,
        };
      });

  const fromDefs = (arr: unknown[], fileJson: unknown): ImportedTask[] =>
    arr
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .map((def) => ({ def, inputs: collectReferencedInputs(def, fileJson) }));

  if (Array.isArray(json)) {
    const asLibrary = fromLibraryTasks(json);
    return asLibrary.length ? asLibrary : fromDefs(json, undefined);
  }
  if (Array.isArray(obj.tasks)) {
    const asLibrary = fromLibraryTasks(obj.tasks);
    return asLibrary.length ? asLibrary : fromDefs(obj.tasks, obj);
  }
  return [];
}
