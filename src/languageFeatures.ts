import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { TaskLibrary } from './library';
import { computeLabel } from './types';
import { detectFormatting, mergeInputsIntoText, taskAtOffset } from './tasksJson';

/**
 * In-editor smarts for tasks.json beyond the code lenses:
 *  - completions inside the `tasks` array that expand to full library tasks
 *  - hovers showing library metadata for tasks that are in the library
 *  - lightbulb actions: add to library / update library / replace with library version
 */

export class LibraryCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly library: TaskLibrary) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const enabled = vscode.workspace
      .getConfiguration('tasksLibrary')
      .get<boolean>('completion.enabled', true);
    if (!enabled) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const location = jsonc.getLocation(text, offset);
    // Only directly inside the tasks array (['tasks'] or ['tasks', <index>]),
    // not nested inside an existing task's properties.
    if (location.path[0] !== 'tasks' || location.path.length > 2 || location.isAtPropertyKey) {
      return undefined;
    }

    return this.library.all().map((task) => {
      const item = new vscode.CompletionItem(task.label, vscode.CompletionItemKind.Snippet);
      item.detail = 'Task Library';
      item.filterText = [task.label, ...(task.tags ?? [])].join(' ');
      const doc = new vscode.MarkdownString(undefined, true);
      if (task.description) {
        doc.appendMarkdown(`${task.description}\n\n`);
      }
      doc.appendCodeblock(JSON.stringify(task.definition, null, 2), 'json');
      item.documentation = doc;
      // SnippetString.appendText escapes snippet syntax; VS Code re-indents
      // the tab-indented lines to match the drop location.
      const snippet = new vscode.SnippetString();
      snippet.appendText(JSON.stringify(task.definition, null, '\t'));
      item.insertText = snippet;
      if (task.inputs?.length) {
        item.command = {
          command: 'tasksLibrary._mergeTaskInputs',
          title: 'Merge task inputs',
          arguments: [document.uri, task.id],
        };
      }
      return item;
    });
  }
}

/** After a completion inserted a task, append the ${input:...} definitions it needs. */
export async function mergeTaskInputsIntoDocument(
  library: TaskLibrary,
  uri: vscode.Uri,
  taskId: string
): Promise<void> {
  const task = library.byId(taskId);
  if (!task?.inputs?.length) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const merged = mergeInputsIntoText(text, task.inputs, detectFormatting(text));
  if (merged === text) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(text.length)),
    merged
  );
  await vscode.workspace.applyEdit(edit);
}

export class LibraryHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly library: TaskLibrary
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const text = document.getText();
    const found = taskAtOffset(text, document.offsetAt(position));
    if (!found) {
      return undefined;
    }
    const label = computeLabel(found.def);
    const task = this.library.findByLabel(label);
    if (!task) {
      return undefined;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`$(library) **${task.label}** — in your Task Library\n\n`);
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
    if (meta.length) {
      md.appendMarkdown(meta.join(' • ') + '\n\n');
    }
    const same = JSON.stringify(task.definition) === JSON.stringify(found.def);
    md.appendMarkdown(
      same
        ? '$(check) Identical to the library version\n\n'
        : '$(diff-modified) Differs from the library version\n\n'
    );
    md.appendMarkdown(
      `[Preview](command:tasksLibrary.previewTask?${encodeURIComponent(JSON.stringify([task.id]))})`
    );
    if (!same) {
      md.appendMarkdown(
        ` · [Compare](command:tasksLibrary.compareWithWorkspace?${encodeURIComponent(
          JSON.stringify([task.id, document.uri.toString()])
        )})`
      );
    }
    return new vscode.Hover(md);
  }
}

export class LibraryCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly library: TaskLibrary) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] | undefined {
    const text = document.getText();
    const offset = document.offsetAt(range.start);
    const found = taskAtOffset(text, offset);
    if (!found) {
      return undefined;
    }
    const label = computeLabel(found.def);
    const existing = this.library.findByLabel(label);
    const actions: vscode.CodeAction[] = [];

    if (!existing) {
      const add = new vscode.CodeAction('Add to Task Library', vscode.CodeActionKind.QuickFix);
      add.command = {
        command: 'tasksLibrary.addFromEditor',
        title: add.title,
        arguments: [document.uri, offset],
      };
      actions.push(add);
      return actions;
    }

    if (JSON.stringify(existing.definition) !== JSON.stringify(found.def)) {
      const update = new vscode.CodeAction(
        'Update Task Library from this task',
        vscode.CodeActionKind.QuickFix
      );
      update.command = {
        command: 'tasksLibrary.addFromEditor',
        title: update.title,
        arguments: [document.uri, offset],
      };
      actions.push(update);

      const replace = new vscode.CodeAction(
        'Replace with Task Library version',
        vscode.CodeActionKind.QuickFix
      );
      replace.edit = this.replaceEdit(document, text, found.index, existing.definition);
      actions.push(replace);
    }
    return actions;
  }

  private replaceEdit(
    document: vscode.TextDocument,
    text: string,
    index: number,
    definition: Record<string, unknown>
  ): vscode.WorkspaceEdit {
    const edits = jsonc.modify(text, ['tasks', index], definition, {
      formattingOptions: detectFormatting(text),
    });
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) {
      we.replace(
        document.uri,
        new vscode.Range(document.positionAt(e.offset), document.positionAt(e.offset + e.length)),
        e.content
      );
    }
    return we;
  }
}
