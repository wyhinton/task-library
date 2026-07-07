import * as vscode from 'vscode';
import * as path from 'path';
import { TaskLibrary } from './library';
import { LibraryTask } from './types';
import { findPlaceholders, promptPlaceholders, substitutePlaceholders } from './placeholders';

/**
 * Runs a library task directly — no round-trip through tasks.json.
 * Builds an ad-hoc vscode.Task for shell / process / npm definitions,
 * prompting for ${input:...} values (using the input definitions carried
 * with the task) and {{placeholders}}. Other task types fall back to a
 * matching workspace task, or an offer to insert first.
 */
export async function runLibraryTask(library: TaskLibrary, task: LibraryTask): Promise<void> {
  const folder = await pickFolderForRun();

  // 1. Fill template placeholders.
  const placeholders = findPlaceholders(task.definition);
  let def = deepClone(task.definition);
  if (placeholders.length) {
    const values = await promptPlaceholders(placeholders, task.label);
    if (!values) {
      return;
    }
    def = substitutePlaceholders(def, values);
  }

  // 2. Resolve ${input:...} references by prompting.
  const resolvedInputs = await resolveInputs(def, task.inputs ?? [], task.label);
  if (resolvedInputs === undefined) {
    return;
  }
  def = resolvedInputs;

  // 3. Merge platform-specific overrides (windows / linux / osx blocks).
  def = mergePlatformOverrides(def);

  // 4. Resolve the common ${...} variables VS Code would normally substitute.
  def = resolveVariables(def, folder);

  const type = typeof def.type === 'string' ? def.type : 'shell';
  const scope: vscode.WorkspaceFolder | vscode.TaskScope = folder ?? vscode.TaskScope.Workspace;
  let execution: vscode.ShellExecution | vscode.ProcessExecution | undefined;

  if (type === 'shell') {
    execution = buildShellExecution(def);
  } else if (type === 'process') {
    execution = buildProcessExecution(def);
  } else if (type === 'npm') {
    execution = buildNpmExecution(def, folder);
  }

  if (!execution) {
    await runViaWorkspace(task);
    return;
  }

  const vsTask = new vscode.Task(
    { type: 'tasksLibrary', libraryId: task.id },
    scope,
    task.label,
    'Task Library',
    execution,
    problemMatchers(def)
  );
  vsTask.presentationOptions = presentationOptions(def);

  try {
    await vscode.tasks.executeTask(vsTask);
    library.recordUsage(task.id, 'run');
  } catch (err) {
    vscode.window.showErrorMessage(`Task Library: could not run "${task.label}": ${String(err)}`);
  }
}

// --- executions ----------------------------------------------------------------

function buildShellExecution(def: Record<string, unknown>): vscode.ShellExecution | undefined {
  const command = commandString(def);
  if (!command) {
    return undefined;
  }
  const options = shellOptions(def);
  const args = argList(def);
  if (args.length) {
    return new vscode.ShellExecution(command, args, options);
  }
  return new vscode.ShellExecution(command, options);
}

function buildProcessExecution(def: Record<string, unknown>): vscode.ProcessExecution | undefined {
  const command = commandString(def);
  if (!command) {
    return undefined;
  }
  const args = argList(def).map((a) => (typeof a === 'string' ? a : a.value));
  return new vscode.ProcessExecution(command, args, processOptions(def));
}

function buildNpmExecution(
  def: Record<string, unknown>,
  folder: vscode.WorkspaceFolder | undefined
): vscode.ShellExecution | undefined {
  const script = def.script;
  if (typeof script !== 'string') {
    return undefined;
  }
  let cwd: string | undefined;
  if (typeof def.path === 'string' && folder) {
    cwd = path.join(folder.uri.fsPath, def.path);
  } else if (folder) {
    cwd = folder.uri.fsPath;
  }
  return new vscode.ShellExecution(`npm run ${script}`, cwd ? { cwd } : undefined);
}

/** For task types we can't build ad-hoc (gulp, custom providers, …). */
async function runViaWorkspace(task: LibraryTask): Promise<void> {
  const all = await vscode.tasks.fetchTasks();
  const match = all.find((t) => t.name === task.label);
  if (match) {
    await vscode.tasks.executeTask(match);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Task Library: tasks of type "${String(task.definition.type)}" can't be run directly from the library. Insert it into a workspace tasks.json first.`,
    'Insert into Workspace'
  );
  if (choice) {
    await vscode.commands.executeCommand('tasksLibrary.insertTask', task.id);
  }
}

// --- definition plumbing ---------------------------------------------------------

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
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

function argList(def: Record<string, unknown>): (string | vscode.ShellQuotedString)[] {
  if (!Array.isArray(def.args)) {
    return [];
  }
  const out: (string | vscode.ShellQuotedString)[] = [];
  for (const a of def.args) {
    if (typeof a === 'string') {
      out.push(a);
    } else if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).value === 'string') {
      const quoting =
        (a as Record<string, unknown>).quoting === 'strong'
          ? vscode.ShellQuoting.Strong
          : (a as Record<string, unknown>).quoting === 'weak'
            ? vscode.ShellQuoting.Weak
            : vscode.ShellQuoting.Escape;
      out.push({ value: (a as Record<string, string>).value, quoting });
    }
  }
  return out;
}

function taskOptions(def: Record<string, unknown>): Record<string, unknown> {
  return (def.options as Record<string, unknown> | undefined) ?? {};
}

function shellOptions(def: Record<string, unknown>): vscode.ShellExecutionOptions {
  const options = taskOptions(def);
  const out: vscode.ShellExecutionOptions = {};
  if (typeof options.cwd === 'string') {
    out.cwd = options.cwd;
  }
  if (options.env && typeof options.env === 'object') {
    out.env = options.env as Record<string, string>;
  }
  const shell = options.shell as Record<string, unknown> | undefined;
  if (shell && typeof shell.executable === 'string') {
    out.executable = shell.executable;
    if (Array.isArray(shell.args)) {
      out.shellArgs = shell.args.filter((a): a is string => typeof a === 'string');
    }
  }
  return out;
}

function processOptions(def: Record<string, unknown>): vscode.ProcessExecutionOptions {
  const options = taskOptions(def);
  const out: vscode.ProcessExecutionOptions = {};
  if (typeof options.cwd === 'string') {
    out.cwd = options.cwd;
  }
  if (options.env && typeof options.env === 'object') {
    out.env = options.env as Record<string, string>;
  }
  return out;
}

function problemMatchers(def: Record<string, unknown>): string[] {
  const pm = def.problemMatcher;
  if (typeof pm === 'string') {
    return [pm];
  }
  if (Array.isArray(pm)) {
    return pm.filter((m): m is string => typeof m === 'string');
  }
  return [];
}

function presentationOptions(def: Record<string, unknown>): vscode.TaskPresentationOptions {
  const p = (def.presentation ?? def.terminal) as Record<string, unknown> | undefined;
  const out: vscode.TaskPresentationOptions = {};
  if (!p || typeof p !== 'object') {
    return out;
  }
  if (p.reveal === 'always') {
    out.reveal = vscode.TaskRevealKind.Always;
  } else if (p.reveal === 'silent') {
    out.reveal = vscode.TaskRevealKind.Silent;
  } else if (p.reveal === 'never') {
    out.reveal = vscode.TaskRevealKind.Never;
  }
  if (typeof p.echo === 'boolean') {
    out.echo = p.echo;
  }
  if (typeof p.focus === 'boolean') {
    out.focus = p.focus;
  }
  if (typeof p.clear === 'boolean') {
    out.clear = p.clear;
  }
  if (p.panel === 'shared') {
    out.panel = vscode.TaskPanelKind.Shared;
  } else if (p.panel === 'dedicated') {
    out.panel = vscode.TaskPanelKind.Dedicated;
  } else if (p.panel === 'new') {
    out.panel = vscode.TaskPanelKind.New;
  }
  return out;
}

function mergePlatformOverrides(def: Record<string, unknown>): Record<string, unknown> {
  const key =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const override = def[key];
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    return { ...def, ...(override as Record<string, unknown>) };
  }
  return def;
}

// --- ${...} resolution -------------------------------------------------------------

/**
 * VS Code only substitutes ${...} variables for tasks defined in tasks.json,
 * not API-created ones, so resolve the common ones ourselves.
 */
function resolveVariables(
  def: Record<string, unknown>,
  folder: vscode.WorkspaceFolder | undefined
): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor;
  const file = editor?.document.uri.fsPath;
  const vars: Record<string, string | undefined> = {
    workspaceFolder: folder?.uri.fsPath,
    workspaceFolderBasename: folder ? path.basename(folder.uri.fsPath) : undefined,
    workspaceRoot: folder?.uri.fsPath,
    userHome: process.env.HOME ?? process.env.USERPROFILE,
    pathSeparator: path.sep,
    cwd: folder?.uri.fsPath,
    file,
    fileBasename: file ? path.basename(file) : undefined,
    fileDirname: file ? path.dirname(file) : undefined,
    fileExtname: file ? path.extname(file) : undefined,
    fileBasenameNoExtension: file
      ? path.basename(file, path.extname(file))
      : undefined,
    relativeFile:
      file && folder ? path.relative(folder.uri.fsPath, file) : undefined,
    lineNumber: editor ? String(editor.selection.active.line + 1) : undefined,
    selectedText: editor ? editor.document.getText(editor.selection) : undefined,
  };
  const text = JSON.stringify(def).replace(
    /\$\{([A-Za-z]+)\}/g,
    (whole, name: string) => {
      const value = vars[name];
      return value !== undefined ? escapeForJsonString(value) : whole;
    }
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function escapeForJsonString(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

// --- ${input:...} resolution --------------------------------------------------------

/**
 * Prompt for every ${input:id} the definition references, using the input
 * definitions the task carries. Returns undefined if the user cancels.
 */
async function resolveInputs(
  def: Record<string, unknown>,
  inputs: Record<string, unknown>[],
  taskLabel: string
): Promise<Record<string, unknown> | undefined> {
  const ids = new Set<string>();
  const re = /\$\{input:([^}]+)\}/g;
  let text = JSON.stringify(def);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ids.add(m[1]);
  }
  if (!ids.size) {
    return def;
  }
  for (const id of ids) {
    const inputDef = inputs.find((i) => i.id === id);
    const value = await promptForInput(id, inputDef, taskLabel);
    if (value === undefined) {
      return undefined;
    }
    text = text.split(`\${input:${id}}`).join(escapeForJsonString(value));
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function promptForInput(
  id: string,
  inputDef: Record<string, unknown> | undefined,
  taskLabel: string
): Promise<string | undefined> {
  const description =
    typeof inputDef?.description === 'string' ? inputDef.description : `Value for input "${id}"`;
  if (inputDef?.type === 'pickString' && Array.isArray(inputDef.options)) {
    const items = inputDef.options.map((o) => {
      if (typeof o === 'string') {
        return { label: o, value: o };
      }
      const obj = o as Record<string, unknown>;
      return {
        label: typeof obj.label === 'string' ? obj.label : String(obj.value),
        value: typeof obj.value === 'string' ? obj.value : String(obj.value),
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: `"${taskLabel}"`,
      placeHolder: description,
      ignoreFocusOut: true,
    });
    return picked?.value;
  }
  // promptString, command inputs (which we can't execute), or unknown → free text.
  return vscode.window.showInputBox({
    title: `"${taskLabel}"`,
    prompt: description,
    value: typeof inputDef?.default === 'string' ? inputDef.default : '',
    password: inputDef?.password === true,
    ignoreFocusOut: true,
  });
}

async function pickFolderForRun(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Run the task in which workspace folder?',
  });
}
