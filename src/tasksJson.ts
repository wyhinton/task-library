import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { LibraryTask, computeLabel } from './types';

const EMPTY_TASKS_JSON = '{\n\t"version": "2.0.0",\n\t"tasks": []\n}\n';

const PARSE_OPTIONS: jsonc.ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
};

export async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Match the target file's existing indentation so edits blend in. */
export function detectFormatting(text: string): jsonc.FormattingOptions {
  if (/\n\t/.test(text)) {
    return { insertSpaces: false, tabSize: 4, eol: '\n' };
  }
  const m = /\n( +)\S/.exec(text);
  return { insertSpaces: true, tabSize: m ? m[1].length : 4, eol: '\n' };
}

/** Find the task object in a tasks.json document that contains the given offset. */
export function taskAtOffset(
  text: string,
  offset: number
): { def: Record<string, unknown>; index: number } | undefined {
  const root = jsonc.parseTree(text);
  if (!root) {
    return undefined;
  }
  const tasksNode = jsonc.findNodeAtLocation(root, ['tasks']);
  if (!tasksNode || tasksNode.type !== 'array' || !tasksNode.children) {
    return undefined;
  }
  for (let i = 0; i < tasksNode.children.length; i++) {
    const child = tasksNode.children[i];
    if (offset >= child.offset && offset <= child.offset + child.length) {
      return { def: jsonc.getNodeValue(child), index: i };
    }
  }
  return undefined;
}

/** Collect input definitions referenced by a task via ${input:...}. */
export function collectReferencedInputs(
  def: unknown,
  fileJson: unknown
): Record<string, unknown>[] {
  const ids = new Set<string>();
  const re = /\$\{input:([^}]+)\}/g;
  const text = JSON.stringify(def);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ids.add(m[1]);
  }
  const inputs = (fileJson as Record<string, unknown> | undefined)?.inputs;
  if (!ids.size || !Array.isArray(inputs)) {
    return [];
  }
  return inputs.filter(
    (i): i is Record<string, unknown> =>
      !!i && typeof i === 'object' && typeof (i as Record<string, unknown>).id === 'string' &&
      ids.has((i as Record<string, string>).id)
  );
}

export function parseTasksDocument(text: string): {
  json: Record<string, unknown> | undefined;
  tasks: unknown[];
} {
  const json = jsonc.parse(text, [], PARSE_OPTIONS) as Record<string, unknown> | undefined;
  const tasks = Array.isArray(json?.tasks) ? (json!.tasks as unknown[]) : [];
  return { json, tasks };
}

/** Labels this task depends on via `dependsOn` (string or string[] forms). */
export function dependencyLabels(def: unknown): string[] {
  const dep = (def as Record<string, unknown> | undefined)?.dependsOn;
  if (typeof dep === 'string') {
    return [dep];
  }
  if (Array.isArray(dep)) {
    return dep.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/** Append any of `inputs` whose ids aren't already present in the file's `inputs` array. */
export function mergeInputsIntoText(
  text: string,
  inputs: Record<string, unknown>[],
  fmt: jsonc.FormattingOptions
): string {
  for (const input of inputs) {
    const current = jsonc.parse(text, [], PARSE_OPTIONS) as Record<string, unknown>;
    const currentInputs = Array.isArray(current?.inputs)
      ? (current.inputs as Record<string, unknown>[])
      : [];
    if (currentInputs.some((i) => i?.id === input.id)) {
      continue;
    }
    const edits = jsonc.modify(text, ['inputs', currentInputs.length], input, {
      formattingOptions: fmt,
      isArrayInsertion: true,
    });
    text = jsonc.applyEdits(text, edits);
  }
  return text;
}

/**
 * Prompt-free bulk insert used by drag & drop: appends tasks whose labels
 * don't already appear in the file (existing labels are skipped, never
 * overwritten), merging referenced inputs. Pure text-in / text-out.
 */
export function addTasksToText(
  text: string,
  tasksToAdd: LibraryTask[]
): { text: string; added: string[]; skipped: string[] } {
  if (!text.trim()) {
    text = EMPTY_TASKS_JSON;
  }
  const fmt = detectFormatting(text);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const task of tasksToAdd) {
    const { json, tasks } = parseTasksDocument(text);
    if (!json || typeof json !== 'object') {
      skipped.push(task.label);
      continue;
    }
    if (tasks.some((t) => computeLabel(t) === task.label)) {
      skipped.push(task.label);
      continue;
    }
    const edits = jsonc.modify(text, ['tasks', tasks.length], task.definition, {
      formattingOptions: fmt,
      isArrayInsertion: true,
    });
    text = jsonc.applyEdits(text, edits);
    text = mergeInputsIntoText(text, task.inputs ?? [], fmt);
    added.push(task.label);
  }
  return { text, added, skipped };
}

/**
 * Insert (or overwrite) a library task in a folder's .vscode/tasks.json,
 * preserving comments and formatting. Also merges any ${input:...}
 * definitions the task depends on. Returns true if the file was changed.
 */
export async function upsertTaskInWorkspace(
  folder: vscode.WorkspaceFolder,
  task: LibraryTask,
  options: { silent?: boolean } = {}
): Promise<boolean> {
  const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString()
  );
  let text = openDoc ? openDoc.getText() : await readFileText(uri);
  if (text === undefined || !text.trim()) {
    text = EMPTY_TASKS_JSON;
  }

  const { json, tasks } = parseTasksDocument(text);
  if (!json || typeof json !== 'object') {
    vscode.window.showErrorMessage(
      `Task Library: could not parse ${folder.name}/.vscode/tasks.json.`
    );
    return false;
  }

  const fmt = detectFormatting(text);
  let def = task.definition;
  let index = tasks.length;
  let isInsertion = true;

  const existingIndex = tasks.findIndex((t) => computeLabel(t) === task.label);
  if (existingIndex !== -1) {
    if (JSON.stringify(tasks[existingIndex]) === JSON.stringify(def)) {
      if (!options.silent) {
        vscode.window.showInformationMessage(
          `Task "${task.label}" is already in ${folder.name}'s tasks.json.`
        );
      }
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `A task labeled "${task.label}" already exists in ${folder.name}/.vscode/tasks.json.`,
      { modal: true },
      'Overwrite',
      'Add as Copy'
    );
    if (!choice) {
      return false;
    }
    if (choice === 'Overwrite') {
      index = existingIndex;
      isInsertion = false;
    } else {
      def = { ...def, label: `${task.label} (copy)` };
    }
  }

  const edits = jsonc.modify(text, ['tasks', index], def, {
    formattingOptions: fmt,
    isArrayInsertion: isInsertion,
  });
  text = jsonc.applyEdits(text, edits);
  text = mergeInputsIntoText(text, task.inputs ?? [], fmt);

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
  if (openDoc) {
    // Route through a WorkspaceEdit so unsaved editor changes aren't clobbered on disk.
    const fullRange = new vscode.Range(
      openDoc.positionAt(0),
      openDoc.positionAt(openDoc.getText().length)
    );
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, fullRange, text);
    await vscode.workspace.applyEdit(we);
    await openDoc.save();
  } else {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  if (!options.silent) {
    await revealTaskInFile(uri, computeLabel(def));
  }
  return true;
}

/** Open a tasks.json and put the cursor on the task with the given label. */
export async function revealTaskInFile(uri: vscode.Uri, label: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const root = jsonc.parseTree(doc.getText());
  if (!root) {
    return;
  }
  const tasksNode = jsonc.findNodeAtLocation(root, ['tasks']);
  for (const child of tasksNode?.children ?? []) {
    if (computeLabel(jsonc.getNodeValue(child)) === label) {
      const pos = doc.positionAt(child.offset);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }
  }
}
