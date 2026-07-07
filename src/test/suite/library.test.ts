import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskLibrary } from '../../library';
import { LibraryTask } from '../../types';

function makeTask(id: string, label: string): LibraryTask {
  const now = new Date().toISOString();
  return {
    id,
    label,
    definition: { label, type: 'shell', command: `echo ${label}` },
    createdAt: now,
    updatedAt: now,
  };
}

describe('TaskLibrary', () => {
  let tmpFile: string;
  let library: TaskLibrary;

  beforeEach(async () => {
    tmpFile = path.join(
      os.tmpdir(),
      `task-library-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    await vscode.workspace
      .getConfiguration('tasksLibrary')
      .update('libraryFile', tmpFile, vscode.ConfigurationTarget.Global);
    const fakeContext = {
      globalStorageUri: vscode.Uri.file(os.tmpdir()),
    } as unknown as vscode.ExtensionContext;
    library = new TaskLibrary(fakeContext);
  });

  afterEach(async () => {
    library.dispose();
    await vscode.workspace
      .getConfiguration('tasksLibrary')
      .update('libraryFile', '', vscode.ConfigurationTarget.Global);
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('starts empty and writes new tasks to the primary file', () => {
    assert.strictEqual(library.all().length, 0);
    library.upsert(makeTask(library.newId(), 'Build'));
    assert.strictEqual(library.all().length, 1);
    assert.ok(fs.existsSync(tmpFile));
  });

  it('finds tasks by id and by label', () => {
    const id = library.newId();
    library.upsert(makeTask(id, 'Test'));
    assert.strictEqual(library.byId(id)?.label, 'Test');
    assert.strictEqual(library.findByLabel('Test')?.id, id);
    assert.strictEqual(library.findByLabel('Nope'), undefined);
  });

  it('updates metadata and tracks groups and tags', () => {
    const id = library.newId();
    library.upsert(makeTask(id, 'Lint'));
    library.update(id, { group: 'Quality', tags: ['ci', 'lint'] });
    assert.deepStrictEqual(library.groups(), ['Quality']);
    assert.deepStrictEqual([...library.allTags().keys()], ['ci', 'lint']);
  });

  it('pins tasks and records usage counts', () => {
    const id = library.newId();
    library.upsert(makeTask(id, 'Deploy'));
    library.setPinned([id], true);
    assert.strictEqual(library.byId(id)?.pinned, true);

    library.recordUsage(id, 'run');
    library.recordUsage(id, 'insert');
    library.recordUsage(id, 'run');
    const task = library.byId(id)!;
    assert.strictEqual(task.runCount, 2);
    assert.strictEqual(task.insertCount, 1);
    assert.ok(task.lastUsedAt);

    library.setPinned([id], false);
    assert.strictEqual(library.byId(id)?.pinned, undefined);
  });

  it('removes single and multiple tasks', () => {
    const a = library.newId();
    const b = library.newId();
    library.upsert(makeTask(a, 'A'));
    library.upsert(makeTask(b, 'B'));
    assert.strictEqual(library.all().length, 2);

    library.remove(a);
    assert.strictEqual(library.all().length, 1);

    library.upsert(makeTask(a, 'A'));
    library.removeMany([a, b]);
    assert.strictEqual(library.all().length, 0);
  });

  it('renames a group across all its tasks', () => {
    const a = library.newId();
    const b = library.newId();
    library.upsert(makeTask(a, 'A'));
    library.upsert(makeTask(b, 'B'));
    library.update(a, { group: 'Old' });
    library.update(b, { group: 'Old' });

    library.renameGroup('Old', 'New');
    assert.strictEqual(library.byId(a)?.group, 'New');
    assert.strictEqual(library.byId(b)?.group, 'New');
  });

  it('persists tasks to disk across a reload', () => {
    const id = library.newId();
    library.upsert(makeTask(id, 'Persisted'));
    library.reloadAll();
    assert.strictEqual(library.findByLabel('Persisted')?.id, id);
  });
});
