import * as vscode from 'vscode';
import { TaskLibrary } from './library';
import { LibraryTask, computeLabel } from './types';
import { addDefinitionToLibrary } from './capture';
import { upsertTaskInWorkspace, readFileText } from './tasksJson';

/**
 * Scaffolds tasks from files the project already has — package.json scripts,
 * Makefile targets, docker-compose services, Cargo.toml — and adds the chosen
 * ones to the library and/or the workspace tasks.json.
 */

interface GeneratedTask {
  def: Record<string, unknown>;
  /** Tool tag, e.g. "npm", "make" — becomes a library tag. */
  tool: string;
  /** Workspace-relative file it was derived from (quick pick separator). */
  origin: string;
  folder: vscode.WorkspaceFolder;
}

export async function generateFromProject(library: TaskLibrary): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Task Library: open a folder to generate tasks from it.');
    return;
  }

  const generated: GeneratedTask[] = [];
  for (const folder of folders) {
    generated.push(...(await fromPackageJson(folder)));
    generated.push(...(await fromMakefile(folder)));
    generated.push(...(await fromDockerCompose(folder)));
    generated.push(...(await fromCargoToml(folder)));
  }
  if (!generated.length) {
    vscode.window.showInformationMessage(
      'Task Library: no package.json scripts, Makefile targets, docker-compose services, or Cargo.toml found at the root of the workspace folder(s).'
    );
    return;
  }

  interface Pick extends vscode.QuickPickItem {
    gen?: GeneratedTask;
  }
  const items: Pick[] = [];
  let lastOrigin = '';
  for (const gen of generated) {
    if (gen.origin !== lastOrigin) {
      items.push({ label: gen.origin, kind: vscode.QuickPickItemKind.Separator });
      lastOrigin = gen.origin;
    }
    const label = computeLabel(gen.def);
    items.push({
      label,
      description: gen.tool,
      picked: !library.findByLabel(label),
      gen,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select tasks to generate',
    title: 'Task Library: Generate Tasks from Project Files',
  });
  if (!picked?.length) {
    return;
  }
  const chosen = picked.map((p) => p.gen!).filter(Boolean);

  const destination = await vscode.window.showQuickPick(
    [
      { label: '$(library) Add to Task Library', dest: 'library' as const },
      { label: '$(file-code) Add to workspace tasks.json', dest: 'workspace' as const },
      { label: '$(files) Both', dest: 'both' as const },
    ],
    { placeHolder: `Where should the ${chosen.length} generated task(s) go?` }
  );
  if (!destination) {
    return;
  }

  let toLibrary = 0;
  let toWorkspace = 0;
  for (const gen of chosen) {
    if (destination.dest !== 'workspace') {
      const result = await addDefinitionToLibrary(library, gen.def, [], {
        interactive: false,
        meta: { tags: [gen.tool] },
      });
      if (result === 'added' || result === 'updated') {
        toLibrary++;
      }
    }
    if (destination.dest !== 'library') {
      const pseudo: LibraryTask = {
        id: 'generated',
        label: computeLabel(gen.def),
        definition: gen.def,
        createdAt: '',
        updatedAt: '',
      };
      if (await upsertTaskInWorkspace(gen.folder, pseudo, { silent: true })) {
        toWorkspace++;
      }
    }
  }
  const parts: string[] = [];
  if (destination.dest !== 'workspace') {
    parts.push(`${toLibrary} added/updated in the library`);
  }
  if (destination.dest !== 'library') {
    parts.push(`${toWorkspace} written to tasks.json`);
  }
  vscode.window.showInformationMessage(`Task Library: ${parts.join(', ')}.`);
}

// --- generators ------------------------------------------------------------------

async function rootFileText(
  folder: vscode.WorkspaceFolder,
  ...names: string[]
): Promise<{ name: string; text: string } | undefined> {
  for (const name of names) {
    const text = await readFileText(vscode.Uri.joinPath(folder.uri, name));
    if (text !== undefined) {
      return { name, text };
    }
  }
  return undefined;
}

function origin(folder: vscode.WorkspaceFolder, name: string): string {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1
    ? `${folder.name}/${name}`
    : name;
}

async function fromPackageJson(folder: vscode.WorkspaceFolder): Promise<GeneratedTask[]> {
  const file = await rootFileText(folder, 'package.json');
  if (!file) {
    return [];
  }
  let scripts: Record<string, unknown>;
  try {
    const json = JSON.parse(file.text) as Record<string, unknown>;
    scripts = (json.scripts as Record<string, unknown>) ?? {};
  } catch {
    return [];
  }
  return Object.keys(scripts).map((script) => ({
    def: { type: 'npm', script, label: `npm: ${script}`, problemMatcher: [] },
    tool: 'npm',
    origin: origin(folder, 'package.json'),
    folder,
  }));
}

async function fromMakefile(folder: vscode.WorkspaceFolder): Promise<GeneratedTask[]> {
  const file = await rootFileText(folder, 'Makefile', 'makefile', 'GNUmakefile');
  if (!file) {
    return [];
  }
  const targets = new Set<string>();
  for (const line of file.text.split('\n')) {
    // A target line: "name:" not starting with tab/dot, no pattern/variable syntax.
    const m = /^([A-Za-z0-9][A-Za-z0-9_./-]*)\s*:(?!=)/.exec(line);
    if (m && !m[1].includes('%') && !m[1].includes('$')) {
      targets.add(m[1]);
    }
  }
  return [...targets].map((target) => ({
    def: {
      label: `make: ${target}`,
      type: 'shell',
      command: `make ${target}`,
      problemMatcher: [],
    },
    tool: 'make',
    origin: origin(folder, file.name),
    folder,
  }));
}

async function fromDockerCompose(folder: vscode.WorkspaceFolder): Promise<GeneratedTask[]> {
  const file = await rootFileText(
    folder,
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml'
  );
  if (!file) {
    return [];
  }
  const services = composeServices(file.text);
  const out: GeneratedTask[] = services.map((service) => ({
    def: {
      label: `docker compose: up ${service}`,
      type: 'shell',
      command: `docker compose up ${service}`,
      problemMatcher: [],
    },
    tool: 'docker',
    origin: origin(folder, file.name),
    folder,
  }));
  if (services.length) {
    out.push({
      def: {
        label: 'docker compose: up',
        type: 'shell',
        command: 'docker compose up',
        problemMatcher: [],
      },
      tool: 'docker',
      origin: origin(folder, file.name),
      folder,
    });
  }
  return out;
}

/** Naive YAML walk: keys exactly one indent level under a top-level `services:`. */
function composeServices(text: string): string[] {
  const lines = text.split('\n');
  const services: string[] = [];
  let inServices = false;
  let serviceIndent: number | undefined;
  for (const line of lines) {
    if (/^services:\s*(#.*)?$/.test(line)) {
      inServices = true;
      serviceIndent = undefined;
      continue;
    }
    if (!inServices) {
      continue;
    }
    if (/^\S/.test(line)) {
      inServices = false; // next top-level key
      continue;
    }
    const m = /^(\s+)([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(line);
    if (!m) {
      continue;
    }
    if (serviceIndent === undefined) {
      serviceIndent = m[1].length;
    }
    if (m[1].length === serviceIndent) {
      services.push(m[2]);
    }
  }
  return services;
}

async function fromCargoToml(folder: vscode.WorkspaceFolder): Promise<GeneratedTask[]> {
  const file = await rootFileText(folder, 'Cargo.toml');
  if (!file) {
    return [];
  }
  const commands: { name: string; group?: string }[] = [
    { name: 'build', group: 'build' },
    { name: 'run' },
    { name: 'test', group: 'test' },
    { name: 'clippy' },
    { name: 'fmt' },
  ];
  return commands.map(({ name, group }) => ({
    def: {
      label: `cargo: ${name}`,
      type: 'shell',
      command: `cargo ${name}`,
      problemMatcher: ['$rustc'],
      ...(group ? { group } : {}),
    },
    tool: 'cargo',
    origin: origin(folder, 'Cargo.toml'),
    folder,
  }));
}
