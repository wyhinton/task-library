import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { addDefinitionToLibrary } from './capture';

/**
 * Remembers the last command run in each terminal via the shell-integration
 * events (VS Code ≥ 1.93; accessed dynamically so the extension still loads
 * on older versions — the command then falls back to a plain input box).
 */
export class TerminalCommandTracker implements vscode.Disposable {
  private readonly byTerminal = new Map<vscode.Terminal, string>();
  private mostRecent: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const win = vscode.window as unknown as {
      onDidEndTerminalShellExecution?: (
        listener: (e: {
          terminal: vscode.Terminal;
          execution: { commandLine?: { value?: string } };
        }) => void
      ) => vscode.Disposable;
    };
    if (typeof win.onDidEndTerminalShellExecution === 'function') {
      this.disposables.push(
        win.onDidEndTerminalShellExecution((e) => {
          const commandLine = e?.execution?.commandLine?.value;
          if (commandLine && commandLine.trim()) {
            this.byTerminal.set(e.terminal, commandLine.trim());
            this.mostRecent = commandLine.trim();
          }
        })
      );
    }
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => this.byTerminal.delete(t))
    );
  }

  /** Best guess for "the command the user means": active terminal's last, else most recent anywhere. */
  get suggestion(): string | undefined {
    const active = vscode.window.activeTerminal;
    return (active && this.byTerminal.get(active)) ?? this.mostRecent;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Wrap a shell command (pre-filled from the terminal when possible) into a library task. */
export async function addTaskFromTerminal(
  tracker: TerminalCommandTracker,
  library: TaskLibrary
): Promise<void> {
  const command = await vscode.window.showInputBox({
    title: 'Save Terminal Command as Task',
    prompt: 'Shell command to save',
    value: tracker.suggestion ?? '',
    placeHolder: 'e.g. npm run build -- --watch',
    ignoreFocusOut: true,
  });
  if (!command || !command.trim()) {
    return;
  }
  const label = await vscode.window.showInputBox({
    title: 'Save Terminal Command as Task',
    prompt: 'Task label',
    value: command.trim(),
    ignoreFocusOut: true,
  });
  if (!label || !label.trim()) {
    return;
  }
  await addDefinitionToLibrary(
    library,
    { label: label.trim(), type: 'shell', command: command.trim(), problemMatcher: [] },
    [],
    { interactive: true, meta: { tags: ['terminal'] } }
  );
}
