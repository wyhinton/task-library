import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask, computeLabel } from './types';
import { dependencyLabels, parseTasksDocument, readFileText, upsertTaskInWorkspace } from './tasksJson';
import { preflightEnabled, preflightTask } from './preflight';
import { findPlaceholders, promptPlaceholders, substitutePlaceholders } from './placeholders';

export interface InsertOptions {
  silent?: boolean;
  /** Labels already being inserted in this batch — cycle guard for dependsOn recursion. */
  visited?: Set<string>;
}

/**
 * The full insert pipeline: fill {{placeholders}}, run preflight checks,
 * write into the folder's tasks.json, offer to bring dependsOn tasks along,
 * and record usage. Returns true if the file changed.
 */
export async function insertLibraryTask(
  folder: vscode.WorkspaceFolder,
  task: LibraryTask,
  library: TaskLibrary,
  options: InsertOptions = {}
): Promise<boolean> {
  const visited = options.visited ?? new Set<string>();
  visited.add(task.label);

  // 1. Template placeholders ({{NAME}} / {{NAME:default}}) — resolved at insert time.
  let working = task;
  const placeholders = findPlaceholders({ def: task.definition, inputs: task.inputs });
  if (placeholders.length) {
    const values = await promptPlaceholders(placeholders, task.label);
    if (!values) {
      return false;
    }
    const definition = substitutePlaceholders(task.definition, values);
    const inputs = task.inputs ? substitutePlaceholders(task.inputs, values) : undefined;
    working = { ...task, definition, inputs, label: computeLabel(definition) };
  }

  // 2. Preflight checks.
  const tasksJsonUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
  if (preflightEnabled()) {
    const targetText = await readFileText(tasksJsonUri);
    const issues = preflightTask(folder, working, targetText);
    if (issues.length) {
      const choice = await vscode.window.showWarningMessage(
        `Task Library: "${working.label}" may not work in ${folder.name}`,
        { modal: true, detail: issues.map((i) => `• ${i}`).join('\n') },
        'Insert Anyway'
      );
      if (choice !== 'Insert Anyway') {
        return false;
      }
    }
  }

  // 3. Write into tasks.json (comment-preserving; prompts on label collision).
  const changed = await upsertTaskInWorkspace(folder, working, { silent: options.silent });
  if (!changed) {
    return false;
  }
  library.recordUsage(task.id, 'insert');

  // 4. dependsOn awareness: offer to bring library dependencies, flag dangling ones.
  await handleDependencies(folder, working, library, visited);

  return true;
}

async function handleDependencies(
  folder: vscode.WorkspaceFolder,
  task: LibraryTask,
  library: TaskLibrary,
  visited: Set<string>
): Promise<void> {
  const labels = dependencyLabels(task.definition).filter((l) => !visited.has(l));
  if (!labels.length) {
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
  const text = (await readFileText(uri)) ?? '';
  const { tasks } = parseTasksDocument(text);
  const present = new Set(tasks.map((t) => computeLabel(t)));

  const missing = labels.filter((l) => !present.has(l));
  if (!missing.length) {
    return;
  }
  const inLibrary = missing
    .map((l) => library.findByLabel(l))
    .filter((t): t is LibraryTask => !!t);
  const dangling = missing.filter((l) => !library.findByLabel(l));

  if (inLibrary.length) {
    const names = inLibrary.map((t) => `"${t.label}"`).join(', ');
    const choice = await vscode.window.showInformationMessage(
      `"${task.label}" depends on ${inLibrary.length} task${inLibrary.length === 1 ? '' : 's'} not yet in ${folder.name}'s tasks.json: ${names}`,
      `Insert ${inLibrary.length === 1 ? 'Dependency' : 'Dependencies'}`
    );
    if (choice) {
      for (const dep of inLibrary) {
        await insertLibraryTask(folder, dep, library, { silent: true, visited });
      }
    }
  }
  if (dangling.length) {
    vscode.window.showWarningMessage(
      `Task Library: "${task.label}" depends on ${dangling.map((l) => `"${l}"`).join(', ')} — not found in the target tasks.json or your library.`
    );
  }
}

export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Task Library: open a folder before inserting tasks.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Add the task to which workspace folder?',
  });
}
