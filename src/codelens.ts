import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { TaskLibrary } from './library';
import { computeLabel } from './types';

/**
 * Adds inline actions above every task in a tasks.json file:
 *   - "Add to Task Library" when the task isn't in the library
 *   - "Update in Task Library" when it's in the library but differs
 *   - "In Task Library" (opens the preview) when it matches exactly
 */
export class TasksJsonCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly library: TaskLibrary) {
    library.onDidChange(() => this._onDidChangeCodeLenses.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tasksLibrary.codeLens.enabled')) {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration('tasksLibrary')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled) {
      return [];
    }

    const text = document.getText();
    const root = jsonc.parseTree(text);
    if (!root) {
      return [];
    }
    const tasksNode = jsonc.findNodeAtLocation(root, ['tasks']);
    if (!tasksNode || tasksNode.type !== 'array' || !tasksNode.children?.length) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    if (tasksNode.children.length > 1) {
      const headerNode = tasksNode.parent ?? tasksNode;
      const headerRange = new vscode.Range(
        document.positionAt(headerNode.offset),
        document.positionAt(headerNode.offset)
      );
      lenses.push(
        new vscode.CodeLens(headerRange, {
          title: `$(library) Add all ${tasksNode.children.length} tasks to Task Library`,
          command: 'tasksLibrary.addAllFromEditor',
          arguments: [document.uri],
        })
      );
    }

    for (const child of tasksNode.children) {
      if (child.type !== 'object') {
        continue;
      }
      const def = jsonc.getNodeValue(child);
      const label = computeLabel(def);
      const existing = this.library.findByLabel(label);
      const range = new vscode.Range(
        document.positionAt(child.offset),
        document.positionAt(child.offset)
      );

      if (!existing) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(plus) Add to Task Library',
            command: 'tasksLibrary.addFromEditor',
            arguments: [document.uri, child.offset],
          })
        );
      } else if (JSON.stringify(existing.definition) !== JSON.stringify(def)) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(sync) Update in Task Library',
            command: 'tasksLibrary.addFromEditor',
            arguments: [document.uri, child.offset],
          }),
          new vscode.CodeLens(range, {
            title: '$(diff) Compare with library',
            command: 'tasksLibrary.compareWithWorkspace',
            arguments: [existing.id, document.uri],
          })
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(check) In Task Library',
            command: 'tasksLibrary.previewTask',
            arguments: [existing.id],
          })
        );
      }
    }

    return lenses;
  }
}
