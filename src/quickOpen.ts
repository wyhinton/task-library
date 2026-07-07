import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask } from './types';
import { runLibraryTask } from './runner';

interface LaunchItem extends vscode.QuickPickItem {
  task: LibraryTask;
}

/**
 * Keybindable fuzzy launcher over the whole library: Enter runs the task,
 * the item buttons insert it into the workspace or open the preview.
 * Ordered pinned-first, then most recently used.
 */
export async function quickOpenLibrary(library: TaskLibrary): Promise<void> {
  const tasks = library.all();
  if (!tasks.length) {
    vscode.window.showInformationMessage('The task library is empty.');
    return;
  }

  const insertButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('add'),
    tooltip: 'Insert into workspace tasks.json',
  };
  const previewButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('open-preview'),
    tooltip: 'Preview',
  };

  const sorted = [...tasks].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) {
      return a.pinned ? -1 : 1;
    }
    const recency = (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
    return recency || a.label.localeCompare(b.label);
  });

  const qp = vscode.window.createQuickPick<LaunchItem>();
  qp.title = 'Task Library';
  qp.placeholder = 'Run a library task (Enter) — buttons insert or preview';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = sorted.map((task) => ({
    label: `${task.pinned ? '$(pinned) ' : ''}${task.label}`,
    description: [
      (task.tags ?? []).map((t) => `#${t}`).join(' '),
      task.group ? `$(folder) ${task.group}` : '',
    ]
      .filter(Boolean)
      .join('  '),
    detail: task.description ?? commandPreview(task),
    buttons: [insertButton, previewButton],
    task,
  }));

  qp.onDidTriggerItemButton(async (e) => {
    qp.hide();
    if (e.button === insertButton) {
      await vscode.commands.executeCommand('tasksLibrary.insertTask', e.item.task.id);
    } else {
      await vscode.commands.executeCommand('tasksLibrary.previewTask', e.item.task.id);
    }
  });
  qp.onDidAccept(async () => {
    const picked = qp.activeItems[0];
    qp.hide();
    if (picked) {
      await runLibraryTask(library, picked.task);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

function commandPreview(task: LibraryTask): string | undefined {
  const def = task.definition;
  if (typeof def.command === 'string') {
    return def.command;
  }
  if (def.type === 'npm' && typeof def.script === 'string') {
    return `npm run ${def.script}`;
  }
  return undefined;
}
