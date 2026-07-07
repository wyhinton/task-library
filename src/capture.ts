import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask, computeLabel } from './types';

export type AddResult = 'added' | 'updated' | 'unchanged' | 'cancelled';

export interface AddOptions {
  interactive: boolean;
  /** Metadata applied to newly created tasks (e.g. auto-tags from generators). */
  meta?: Pick<Partial<LibraryTask>, 'group' | 'tags' | 'color' | 'description'>;
}

/** Add (or update) a raw tasks.json definition in the library, by label. */
export async function addDefinitionToLibrary(
  library: TaskLibrary,
  def: Record<string, unknown>,
  inputs: Record<string, unknown>[],
  options: AddOptions
): Promise<AddResult> {
  const label = computeLabel(def);
  const existing = library.findByLabel(label);
  const now = new Date().toISOString();

  if (existing) {
    const sameDef = JSON.stringify(existing.definition) === JSON.stringify(def);
    if (sameDef) {
      if (options.interactive) {
        vscode.window.showInformationMessage(`"${label}" is already in the library.`);
      }
      return 'unchanged';
    }
    if (options.interactive) {
      const choice = await vscode.window.showWarningMessage(
        `"${label}" is already in the library with a different definition.`,
        { modal: true },
        'Update Existing',
        'Add as Copy'
      );
      if (!choice) {
        return 'cancelled';
      }
      if (choice === 'Add as Copy') {
        const copyDef = { ...def, label: `${label} (copy)` };
        const task: LibraryTask = {
          id: library.newId(),
          label: computeLabel(copyDef),
          definition: copyDef,
          inputs: inputs.length ? inputs : undefined,
          tags: options.meta?.tags ?? [],
          ...options.meta,
          createdAt: now,
          updatedAt: now,
        };
        library.upsert(task);
        await offerMetadataSetup(task);
        return 'added';
      }
    }
    library.update(existing.id, {
      definition: def,
      inputs: inputs.length ? inputs : undefined,
      label,
    });
    if (options.interactive) {
      vscode.window.showInformationMessage(`Updated "${label}" in the task library.`);
    }
    return 'updated';
  }

  const task: LibraryTask = {
    id: library.newId(),
    label,
    definition: def,
    inputs: inputs.length ? inputs : undefined,
    tags: options.meta?.tags ?? [],
    ...options.meta,
    createdAt: now,
    updatedAt: now,
  };
  library.upsert(task);
  if (options.interactive) {
    await offerMetadataSetup(task);
  }
  return 'added';
}

/** After adding a task interactively, offer one-click metadata setup. */
export async function offerMetadataSetup(task: LibraryTask): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Added "${task.label}" to the task library.`,
    'Set Group…',
    'Set Tags…',
    'Set Color…'
  );
  const node = { kind: 'task' as const, task };
  if (choice === 'Set Group…') {
    await vscode.commands.executeCommand('tasksLibrary.editGroup', node);
  } else if (choice === 'Set Tags…') {
    await vscode.commands.executeCommand('tasksLibrary.editTags', node);
  } else if (choice === 'Set Color…') {
    await vscode.commands.executeCommand('tasksLibrary.editColor', node);
  }
}
