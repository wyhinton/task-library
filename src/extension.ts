import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTreeController } from './tree';
import { TasksJsonCodeLensProvider } from './codelens';
import { registerCommands } from './commands';
import { WorkspaceStatusTracker } from './workspaceStatus';
import { TasksJsonDropProvider } from './dnd';
import { DIFF_SCHEME, TaskDiffContentProvider } from './diff';
import {
  LibraryCodeActionProvider,
  LibraryCompletionProvider,
  LibraryHoverProvider,
} from './languageFeatures';
import { StatusBarPins } from './statusBar';
import { TerminalCommandTracker } from './terminal';

export function activate(context: vscode.ExtensionContext): void {
  const library = new TaskLibrary(context);
  const workspaceStatus = new WorkspaceStatusTracker(library);
  const tree = new LibraryTreeController(library, workspaceStatus);
  const terminalTracker = new TerminalCommandTracker();

  const selector: vscode.DocumentSelector = [
    { language: 'jsonc', pattern: '**/tasks.json' },
    { language: 'json', pattern: '**/tasks.json' },
  ];
  const codeLensProvider = new TasksJsonCodeLensProvider(library);

  context.subscriptions.push(
    library,
    workspaceStatus,
    tree,
    terminalTracker,
    new StatusBarPins(library),
    vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new LibraryCompletionProvider(library)
    ),
    vscode.languages.registerHoverProvider(selector, new LibraryHoverProvider(library)),
    vscode.languages.registerCodeActionsProvider(
      selector,
      new LibraryCodeActionProvider(library),
      LibraryCodeActionProvider.metadata
    ),
    vscode.languages.registerDocumentDropEditProvider(selector, new TasksJsonDropProvider(library)),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      new TaskDiffContentProvider(library)
    ),
    vscode.window.registerFileDecorationProvider(workspaceStatus)
  );

  registerCommands(context, { library, tree, workspaceStatus, terminalTracker });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
