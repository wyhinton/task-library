import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask, computeLabel } from './types';
import { parseTasksDocument, readFileText } from './tasksJson';

export const DIFF_SCHEME = 'taskslib-diff';

/**
 * Serves both sides of a "library ↔ workspace" comparison as read-only
 * virtual documents, so drift can be inspected in a real diff editor before
 * overwriting either side.
 */
export class TaskDiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly library: TaskLibrary) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    if (uri.path.startsWith('/library/')) {
      const task = this.library.byId(params.get('id') ?? '');
      return task
        ? JSON.stringify(task.definition, null, 2) + '\n'
        : '// Task no longer in the library\n';
    }
    const file = params.get('file');
    const label = params.get('label');
    if (!file || !label) {
      return '// Invalid diff reference\n';
    }
    const text = await readFileText(vscode.Uri.file(file));
    if (text === undefined) {
      return '// tasks.json not found\n';
    }
    const { tasks } = parseTasksDocument(text);
    const def = tasks.find((t) => computeLabel(t) === label);
    return def
      ? JSON.stringify(def, null, 2) + '\n'
      : `// No task labeled "${label}" in this tasks.json\n`;
  }
}

/**
 * Open a diff between a library task and its counterpart in a workspace
 * tasks.json. `tasksJsonUri` (from the code lens) pins the workspace side;
 * otherwise every workspace folder is scanned and the user picks if several
 * contain the label.
 */
export async function compareTaskWithWorkspace(
  task: LibraryTask,
  tasksJsonUri?: vscode.Uri
): Promise<void> {
  let file: string | undefined = tasksJsonUri?.fsPath;

  if (!file) {
    const candidates: { name: string; fsPath: string }[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
      const text = await readFileText(uri);
      if (!text) {
        continue;
      }
      const { tasks } = parseTasksDocument(text);
      if (tasks.some((t) => computeLabel(t) === task.label)) {
        candidates.push({ name: folder.name, fsPath: uri.fsPath });
      }
    }
    if (!candidates.length) {
      vscode.window.showInformationMessage(
        `Task Library: "${task.label}" is not in any open workspace's tasks.json.`
      );
      return;
    }
    if (candidates.length === 1) {
      file = candidates[0].fsPath;
    } else {
      const picked = await vscode.window.showQuickPick(
        candidates.map((c) => ({ label: c.name, description: c.fsPath, fsPath: c.fsPath })),
        { placeHolder: 'Compare against which workspace folder?' }
      );
      if (!picked) {
        return;
      }
      file = picked.fsPath;
    }
  }

  const fileName = encodeURIComponent(`${task.label}.json`);
  const workspaceSide = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/workspace/${fileName}`,
    query: `file=${encodeURIComponent(file)}&label=${encodeURIComponent(task.label)}`,
  });
  const librarySide = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/library/${fileName}`,
    query: `id=${encodeURIComponent(task.id)}`,
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    workspaceSide,
    librarySide,
    `${task.label} (workspace ↔ library)`
  );
}
