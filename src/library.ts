import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { LibraryFile, LibraryTask } from './types';

/** Snapshot at most this often per source (safety copies, not full history). */
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface LibrarySource {
  /** Absolute path of the JSON file. */
  path: string;
  /** Short display name: "Personal" for the default primary, otherwise the file's basename. */
  name: string;
  index: number;
}

interface SourceState {
  info: LibrarySource;
  tasks: LibraryTask[];
  watcher?: fs.FSWatcher;
}

export interface SnapshotInfo {
  file: string;
  time: Date;
  taskCount: number;
}

/**
 * Owns one or more library JSON files: loading, saving, watching for external
 * changes (so a synced/shared file updates the UI live), and all CRUD.
 * The first source (from `tasksLibrary.libraryFile`, or private global storage)
 * is the primary — new tasks land there. Extra sources come from
 * `tasksLibrary.extraLibraryFiles`; tasks stay in the file they came from and
 * edits are written back to that file.
 */
export class TaskLibrary implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private sources: SourceState[] = [];
  private watchDebounce: NodeJS.Timeout | undefined;
  private lastSavedAt = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('tasksLibrary.libraryFile') ||
          e.affectsConfiguration('tasksLibrary.extraLibraryFiles')
        ) {
          this.reloadAll();
        }
      })
    );
    this.reloadAll();
  }

  /** Path of the primary (writable, default) library file. */
  get filePath(): string {
    return this.sourcePaths()[0].path;
  }

  get sourceInfos(): LibrarySource[] {
    return this.sources.map((s) => s.info);
  }

  get hasMultipleSources(): boolean {
    return this.sources.length > 1;
  }

  sourceOf(taskId: string): LibrarySource | undefined {
    return this.sources.find((s) => s.tasks.some((t) => t.id === taskId))?.info;
  }

  private resolvePath(configured: string): string {
    let p = configured.trim();
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
      p = path.join(os.homedir(), p.slice(1));
    }
    if (!path.isAbsolute(p)) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      p = folder ? path.join(folder.uri.fsPath, p) : path.resolve(p);
    }
    return path.normalize(p);
  }

  private sourcePaths(): { path: string; name: string }[] {
    const config = vscode.workspace.getConfiguration('tasksLibrary');
    const configured = config.get<string>('libraryFile');
    const primary =
      configured && configured.trim()
        ? { path: this.resolvePath(configured), name: path.basename(configured.trim(), '.json') }
        : {
            path: path.join(this.context.globalStorageUri.fsPath, 'task-library.json'),
            name: 'Personal',
          };
    const result = [primary];
    for (const extra of config.get<string[]>('extraLibraryFiles') ?? []) {
      if (typeof extra !== 'string' || !extra.trim()) {
        continue;
      }
      const p = this.resolvePath(extra);
      if (result.some((r) => r.path === p)) {
        continue;
      }
      result.push({ path: p, name: path.basename(extra.trim(), '.json') });
    }
    return result;
  }

  reloadAll(): void {
    for (const s of this.sources) {
      s.watcher?.close();
    }
    this.sources = this.sourcePaths().map((sp, index) => ({
      info: { path: sp.path, name: sp.name, index },
      tasks: this.loadFile(sp.path),
    }));
    for (const s of this.sources) {
      this.startWatching(s);
    }
    this._onDidChange.fire();
  }

  all(): LibraryTask[] {
    return this.sources.flatMap((s) => s.tasks);
  }

  byId(id: string): LibraryTask | undefined {
    for (const s of this.sources) {
      const found = s.tasks.find((t) => t.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  findByLabel(label: string): LibraryTask | undefined {
    for (const s of this.sources) {
      const found = s.tasks.find((t) => t.label === label);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  groups(): string[] {
    const names = new Set<string>();
    for (const t of this.all()) {
      if (t.group) {
        names.add(t.group);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  allTags(): Map<string, number> {
    const tags = new Map<string, number>();
    for (const t of this.all()) {
      for (const tag of t.tags ?? []) {
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
    }
    return new Map([...tags.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  newId(): string {
    return crypto.randomUUID();
  }

  /** Insert a new task (into the primary source) or replace it in the source that owns it. */
  upsert(task: LibraryTask): void {
    task.updatedAt = new Date().toISOString();
    for (const s of this.sources) {
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        s.tasks[idx] = task;
        this.save(s);
        return;
      }
    }
    this.sources[0].tasks.push(task);
    this.save(this.sources[0]);
  }

  update(id: string, patch: Partial<LibraryTask>): LibraryTask | undefined {
    for (const s of this.sources) {
      const task = s.tasks.find((t) => t.id === id);
      if (task) {
        Object.assign(task, patch, { id: task.id, updatedAt: new Date().toISOString() });
        this.save(s);
        return task;
      }
    }
    return undefined;
  }

  remove(id: string): void {
    this.removeMany([id]);
  }

  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    for (const s of this.sources) {
      const before = s.tasks.length;
      s.tasks = s.tasks.filter((t) => !idSet.has(t.id));
      if (s.tasks.length !== before) {
        this.save(s);
      }
    }
  }

  renameGroup(oldName: string, newName: string): void {
    for (const s of this.sources) {
      let changed = false;
      for (const t of s.tasks) {
        if (t.group === oldName) {
          t.group = newName || undefined;
          changed = true;
        }
      }
      if (changed) {
        this.save(s);
      }
    }
  }

  setPinned(ids: string[], pinned: boolean): void {
    const idSet = new Set(ids);
    for (const s of this.sources) {
      let changed = false;
      for (const t of s.tasks) {
        if (idSet.has(t.id) && !!t.pinned !== pinned) {
          t.pinned = pinned || undefined;
          changed = true;
        }
      }
      if (changed) {
        this.save(s);
      }
    }
  }

  recordUsage(id: string, kind: 'insert' | 'run'): void {
    for (const s of this.sources) {
      const task = s.tasks.find((t) => t.id === id);
      if (task) {
        if (kind === 'insert') {
          task.insertCount = (task.insertCount ?? 0) + 1;
        } else {
          task.runCount = (task.runCount ?? 0) + 1;
        }
        task.lastUsedAt = new Date().toISOString();
        this.save(s);
        return;
      }
    }
  }

  private loadFile(filePath: string): LibraryTask[] {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as LibraryFile | LibraryTask[];
      const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
      return Array.isArray(tasks) ? tasks.filter((t) => t && t.id && t.definition) : [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        vscode.window.showWarningMessage(
          `Task Library: could not read library file ${filePath}: ${String(err)}`
        );
      }
      return [];
    }
  }

  private save(source: SourceState): void {
    this.maybeSnapshot(source);
    const file: LibraryFile = { version: 1, tasks: source.tasks };
    fs.mkdirSync(path.dirname(source.info.path), { recursive: true });
    fs.writeFileSync(source.info.path, JSON.stringify(file, null, 2) + '\n', 'utf8');
    this.lastSavedAt = Date.now();
    this._onDidChange.fire();
    if (!source.watcher) {
      this.startWatching(source);
    }
  }

  // --- Snapshots ------------------------------------------------------------

  private snapshotDir(source: SourceState): string {
    const hash = crypto.createHash('sha1').update(source.info.path).digest('hex').slice(0, 12);
    return path.join(this.context.globalStorageUri.fsPath, 'snapshots', hash);
  }

  /** Copy the file's current on-disk content aside before overwriting it, throttled. */
  private maybeSnapshot(source: SourceState): void {
    const newest = this.listSnapshots(source.info.index)[0];
    if (newest && Date.now() - newest.time.getTime() < SNAPSHOT_MIN_INTERVAL_MS) {
      return;
    }
    this.snapshotNow(source.info.index);
  }

  /** Force a snapshot of a source's current on-disk content (e.g. before a bulk import). */
  snapshotNow(sourceIndex: number): void {
    const source = this.sources[sourceIndex];
    if (!source || !fs.existsSync(source.info.path)) {
      return;
    }
    try {
      const content = fs.readFileSync(source.info.path, 'utf8');
      const dir = this.snapshotDir(source);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(dir, `${stamp}.json`), content, 'utf8');
      const keep = Math.max(
        1,
        vscode.workspace.getConfiguration('tasksLibrary').get<number>('snapshots.keep', 10)
      );
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();
      for (const stale of files.slice(keep)) {
        fs.unlinkSync(path.join(dir, stale));
      }
    } catch {
      // Snapshots are best-effort.
    }
  }

  listSnapshots(sourceIndex: number): SnapshotInfo[] {
    const source = this.sources[sourceIndex];
    if (!source) {
      return [];
    }
    const dir = this.snapshotDir(source);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const result: SnapshotInfo[] = [];
    for (const f of files.sort().reverse()) {
      const full = path.join(dir, f);
      let taskCount = 0;
      let time: Date;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as LibraryFile;
        taskCount = Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0;
        time = fs.statSync(full).mtime;
      } catch {
        continue;
      }
      result.push({ file: full, time, taskCount });
    }
    return result;
  }

  restoreSnapshot(sourceIndex: number, snapshotFile: string): void {
    const source = this.sources[sourceIndex];
    if (!source) {
      return;
    }
    // Keep a copy of what we're about to replace, so a restore is undoable too.
    this.snapshotNow(sourceIndex);
    const content = fs.readFileSync(snapshotFile, 'utf8');
    fs.mkdirSync(path.dirname(source.info.path), { recursive: true });
    fs.writeFileSync(source.info.path, content, 'utf8');
    this.lastSavedAt = Date.now();
    source.tasks = this.loadFile(source.info.path);
    this._onDidChange.fire();
  }

  // --- File watching ----------------------------------------------------------

  /** Watch a library file so external edits (sync, teammates, manual) refresh the view. */
  private startWatching(source: SourceState): void {
    source.watcher?.close();
    source.watcher = undefined;
    const dir = path.dirname(source.info.path);
    const fileName = path.basename(source.info.path);
    if (!fs.existsSync(dir)) {
      return;
    }
    try {
      source.watcher = fs.watch(dir, (_event, changed) => {
        if (changed && changed !== fileName) {
          return;
        }
        // Ignore events triggered by our own save.
        if (Date.now() - this.lastSavedAt < 500) {
          return;
        }
        if (this.watchDebounce) {
          clearTimeout(this.watchDebounce);
        }
        this.watchDebounce = setTimeout(() => {
          source.tasks = this.loadFile(source.info.path);
          this._onDidChange.fire();
        }, 200);
      });
    } catch {
      // Watching is best-effort; the refresh button still works.
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      s.watcher?.close();
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
