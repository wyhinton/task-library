import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask } from './types';
import { dependencyLabels } from './tasksJson';
import { WorkspaceStatusInfo, WorkspaceStatusTracker } from './workspaceStatus';

/** Singleton webview panel that previews a library task. */
export class TaskPreviewPanel {
  private static current: TaskPreviewPanel | undefined;

  static show(
    task: LibraryTask,
    workspaceStatus: WorkspaceStatusTracker,
    library: TaskLibrary
  ): void {
    if (TaskPreviewPanel.current) {
      TaskPreviewPanel.current.update(task);
      TaskPreviewPanel.current.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'tasksLibrary.preview',
      'Task Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true }
    );
    TaskPreviewPanel.current = new TaskPreviewPanel(panel, workspaceStatus, library);
    TaskPreviewPanel.current.update(task);
  }

  private task: LibraryTask | undefined;
  private readonly statusListener: vscode.Disposable;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly workspaceStatus: WorkspaceStatusTracker,
    private readonly library: TaskLibrary
  ) {
    panel.onDidDispose(() => {
      this.statusListener.dispose();
      TaskPreviewPanel.current = undefined;
    });
    this.statusListener = workspaceStatus.onDidChange(() => {
      if (this.task) {
        this.update(this.task);
      }
    });
    panel.webview.onDidReceiveMessage(async (msg: { type: string }) => {
      if (!this.task) {
        return;
      }
      if (msg.type === 'run') {
        await vscode.commands.executeCommand('tasksLibrary.runTask', this.task.id);
      } else if (msg.type === 'insert') {
        await vscode.commands.executeCommand('tasksLibrary.insertTask', this.task.id);
      } else if (msg.type === 'copy') {
        await vscode.env.clipboard.writeText(JSON.stringify(this.task.definition, null, 2));
        vscode.window.showInformationMessage(`Copied "${this.task.label}" JSON to clipboard.`);
      }
    });
  }

  update(task: LibraryTask): void {
    this.task = task;
    this.panel.title = `Task: ${task.label}`;
    this.panel.webview.html = this.render(task, this.workspaceStatus.statusFor(task));
  }

  private dependencySection(task: LibraryTask): string {
    const labels = dependencyLabels(task.definition);
    if (!labels.length) {
      return '';
    }
    const rows = labels
      .map((label) => {
        const inLibrary = !!this.library.findByLabel(label);
        const badge = inLibrary
          ? '<span class="dep-ok">✓ in library</span>'
          : '<span class="dep-missing">✗ not in library</span>';
        return `<li><code>${escapeHtml(label)}</code> ${badge}</li>`;
      })
      .join('');
    return `<h3>Depends on</h3>
      <ul class="deps">${rows}</ul>
      <p class="hint">Dependencies in your library are offered automatically when this task is inserted.</p>`;
  }

  private render(task: LibraryTask, status: WorkspaceStatusInfo): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const colorVar = task.color
      ? `var(--vscode-${task.color.replace(/\./g, '-')})`
      : 'var(--vscode-descriptionForeground)';
    const tags = (task.tags ?? [])
      .map((t) => `<span class="chip">#${escapeHtml(t)}</span>`)
      .join('');
    const source = this.library.hasMultipleSources
      ? this.library.sourceOf(task.id)?.name
      : undefined;
    const json = escapeHtml(JSON.stringify(task.definition, null, 2));
    const inputsSection = task.inputs?.length
      ? `<h3>Inputs carried with this task</h3>
         <pre><code>${escapeHtml(JSON.stringify(task.inputs, null, 2))}</code></pre>`
      : '';
    const inserts = task.insertCount ?? 0;
    const runs = task.runCount ?? 0;
    const usage =
      inserts || runs
        ? ` · Inserted ${inserts}× · run ${runs}×${
            task.lastUsedAt ? ` · last used ${escapeHtml(formatDate(task.lastUsedAt))}` : ''
          }`
        : '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 16px 20px;
    max-width: 720px;
  }
  h1 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 1.3em;
    margin: 0 0 4px;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex: none;
    background: ${colorVar};
  }
  .meta {
    color: var(--vscode-descriptionForeground);
    margin: 0 0 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    padding: 1px 9px;
    font-size: 0.85em;
  }
  .desc {
    margin: 0 0 14px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin: 0 0 16px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  h3 {
    margin: 18px 0 6px;
    font-size: 1em;
  }
  .deps {
    margin: 0;
    padding-left: 20px;
  }
  .dep-ok {
    color: var(--vscode-charts-green);
  }
  .dep-missing {
    color: var(--vscode-charts-yellow);
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .timestamps {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    margin-top: 16px;
  }
</style>
</head>
<body>
  <h1><span class="dot"></span>${escapeHtml(task.label)}${task.pinned ? ' 📌' : ''}</h1>
  <div class="meta">
    ${task.group ? `<span>📁 ${escapeHtml(task.group)}</span>` : ''}
    ${source ? `<span>📚 ${escapeHtml(source)}</span>` : ''}
    ${tags}
  </div>
  ${task.description ? `<p class="desc">${escapeHtml(task.description)}</p>` : ''}
  <div class="actions">
    <button id="run">▶ Run</button>
    <button id="insert" class="secondary">Add to workspace tasks.json</button>
    <button id="copy" class="secondary">Copy JSON</button>
  </div>
  <h3>Task definition</h3>
  <pre><code>${json}</code></pre>
  ${this.dependencySection(task)}
  ${inputsSection}
  <div class="timestamps">
    Added ${escapeHtml(formatDate(task.createdAt))} · Updated ${escapeHtml(formatDate(task.updatedAt))}${usage}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
    document.getElementById('insert').addEventListener('click', () => vscode.postMessage({ type: 'insert' }));
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  </script>
</body>
</html>`;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
