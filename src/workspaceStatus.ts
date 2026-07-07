import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { parseTasksDocument, readFileText } from './tasksJson';
import { LibraryTask, computeLabel } from './types';

export const TASK_STATUS_SCHEME = 'taskslib-status';

export type WorkspaceStatus = 'synced' | 'outdated' | 'absent';

export interface WorkspaceStatusInfo {
  status: WorkspaceStatus;
  syncedFolders: string[];
  outdatedFolders: string[];
}

const ABSENT: WorkspaceStatusInfo = { status: 'absent', syncedFolders: [], outdatedFolders: [] };

/**
 * Tracks, per library task label, whether a matching task already exists in
 * any open workspace folder's .vscode/tasks.json and whether it's identical
 * (synced) or has drifted (outdated). Also acts as the FileDecorationProvider
 * that paints the tree's "already in workspace" badge.
 */
export class WorkspaceStatusTracker implements vscode.Disposable, vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private byLabel = new Map<string, { syncedFolders: string[]; outdatedFolders: string[] }>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly library: TaskLibrary) {
    this.disposables.push(
      library.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh())
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/tasks.json');
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh())
    );
    void this.refresh();
  }

  static uriFor(task: LibraryTask): vscode.Uri {
    return vscode.Uri.from({ scheme: TASK_STATUS_SCHEME, path: '/' + task.id });
  }

  statusFor(task: LibraryTask): WorkspaceStatusInfo {
    const entry = this.byLabel.get(task.label);
    if (!entry || (!entry.syncedFolders.length && !entry.outdatedFolders.length)) {
      return ABSENT;
    }
    if (entry.syncedFolders.length) {
      return { status: 'synced', syncedFolders: entry.syncedFolders, outdatedFolders: entry.outdatedFolders };
    }
    return { status: 'outdated', syncedFolders: [], outdatedFolders: entry.outdatedFolders };
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TASK_STATUS_SCHEME) {
      return undefined;
    }
    const task = this.library.byId(uri.path.replace(/^\//, ''));
    if (!task) {
      return undefined;
    }
    const info = this.statusFor(task);
    if (info.status === 'synced') {
      return {
        badge: '✓',
        color: new vscode.ThemeColor('charts.green'),
        tooltip: `Already in ${info.syncedFolders.join(', ')} tasks.json`,
      };
    }
    if (info.status === 'outdated') {
      return {
        badge: '~',
        color: new vscode.ThemeColor('charts.yellow'),
        tooltip: `In ${info.outdatedFolders.join(', ')} tasks.json, but differs from the library`,
      };
    }
    return undefined;
  }

  /** Debounce bursts of filesystem events (e.g. saving several files at once). */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), 150);
  }

  async refresh(): Promise<void> {
    const map = new Map<string, { syncedFolders: string[]; outdatedFolders: string[] }>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
      const text = await readFileText(uri);
      if (!text) {
        continue;
      }
      const { tasks } = parseTasksDocument(text);
      for (const def of tasks) {
        const label = computeLabel(def);
        const libTask = this.library.findByLabel(label);
        if (!libTask) {
          continue;
        }
        const entry = map.get(label) ?? { syncedFolders: [], outdatedFolders: [] };
        if (JSON.stringify(def) === JSON.stringify(libTask.definition)) {
          entry.syncedFolders.push(folder.name);
        } else {
          entry.outdatedFolders.push(folder.name);
        }
        map.set(label, entry);
      }
    }
    this.byLabel = map;
    this._onDidChangeFileDecorations.fire(undefined);
    this._onDidChange.fire();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeFileDecorations.dispose();
    this._onDidChange.dispose();
  }
}
