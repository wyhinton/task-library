import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask, SortMode } from './types';
import { WorkspaceStatusTracker } from './workspaceStatus';
import { LibraryDragAndDropController } from './dnd';

export interface GroupNode {
  kind: 'group';
  name: string;
}

export interface TaskNode {
  kind: 'task';
  task: LibraryTask;
  /** True when this node lives under the Pinned section (needs a distinct tree id). */
  inPinnedSection?: boolean;
}

export interface PinnedSectionNode {
  kind: 'pinnedSection';
}

export type LibraryNode = GroupNode | TaskNode | PinnedSectionNode;

export function sortMode(): SortMode {
  return vscode.workspace
    .getConfiguration('tasksLibrary')
    .get<SortMode>('sortBy', 'name');
}

export function compareTasks(a: LibraryTask, b: LibraryTask, mode: SortMode): number {
  switch (mode) {
    case 'recentlyAdded':
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.label.localeCompare(b.label);
    case 'recentlyUsed':
      return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.label.localeCompare(b.label);
    case 'mostUsed': {
      const usage = (t: LibraryTask) => (t.insertCount ?? 0) + (t.runCount ?? 0);
      return usage(b) - usage(a) || a.label.localeCompare(b.label);
    }
    default:
      return a.label.localeCompare(b.label);
  }
}

export class LibraryTreeProvider implements vscode.TreeDataProvider<LibraryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  tagFilter: string | undefined;
  searchQuery: string | undefined;

  constructor(
    private readonly library: TaskLibrary,
    private readonly workspaceStatus: WorkspaceStatusTracker
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private visibleTasks(): LibraryTask[] {
    let tasks = this.library.all();
    if (this.tagFilter) {
      tasks = tasks.filter((t) => (t.tags ?? []).includes(this.tagFilter!));
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      tasks = tasks.filter((t) => this.matchesSearch(t, q));
    }
    return tasks;
  }

  private matchesSearch(task: LibraryTask, query: string): boolean {
    if (task.label.toLowerCase().includes(query)) {
      return true;
    }
    if (task.group?.toLowerCase().includes(query)) {
      return true;
    }
    if (task.description?.toLowerCase().includes(query)) {
      return true;
    }
    if (task.tags?.some((t) => t.toLowerCase().includes(query))) {
      return true;
    }
    return JSON.stringify(task.definition).toLowerCase().includes(query);
  }

  private sorted(tasks: LibraryTask[]): LibraryTask[] {
    const mode = sortMode();
    return [...tasks].sort((a, b) => compareTasks(a, b, mode));
  }

  getChildren(element?: LibraryNode): LibraryNode[] {
    const tasks = this.visibleTasks();
    if (!element) {
      const nodes: LibraryNode[] = [];
      if (tasks.some((t) => t.pinned)) {
        nodes.push({ kind: 'pinnedSection' });
      }
      const groupNames = [...new Set(tasks.filter((t) => t.group).map((t) => t.group!))].sort(
        (a, b) => a.localeCompare(b)
      );
      nodes.push(...groupNames.map((name): LibraryNode => ({ kind: 'group', name })));
      nodes.push(
        ...this.sorted(tasks.filter((t) => !t.group)).map(
          (task): LibraryNode => ({ kind: 'task', task })
        )
      );
      return nodes;
    }
    if (element.kind === 'pinnedSection') {
      return this.sorted(tasks.filter((t) => t.pinned)).map(
        (task): LibraryNode => ({ kind: 'task', task, inPinnedSection: true })
      );
    }
    if (element.kind === 'group') {
      return this.sorted(tasks.filter((t) => t.group === element.name)).map(
        (task): LibraryNode => ({ kind: 'task', task })
      );
    }
    return [];
  }

  getTreeItem(element: LibraryNode): vscode.TreeItem {
    if (element.kind === 'pinnedSection') {
      const count = this.visibleTasks().filter((t) => t.pinned).length;
      const item = new vscode.TreeItem('Pinned', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'pinnedSection';
      item.contextValue = 'libraryPinnedSection';
      item.iconPath = new vscode.ThemeIcon('pinned');
      item.description = `${count}`;
      return item;
    }
    if (element.kind === 'group') {
      const count = this.visibleTasks().filter((t) => t.group === element.name).length;
      const item = new vscode.TreeItem(
        element.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `group:${element.name}`;
      item.contextValue = 'libraryGroup';
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = `${count}`;
      return item;
    }

    const task = element.task;
    const status = this.workspaceStatus.statusFor(task);
    const item = new vscode.TreeItem(task.label, vscode.TreeItemCollapsibleState.None);
    item.id = element.inPinnedSection ? `pinned:${task.id}` : task.id;
    // Composite context value drives menu `when` clauses via regex matching.
    item.contextValue = [
      'libraryTask',
      task.pinned ? ';pinned' : ';unpinned',
      status.status === 'outdated' ? ';outdated' : '',
    ].join('');
    item.resourceUri = WorkspaceStatusTracker.uriFor(task);
    const tags = (task.tags ?? []).map((t) => `#${t}`).join(' ');
    const glyph = status.status === 'synced' ? '✓' : status.status === 'outdated' ? '~' : '';
    const source =
      this.library.hasMultipleSources ? this.library.sourceOf(task.id)?.name : undefined;
    item.description = [glyph, tags, source ? `· ${source}` : '']
      .filter(Boolean)
      .join('  ');
    item.iconPath = task.color
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(task.color))
      : new vscode.ThemeIcon('circle-outline');
    item.tooltip = this.tooltip(task, status);
    item.command = {
      command: 'tasksLibrary.previewTask',
      title: 'Preview Task',
      arguments: [element],
    };
    return item;
  }

  private tooltip(
    task: LibraryTask,
    status: ReturnType<WorkspaceStatusTracker['statusFor']>
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${task.label}**${task.pinned ? ' $(pinned)' : ''}\n\n`);
    if (task.description) {
      md.appendMarkdown(`${task.description}\n\n`);
    }
    const meta: string[] = [];
    if (task.group) {
      meta.push(`$(folder) ${task.group}`);
    }
    if (task.tags?.length) {
      meta.push(task.tags.map((t) => `\`#${t}\``).join(' '));
    }
    if (this.library.hasMultipleSources) {
      const source = this.library.sourceOf(task.id);
      if (source) {
        meta.push(`$(library) ${source.name}`);
      }
    }
    if (meta.length) {
      md.appendMarkdown(meta.join(' • ') + '\n\n');
    }
    if (status.status === 'synced') {
      md.appendMarkdown(`$(check) Already in **${status.syncedFolders.join(', ')}** tasks.json\n\n`);
    } else if (status.status === 'outdated') {
      md.appendMarkdown(
        `$(diff-modified) In **${status.outdatedFolders.join(', ')}** tasks.json, but differs from the library\n\n`
      );
    }
    const inserts = task.insertCount ?? 0;
    const runs = task.runCount ?? 0;
    if (inserts || runs) {
      md.appendMarkdown(
        `$(history) Inserted ${inserts}× · run ${runs}×${task.lastUsedAt ? ` · last used ${new Date(task.lastUsedAt).toLocaleString()}` : ''}\n\n`
      );
    }
    md.appendCodeblock(JSON.stringify(task.definition, null, 2), 'json');
    return md;
  }
}

/** Bundles the provider and the TreeView so commands can drive both. */
export class LibraryTreeController implements vscode.Disposable {
  readonly provider: LibraryTreeProvider;
  readonly view: vscode.TreeView<LibraryNode>;
  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly library: TaskLibrary,
    workspaceStatus: WorkspaceStatusTracker
  ) {
    this.provider = new LibraryTreeProvider(library, workspaceStatus);
    this.view = vscode.window.createTreeView('tasksLibrary.view', {
      treeDataProvider: this.provider,
      showCollapseAll: true,
      canSelectMany: true,
      dragAndDropController: new LibraryDragAndDropController(library),
    });
    library.onDidChange(() => {
      this.provider.refresh();
      this.updateEmptyContext();
    });
    workspaceStatus.onDidChange(() => this.provider.refresh());
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tasksLibrary.sortBy')) {
        this.provider.refresh();
      }
    });
    this.setTagFilter(undefined);
    this.setSearchQuery(undefined);
    this.updateEmptyContext();
  }

  setTagFilter(tag: string | undefined): void {
    this.provider.tagFilter = tag;
    this.provider.refresh();
    this.updateDescription();
    void vscode.commands.executeCommand('setContext', 'tasksLibrary.tagFilterActive', !!tag);
  }

  setSearchQuery(query: string | undefined): void {
    this.provider.searchQuery = query;
    this.provider.refresh();
    this.updateDescription();
    void vscode.commands.executeCommand('setContext', 'tasksLibrary.searchActive', !!query);
  }

  private updateDescription(): void {
    const parts: string[] = [];
    if (this.provider.searchQuery) {
      parts.push(`"${this.provider.searchQuery}"`);
    }
    if (this.provider.tagFilter) {
      parts.push(`#${this.provider.tagFilter}`);
    }
    this.view.description = parts.length ? parts.join(' · ') : undefined;
  }

  private updateEmptyContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'tasksLibrary.empty',
      this.library.all().length === 0
    );
  }

  dispose(): void {
    this.configListener.dispose();
    this.view.dispose();
  }
}
