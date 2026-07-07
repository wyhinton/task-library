import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryNode, LibraryTreeController } from './tree';
import { TaskPreviewPanel } from './preview';
import {
  collectReferencedInputs,
  parseTasksDocument,
  taskAtOffset,
} from './tasksJson';
import { LibraryTask, SortMode, TASK_COLORS, computeLabel } from './types';
import { WorkspaceStatusTracker } from './workspaceStatus';
import { addDefinitionToLibrary } from './capture';
import { insertLibraryTask, pickWorkspaceFolder } from './insert';
import { runLibraryTask } from './runner';
import { quickOpenLibrary } from './quickOpen';
import { compareTaskWithWorkspace } from './diff';
import { generateFromProject } from './generate';
import { TerminalCommandTracker, addTaskFromTerminal } from './terminal';
import { exportTasks, importFromFile, importFromUrl } from './importExport';
import { mergeTaskInputsIntoDocument } from './languageFeatures';

interface Deps {
  library: TaskLibrary;
  tree: LibraryTreeController;
  workspaceStatus: WorkspaceStatusTracker;
  terminalTracker: TerminalCommandTracker;
}

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  const { library, tree, workspaceStatus, terminalTracker } = deps;

  const register = (id: string, fn: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // --- Library view -------------------------------------------------------

  register('tasksLibrary.refresh', () => tree.provider.refresh());

  register('tasksLibrary.filterByTag', async () => {
    const tags = library.allTags();
    if (!tags.size) {
      vscode.window.showInformationMessage('No tags yet. Add tags to tasks via right-click → Set Tags.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...tags.entries()].map(([tag, count]) => ({
        label: `#${tag}`,
        description: `${count} task${count === 1 ? '' : 's'}`,
        tag,
      })),
      { placeHolder: 'Show only tasks with tag…' }
    );
    if (picked) {
      tree.setTagFilter(picked.tag);
    }
  });

  register('tasksLibrary.clearTagFilter', () => tree.setTagFilter(undefined));

  register('tasksLibrary.search', () => {
    const input = vscode.window.createInputBox();
    input.placeholder = 'Search tasks by label, group, tag, or command…';
    input.value = tree.provider.searchQuery ?? '';
    input.onDidChangeValue((value) => tree.setSearchQuery(value || undefined));
    input.onDidHide(() => input.dispose());
    input.show();
  });

  register('tasksLibrary.clearSearch', () => tree.setSearchQuery(undefined));

  register('tasksLibrary.openLibraryFile', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(library.filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  register('tasksLibrary.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'tasksLibrary')
  );

  register('tasksLibrary.setSortOrder', async () => {
    const current = vscode.workspace
      .getConfiguration('tasksLibrary')
      .get<SortMode>('sortBy', 'name');
    const modes: { label: string; mode: SortMode }[] = [
      { label: '$(case-sensitive) Name', mode: 'name' },
      { label: '$(history) Recently used', mode: 'recentlyUsed' },
      { label: '$(flame) Most used', mode: 'mostUsed' },
      { label: '$(calendar) Recently added', mode: 'recentlyAdded' },
    ];
    const picked = await vscode.window.showQuickPick(
      modes.map((m) => ({ ...m, description: m.mode === current ? 'current' : undefined })),
      { placeHolder: 'Sort library tasks by…' }
    );
    if (picked) {
      await vscode.workspace
        .getConfiguration('tasksLibrary')
        .update('sortBy', picked.mode, vscode.ConfigurationTarget.Global);
    }
  });

  register('tasksLibrary.restoreSnapshot', async () => {
    const sources = library.sourceInfos;
    let sourceIndex = 0;
    if (sources.length > 1) {
      const picked = await vscode.window.showQuickPick(
        sources.map((s) => ({ label: s.name, description: s.path, index: s.index })),
        { placeHolder: 'Restore a snapshot of which library file?' }
      );
      if (!picked) {
        return;
      }
      sourceIndex = picked.index;
    }
    const snapshots = library.listSnapshots(sourceIndex);
    if (!snapshots.length) {
      vscode.window.showInformationMessage(
        'Task Library: no snapshots yet. Safety copies are taken automatically before library writes.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      snapshots.map((s) => ({
        label: s.time.toLocaleString(),
        description: `${s.taskCount} task${s.taskCount === 1 ? '' : 's'}`,
        snapshot: s,
      })),
      { placeHolder: 'Restore the library file to which snapshot?' }
    );
    if (!picked) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Replace the current library file with the snapshot from ${picked.label} (${picked.description})? The current state is snapshotted first.`,
      { modal: true },
      'Restore'
    );
    if (confirm === 'Restore') {
      library.restoreSnapshot(sourceIndex, picked.snapshot.file);
      vscode.window.showInformationMessage('Task Library: snapshot restored.');
    }
  });

  // --- Capturing tasks into the library ------------------------------------

  register('tasksLibrary.addFromEditor', async (uriArg?: unknown, offsetArg?: unknown) => {
    let uri = uriArg instanceof vscode.Uri ? uriArg : undefined;
    let offset = typeof offsetArg === 'number' ? offsetArg : undefined;
    if (!uri) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      uri = editor.document.uri;
      offset = editor.document.offsetAt(editor.selection.active);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const found = taskAtOffset(text, offset ?? 0);
    if (!found) {
      vscode.window.showWarningMessage(
        'Task Library: put the cursor inside a task in the "tasks" array first.'
      );
      return;
    }
    const { json } = parseTasksDocument(text);
    const inputs = collectReferencedInputs(found.def, json);
    await addDefinitionToLibrary(library, found.def, inputs, { interactive: true });
  });

  register('tasksLibrary.addAllFromEditor', async (uriArg?: unknown) => {
    const uri = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const { json, tasks } = parseTasksDocument(doc.getText());
    if (!tasks.length) {
      vscode.window.showInformationMessage('Task Library: no tasks found in this file.');
      return;
    }
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const def of tasks) {
      const result = await addDefinitionToLibrary(
        library,
        def as Record<string, unknown>,
        collectReferencedInputs(def, json),
        { interactive: false }
      );
      if (result === 'added') {
        added++;
      } else if (result === 'updated') {
        updated++;
      } else {
        unchanged++;
      }
    }
    vscode.window.showInformationMessage(
      `Task Library: ${added} added, ${updated} updated, ${unchanged} unchanged.`
    );
  });

  register('tasksLibrary.importFromWorkspace', async () => {
    const files = await vscode.workspace.findFiles('**/.vscode/tasks.json', '**/node_modules/**');
    if (!files.length) {
      vscode.window.showInformationMessage(
        'Task Library: no .vscode/tasks.json files found in this workspace.'
      );
      return;
    }
    interface Pick extends vscode.QuickPickItem {
      def: Record<string, unknown>;
      inputs: Record<string, unknown>[];
    }
    const items: Pick[] = [];
    for (const file of files) {
      const doc = await vscode.workspace.openTextDocument(file);
      const { json, tasks } = parseTasksDocument(doc.getText());
      for (const def of tasks) {
        const d = def as Record<string, unknown>;
        items.push({
          label: computeLabel(d),
          description: typeof d.type === 'string' ? d.type : undefined,
          detail: vscode.workspace.asRelativePath(file),
          picked: !library.findByLabel(computeLabel(d)),
          def: d,
          inputs: collectReferencedInputs(d, json),
        });
      }
    }
    if (!items.length) {
      vscode.window.showInformationMessage('Task Library: the workspace tasks.json files contain no tasks.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select tasks to add to your library',
    });
    if (!picked?.length) {
      return;
    }
    let added = 0;
    let updated = 0;
    for (const item of picked) {
      const result = await addDefinitionToLibrary(library, item.def, item.inputs, {
        interactive: false,
      });
      if (result === 'added') {
        added++;
      } else if (result === 'updated') {
        updated++;
      }
    }
    vscode.window.showInformationMessage(`Task Library: ${added} added, ${updated} updated.`);
  });

  register('tasksLibrary.generateFromProject', () => generateFromProject(library));

  register('tasksLibrary.addFromTerminal', () => addTaskFromTerminal(terminalTracker, library));

  // --- Sharing ----------------------------------------------------------------

  register('tasksLibrary.importFromUrl', () => importFromUrl(library));
  register('tasksLibrary.importFromFile', () => importFromFile(library));
  register('tasksLibrary.exportTasks', async (arg?: unknown, multi?: unknown) => {
    const selected = resolveTasks(library, arg, multi);
    await exportTasks(library, selected.length ? selected : undefined);
  });

  // --- Using library tasks --------------------------------------------------

  register('tasksLibrary.runTask', async (arg?: unknown) => {
    const task = resolveTask(library, arg) ?? (await quickPickTask(library));
    if (task) {
      await runLibraryTask(library, task);
    }
  });

  register('tasksLibrary.quickOpen', () => quickOpenLibrary(library));

  register('tasksLibrary.insertTask', async (arg?: unknown, multi?: unknown) => {
    let tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      const picked = await quickPickTask(library);
      if (!picked) {
        return;
      }
      tasks = [picked];
    }
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      return;
    }
    let changed = 0;
    for (const task of tasks) {
      if (await insertLibraryTask(folder, task, library, { silent: tasks.length > 1 })) {
        changed++;
      }
    }
    if (changed) {
      await workspaceStatus.refresh();
      vscode.window.showInformationMessage(
        tasks.length === 1
          ? `Task Library: added "${tasks[0].label}" to ${folder.name}/.vscode/tasks.json.`
          : `Task Library: added ${changed} of ${tasks.length} tasks to ${folder.name}/.vscode/tasks.json.`
      );
    }
  });

  register('tasksLibrary.insertGroup', async (arg?: unknown) => {
    const node = arg as LibraryNode | undefined;
    if (node?.kind !== 'group') {
      return;
    }
    const tasks = library.all().filter((t) => t.group === node.name);
    const folder = await pickWorkspaceFolder();
    if (!folder || !tasks.length) {
      return;
    }
    let changed = 0;
    for (const task of tasks) {
      if (await insertLibraryTask(folder, task, library, { silent: true })) {
        changed++;
      }
    }
    if (changed) {
      await workspaceStatus.refresh();
    }
    vscode.window.showInformationMessage(
      `Task Library: added ${changed} task${changed === 1 ? '' : 's'} from "${node.name}" to ${folder.name}/.vscode/tasks.json.`
    );
  });

  register('tasksLibrary.previewTask', async (arg?: unknown) => {
    const task = resolveTask(library, arg) ?? (await quickPickTask(library));
    if (task) {
      TaskPreviewPanel.show(task, workspaceStatus, library);
    }
  });

  register('tasksLibrary.compareWithWorkspace', async (arg?: unknown, uriArg?: unknown) => {
    const task = resolveTask(library, arg) ?? (await quickPickTask(library));
    if (!task) {
      return;
    }
    const uri =
      uriArg instanceof vscode.Uri
        ? uriArg
        : typeof uriArg === 'string'
          ? vscode.Uri.parse(uriArg)
          : undefined;
    await compareTaskWithWorkspace(task, uri);
  });

  register('tasksLibrary.copyTaskJson', async (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      return;
    }
    const payload =
      tasks.length === 1
        ? JSON.stringify(tasks[0].definition, null, 2)
        : JSON.stringify(tasks.map((t) => t.definition), null, 2);
    await vscode.env.clipboard.writeText(payload);
    vscode.window.showInformationMessage(
      tasks.length === 1
        ? `Copied "${tasks[0].label}" JSON to clipboard.`
        : `Copied ${tasks.length} task definitions to clipboard.`
    );
  });

  register('tasksLibrary.deleteTask', async (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      return;
    }
    const what =
      tasks.length === 1 ? `"${tasks[0].label}"` : `${tasks.length} tasks`;
    const choice = await vscode.window.showWarningMessage(
      `Remove ${what} from the task library?`,
      { modal: true },
      'Remove'
    );
    if (choice === 'Remove') {
      library.removeMany(tasks.map((t) => t.id));
    }
  });

  register('tasksLibrary.pinTask', (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    library.setPinned(tasks.map((t) => t.id), true);
  });

  register('tasksLibrary.unpinTask', (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    library.setPinned(tasks.map((t) => t.id), false);
  });

  // --- Metadata editing -------------------------------------------------------

  register('tasksLibrary.editGroup', async (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      return;
    }
    const what = tasks.length === 1 ? `"${tasks[0].label}"` : `${tasks.length} tasks`;
    const NEW_GROUP = '$(add) New group…';
    const NO_GROUP = '$(clear-all) No group';
    const picked = await vscode.window.showQuickPick(
      [...library.groups().map((g) => `$(folder) ${g}`), NEW_GROUP, NO_GROUP],
      { placeHolder: `Group for ${what}` }
    );
    if (!picked) {
      return;
    }
    let group: string | undefined;
    if (picked === NEW_GROUP) {
      group = await vscode.window.showInputBox({ prompt: 'New group name' });
      if (!group) {
        return;
      }
    } else if (picked !== NO_GROUP) {
      group = picked.replace('$(folder) ', '');
    }
    for (const task of tasks) {
      library.update(task.id, { group });
    }
  });

  register('tasksLibrary.editTags', async (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      return;
    }
    const what = tasks.length === 1 ? `"${tasks[0].label}"` : `${tasks.length} tasks`;
    const value = await vscode.window.showInputBox({
      prompt: `Tags for ${what} (comma-separated)`,
      value: (tasks[0].tags ?? []).join(', '),
    });
    if (value === undefined) {
      return;
    }
    const tags = value
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
    for (const task of tasks) {
      library.update(task.id, { tags });
    }
  });

  register('tasksLibrary.editColor', async (arg?: unknown, multi?: unknown) => {
    const tasks = resolveTasks(library, arg, multi);
    if (!tasks.length) {
      return;
    }
    const what = tasks.length === 1 ? `"${tasks[0].label}"` : `${tasks.length} tasks`;
    const picked = await vscode.window.showQuickPick(
      TASK_COLORS.map((c) => ({
        label: c.id ? `$(circle-filled) ${c.label}` : `$(circle-outline) ${c.label}`,
        description:
          tasks.length === 1 && tasks[0].color === c.id && (c.id || !tasks[0].color)
            ? 'current'
            : undefined,
        colorId: c.id,
      })),
      { placeHolder: `Color for ${what}` }
    );
    if (picked) {
      for (const task of tasks) {
        library.update(task.id, { color: picked.colorId });
      }
    }
  });

  register('tasksLibrary.editDescription', async (arg?: unknown) => {
    const task = resolveTask(library, arg);
    if (!task) {
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: `Description for "${task.label}"`,
      value: task.description ?? '',
    });
    if (value !== undefined) {
      library.update(task.id, { description: value || undefined });
    }
  });

  register('tasksLibrary.renameGroup', async (arg?: unknown) => {
    const node = arg as LibraryNode | undefined;
    if (node?.kind !== 'group') {
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: 'Rename group (leave empty to ungroup its tasks)',
      value: node.name,
    });
    if (value === undefined) {
      return;
    }
    library.renameGroup(node.name, value.trim());
  });

  // --- Internal ------------------------------------------------------------------

  register('tasksLibrary._mergeTaskInputs', async (uriArg?: unknown, idArg?: unknown) => {
    if (uriArg instanceof vscode.Uri && typeof idArg === 'string') {
      await mergeTaskInputsIntoDocument(library, uriArg, idArg);
    }
  });
}

// --- helpers ------------------------------------------------------------------

function resolveTask(library: TaskLibrary, arg: unknown): LibraryTask | undefined {
  if (typeof arg === 'string') {
    return library.byId(arg);
  }
  const node = arg as LibraryNode | undefined;
  if (node?.kind === 'task') {
    // Re-resolve by id so we always act on the latest saved state.
    return library.byId(node.task.id) ?? node.task;
  }
  return undefined;
}

/**
 * Resolve a context-menu invocation that may carry a multi-selection:
 * VS Code passes (clickedNode, selectedNodes[]) for view/item/context commands.
 */
function resolveTasks(library: TaskLibrary, arg: unknown, multi: unknown): LibraryTask[] {
  const nodes = Array.isArray(multi) && multi.length ? multi : [arg];
  const tasks: LibraryTask[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const task = resolveTask(library, node);
    if (task && !seen.has(task.id)) {
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return tasks;
}

async function quickPickTask(library: TaskLibrary): Promise<LibraryTask | undefined> {
  const tasks = library.all();
  if (!tasks.length) {
    vscode.window.showInformationMessage('The task library is empty.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    tasks
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((task) => ({
        label: task.label,
        description: (task.tags ?? []).map((t) => `#${t}`).join(' '),
        detail: task.group,
        task,
      })),
    { placeHolder: 'Select a task from the library', matchOnDescription: true, matchOnDetail: true }
  );
  return picked?.task;
}
