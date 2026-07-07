import * as vscode from 'vscode';
import { TaskLibrary } from './library';

/**
 * One-click launchers in the status bar for pinned tasks (up to
 * `tasksLibrary.statusBar.maxItems`), colored with the task's library color.
 */
export class StatusBarPins implements vscode.Disposable {
  private items: vscode.StatusBarItem[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly library: TaskLibrary) {
    this.disposables.push(
      library.onDidChange(() => this.rebuild()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tasksLibrary.statusBar')) {
          this.rebuild();
        }
      })
    );
    this.rebuild();
  }

  private rebuild(): void {
    this.items.forEach((i) => i.dispose());
    this.items = [];
    const config = vscode.workspace.getConfiguration('tasksLibrary');
    if (!config.get<boolean>('statusBar.enabled', true)) {
      return;
    }
    const max = Math.max(0, config.get<number>('statusBar.maxItems', 3));
    const pinned = this.library
      .all()
      .filter((t) => t.pinned)
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, max);
    pinned.forEach((task, i) => {
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        90 - i
      );
      item.text = `$(play) ${task.label}`;
      item.color = task.color ? new vscode.ThemeColor(task.color) : undefined;
      item.tooltip = new vscode.MarkdownString(
        `Run **${task.label}** from the Task Library${task.description ? `\n\n${task.description}` : ''}`
      );
      item.command = {
        command: 'tasksLibrary.runTask',
        title: 'Run',
        arguments: [task.id],
      };
      item.show();
      this.items.push(item);
    });
  }

  dispose(): void {
    this.items.forEach((i) => i.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
