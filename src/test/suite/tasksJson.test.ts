import * as assert from 'assert';
import { LibraryTask } from '../../types';
import {
  addTasksToText,
  collectReferencedInputs,
  dependencyLabels,
  detectFormatting,
  parseTasksDocument,
  taskAtOffset,
} from '../../tasksJson';

describe('detectFormatting', () => {
  it('detects tab indentation', () => {
    const fmt = detectFormatting('{\n\t"a": 1\n}');
    assert.strictEqual(fmt.insertSpaces, false);
  });

  it('detects space indentation and its width', () => {
    const fmt = detectFormatting('{\n    "a": 1\n}');
    assert.strictEqual(fmt.insertSpaces, true);
    assert.strictEqual(fmt.tabSize, 4);
  });
});

describe('parseTasksDocument / taskAtOffset', () => {
  const text = JSON.stringify(
    {
      version: '2.0.0',
      tasks: [
        { label: 'one', type: 'shell', command: 'echo 1' },
        { label: 'two', type: 'shell', command: 'echo 2' },
      ],
    },
    null,
    2
  );

  it('parses the tasks array', () => {
    const { tasks } = parseTasksDocument(text);
    assert.strictEqual(tasks.length, 2);
  });

  it('returns an empty array when there is no tasks array', () => {
    const { tasks } = parseTasksDocument('{}');
    assert.deepStrictEqual(tasks, []);
  });

  it('finds the task containing a given offset', () => {
    const offset = text.indexOf('"two"');
    const found = taskAtOffset(text, offset);
    assert.strictEqual(found?.def.label, 'two');
    assert.strictEqual(found?.index, 1);
  });

  it('returns undefined for an offset outside any task', () => {
    assert.strictEqual(taskAtOffset(text, 0), undefined);
  });
});

describe('collectReferencedInputs', () => {
  it('pulls only the inputs referenced by the task', () => {
    const fileJson = {
      inputs: [
        { id: 'used', type: 'promptString' },
        { id: 'unused', type: 'promptString' },
      ],
    };
    const def = { command: 'echo ${input:used}' };
    const inputs = collectReferencedInputs(def, fileJson);
    assert.deepStrictEqual(
      inputs.map((i) => i.id),
      ['used']
    );
  });

  it('returns an empty array when nothing is referenced', () => {
    assert.deepStrictEqual(collectReferencedInputs({ command: 'echo hi' }, { inputs: [] }), []);
  });

  it('returns an empty array when the file has no inputs section', () => {
    assert.deepStrictEqual(collectReferencedInputs({ command: '${input:x}' }, {}), []);
  });
});

describe('dependencyLabels', () => {
  it('handles a single string dependsOn', () => {
    assert.deepStrictEqual(dependencyLabels({ dependsOn: 'build' }), ['build']);
  });

  it('handles an array dependsOn', () => {
    assert.deepStrictEqual(dependencyLabels({ dependsOn: ['a', 'b'] }), ['a', 'b']);
  });

  it('returns an empty array when dependsOn is absent', () => {
    assert.deepStrictEqual(dependencyLabels({}), []);
  });
});

describe('addTasksToText', () => {
  const emptyDoc = '{\n\t"version": "2.0.0",\n\t"tasks": []\n}\n';

  function makeTask(label: string): LibraryTask {
    return {
      id: label,
      label,
      definition: { label, type: 'shell', command: `echo ${label}` },
      createdAt: '',
      updatedAt: '',
    };
  }

  it('appends new tasks and reports what was added', () => {
    const { text, added, skipped } = addTasksToText(emptyDoc, [makeTask('build')]);
    assert.deepStrictEqual(added, ['build']);
    assert.deepStrictEqual(skipped, []);
    const { tasks } = parseTasksDocument(text);
    assert.strictEqual(tasks.length, 1);
  });

  it('skips a task whose label already exists, without overwriting it', () => {
    const { text: withBuild } = addTasksToText(emptyDoc, [makeTask('build')]);
    const { text, added, skipped } = addTasksToText(withBuild, [makeTask('build')]);
    assert.deepStrictEqual(added, []);
    assert.deepStrictEqual(skipped, ['build']);
    const { tasks } = parseTasksDocument(text);
    assert.strictEqual(tasks.length, 1);
  });

  it('merges inputs referenced by an added task', () => {
    const task: LibraryTask = {
      ...makeTask('greet'),
      definition: { label: 'greet', type: 'shell', command: 'echo ${input:name}' },
      inputs: [{ id: 'name', type: 'promptString', description: 'Your name' }],
    };
    const { text } = addTasksToText(emptyDoc, [task]);
    const { json } = parseTasksDocument(text);
    const inputs = (json as { inputs?: { id: string }[] }).inputs;
    assert.deepStrictEqual(inputs?.map((i) => i.id), ['name']);
  });
});
