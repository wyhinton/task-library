import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask } from './types';
import { addTasksToText } from './tasksJson';
import type { LibraryNode } from './tree';

/** Must be `application/vnd.code.tree.<viewId lowercased>`. */
export const TREE_MIME = 'application/vnd.code.tree.taskslibrary.view';

/**
 * Drag & drop inside the Task Library tree:
 *  - drop tasks on a group → move them into that group
 *  - drop tasks on another task → adopt that task's group
 *  - drop tasks on the empty area → ungroup
 *  - drop tasks on the Pinned section → pin them
 * Dragging out also carries `text/plain` (the JSON definitions), so tasks can
 * be dropped into any text editor; tasks.json editors get a structured insert
 * via TasksJsonDropProvider below.
 */
export class LibraryDragAndDropController
  implements vscode.TreeDragAndDropController<LibraryNode>
{
  readonly dropMimeTypes = [TREE_MIME];
  readonly dragMimeTypes = [TREE_MIME, 'text/plain'];

  constructor(private readonly library: TaskLibrary) {}

  handleDrag(source: readonly LibraryNode[], dataTransfer: vscode.DataTransfer): void {
    const tasks = source
      .filter((n): n is Extract<LibraryNode, { kind: 'task' }> => n.kind === 'task')
      .map((n) => n.task);
    if (!tasks.length) {
      return;
    }
    dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(tasks.map((t) => t.id))));
    const defs = tasks.map((t) => t.definition);
    dataTransfer.set(
      'text/plain',
      new vscode.DataTransferItem(JSON.stringify(defs.length === 1 ? defs[0] : defs, null, 2))
    );
  }

  async handleDrop(
    target: LibraryNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = dataTransfer.get(TREE_MIME);
    if (!item) {
      return;
    }
    let ids: string[];
    try {
      ids = JSON.parse(await item.asString()) as string[];
    } catch {
      return;
    }
    if (!Array.isArray(ids) || !ids.length) {
      return;
    }

    if (target?.kind === 'pinnedSection') {
      this.library.setPinned(ids, true);
      return;
    }
    const group =
      target?.kind === 'group'
        ? target.name
        : target?.kind === 'task'
          ? target.task.group
          : undefined;
    for (const id of ids) {
      const task = this.library.byId(id);
      if (task && task.group !== group) {
        this.library.update(id, { group });
      }
    }
  }
}

/**
 * Makes dropping library tasks onto a tasks.json editor do a proper
 * structured insert (comment-preserving, inputs merged, duplicates skipped)
 * instead of pasting raw JSON.
 */
export class TasksJsonDropProvider implements vscode.DocumentDropEditProvider {
  constructor(private readonly library: TaskLibrary) {}

  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    _position: vscode.Position,
    dataTransfer: vscode.DataTransfer
  ): Promise<vscode.DocumentDropEdit | undefined> {
    const item = dataTransfer.get(TREE_MIME);
    if (!item) {
      return undefined;
    }
    let ids: string[];
    try {
      ids = JSON.parse(await item.asString()) as string[];
    } catch {
      return undefined;
    }
    const tasks = ids
      .map((id) => this.library.byId(id))
      .filter((t): t is LibraryTask => !!t);
    if (!tasks.length) {
      return undefined;
    }

    const { text, added, skipped } = addTasksToText(document.getText(), tasks);
    const edit = new vscode.DocumentDropEdit('');
    if (added.length) {
      const we = new vscode.WorkspaceEdit();
      we.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        text
      );
      edit.additionalEdit = we;
    }
    setTimeout(() => {
      if (added.length && skipped.length) {
        vscode.window.showInformationMessage(
          `Task Library: added ${added.length} task${added.length === 1 ? '' : 's'}; skipped ${skipped.map((s) => `"${s}"`).join(', ')} (already present).`
        );
      } else if (!added.length && skipped.length) {
        vscode.window.showInformationMessage(
          `Task Library: ${skipped.map((s) => `"${s}"`).join(', ')} already present — nothing added. Use the tree's + button to overwrite.`
        );
      }
    }, 0);
    return edit;
  }
}
