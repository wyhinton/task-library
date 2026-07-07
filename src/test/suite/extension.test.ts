import * as assert from 'assert';
import * as vscode from 'vscode';

describe('extension activation', () => {
  it('activates and registers its core commands', async () => {
    const ext = vscode.extensions.getExtension('wyhinton.task-library');
    assert.ok(ext, 'extension "wyhinton.task-library" was not found — check publisher/name in package.json');

    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'tasksLibrary.insertTask',
      'tasksLibrary.runTask',
      'tasksLibrary.quickOpen',
      'tasksLibrary.previewTask',
      'tasksLibrary.generateFromProject',
      'tasksLibrary.importFromUrl',
      'tasksLibrary.exportTasks',
    ]) {
      assert.ok(commands.includes(id), `command "${id}" was not registered`);
    }
  });

  it('registers the Task Library activity bar view', async () => {
    // Executing this command only succeeds if the view container/view contributed.
    await vscode.commands.executeCommand('workbench.view.extension.tasksLibrary');
  });
});
