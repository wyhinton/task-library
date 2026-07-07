# Task Library

Stop recreating the same tasks in every project's `.vscode/tasks.json`. **Task Library** lets you publish tasks to a personal (or shared) library, organize them with groups / tags / colors, run them from anywhere, and pull them into any workspace with one click.

## Features

### Capture tasks from any tasks.json

Open a `.vscode/tasks.json` and every task gets an inline code lens:

- **➕ Add to Task Library** — task isn't in your library yet
- **🔄 Update in Task Library** — the task is in your library but the definition changed
- **🔀 Compare with library** — shown alongside *Update* so you can inspect the drift first
- **✓ In Task Library** — already saved and identical (click to preview)

There's also an **Add all N tasks to Task Library** lens at the top of the `tasks` array, plus a **Task Library: Import Tasks from Workspace…** command that scans every `tasks.json` in your workspace and lets you multi-select what to import.

Tasks that reference `${input:...}` variables automatically carry their matching `inputs` definitions with them.

### Generate tasks from project files

**Task Library: Generate Tasks from Project Files…** scans the root of each workspace folder and scaffolds ready-made tasks from what it finds:

| Source | Generated tasks |
| --- | --- |
| `package.json` | one `npm` task per script |
| `Makefile` | `make <target>` shell task per target |
| `docker-compose.yml` / `compose.yaml` | `docker compose up <service>` per service (plus plain `up`) |
| `Cargo.toml` | `cargo build / run / test / clippy / fmt` |

Multi-select what you want, then send it to the library, straight into the workspace `tasks.json`, or both. Generated tasks are auto-tagged with their tool (`npm`, `make`, `docker`, `cargo`).

### Save a terminal command as a task

**Task Library: Save Terminal Command as Task…** wraps a shell command in a `shell` task and publishes it to the library. On VS Code 1.93+ with shell integration, the input is pre-filled with the last command you ran in the active terminal — most real-world tasks start life as a command typed by hand.

### Run tasks straight from the library

Every task in the tree has a ▶ button (also in the preview panel and context menu) — no need to insert it into a `tasks.json` first. The runner:

- prompts for any `${input:...}` values using the input definitions carried with the task (`promptString` and `pickString` are fully supported),
- prompts for `{{placeholder}}` values (see *Template placeholders* below),
- resolves common variables like `${workspaceFolder}`, `${file}`, `${userHome}`,
- honors platform overrides (`windows` / `linux` / `osx` blocks), `options.cwd/env/shell`, `problemMatcher`, and `presentation`.

`shell`, `process`, and `npm` tasks run ad-hoc. Other types (gulp, custom providers, …) fall back to a matching workspace task, or an offer to insert first.

### Quick Open launcher — `Ctrl+Alt+T`

**Task Library: Quick Open Task…** (`Ctrl+Alt+T` / `Cmd+Alt+T`) is a fuzzy launcher over the whole library — pinned tasks first, then most recently used. **Enter runs the task**; the inline buttons insert it into the workspace or open the preview.

### Pins & the status bar

Right-click → **Pin Task** to surface a task in:

- a **Pinned** section at the top of the tree (drag tasks onto it to pin them), and
- the **status bar**, as a one-click `▶ label` run button colored with the task's library color (up to `tasksLibrary.statusBar.maxItems`, default 3).

### Organize: groups, tags, colors, descriptions — now with multi-select

Right-click any task in the **Task Library** view (activity bar icon):

- **Set Group…** — tasks are shown nested under group folders in the tree
- **Set Tags…** — comma-separated tags, shown next to the task and filterable via the funnel icon
- **Set Color…** — colors the task's icon in the tree and its status bar pin
- **Set Description…** — free-text note shown in the preview and tooltip

The tree supports **multi-select** (Ctrl/Shift-click): set group/tags/color, insert, export, copy JSON, or delete many tasks at once.

**Drag & drop** works too: drag tasks onto a group to move them, onto the empty area to ungroup, onto the Pinned section to pin — or **drop them into a tasks.json editor** to insert them (comment-preserving, inputs merged, duplicates skipped). Dropping into any other editor pastes the JSON.

**Sorting:** the view's overflow menu (`⋯` → *Sort Tasks By…*) offers name, recently used, most used, or recently added — powered by per-task usage tracking (insert/run counts shown in tooltips and the preview).

### Preview

Click any task in the tree to open a preview panel showing its metadata, usage stats, dependencies, and full JSON, with **Run**, **Add to workspace tasks.json**, and **Copy JSON** buttons. Tree tooltips also show the task's JSON inline.

### Pull tasks into a project — with guardrails

- Click the **+** icon on a task (or group) in the tree, use the preview panel button, or run **Task Library: Add to Workspace tasks.json** from the command palette.
- Creates `.vscode/tasks.json` if it doesn't exist; otherwise edits are **comment-preserving** and match the file's existing indentation.
- Label collisions prompt you to **Overwrite** or **Add as Copy**; referenced `inputs` are merged in automatically.
- **Preflight checks** (disable with `tasksLibrary.preflight.enabled`) warn *before* inserting when the task's command isn't on PATH, a `${workspaceFolder}` path or the working directory doesn't exist, or a carried input id clashes with a different existing one — catching "works on my machine" at the door.
- **`dependsOn` awareness:** if the task depends on tasks that aren't in the target `tasks.json`, you're offered to insert the ones your library has (recursively, cycle-safe) and warned about dangling ones.

### Template placeholders

Use `{{NAME}}` or `{{NAME:default}}` anywhere in a stored task definition:

```jsonc
{ "label": "serve {{SERVICE_NAME}}", "type": "shell", "command": "docker compose up {{SERVICE_NAME:web}}" }
```

You're prompted for values when the task is **inserted** into a workspace or **run** from the library — the library keeps the template. Unlike `${input:...}` (which prompts on every run from tasks.json), placeholders are baked in at insert time, so one library task can cover many similar projects.

### Compare / diff drifted tasks

When a workspace copy of a task has drifted from the library version (`~` badge in the tree), use **Compare with Workspace tasks.json** (context menu, code lens, or hover link) to open a real diff editor — workspace on the left, library on the right — before overwriting either side.

### tasks.json editor smarts

Beyond the code lenses, inside any `tasks.json`:

- **Completions** — trigger IntelliSense inside the `tasks` array and library tasks expand to their full definition (referenced `inputs` are merged in automatically after insertion). Disable with `tasksLibrary.completion.enabled`.
- **Hovers** — hovering a task that's in your library shows its description, tags, group, and whether it matches the library version, with Preview / Compare links.
- **Code actions** (lightbulb) — *Add to Task Library*, *Update Task Library from this task*, and *Replace with Task Library version*.

### Share the library

By default the library lives in a private JSON file in the extension's global storage. To publish/share it, set:

```jsonc
// settings.json
"tasksLibrary.libraryFile": "D:/Dropbox/dev/task-library.json"
// or a file in a dotfiles repo, network share, etc. (~ is supported)
```

The file is watched, so edits from other machines/teammates show up live. The file is plain JSON — commit it, sync it, review it in PRs.

**Multiple libraries:** add read/write side libraries (e.g. a shared team file next to your personal one) via:

```jsonc
"tasksLibrary.extraLibraryFiles": ["//server/share/team-tasks.json"]
```

Tasks show a source badge in the tree; edits are written back to the file the task came from. New tasks always land in the primary library.

**Import & export without infrastructure:**

- **Export Tasks…** — multi-select tasks and save them to a JSON file or copy to the clipboard (personal state like pins and usage counters is stripped).
- **Import Tasks from URL…** — fetch a library export, a plain `tasks.json`, or a **GitHub gist** URL; pick which tasks to merge in, and choose once whether collisions overwrite or skip.
- **Import Tasks from File…** — same, from a local file.

### Snapshots (library undo)

Before library writes, a safety copy of the file is stored (throttled to one per 5 minutes; bulk imports always snapshot first). **Task Library: Restore Library from Snapshot…** lists them with timestamps and task counts and restores one — the pre-restore state is snapshotted too, so restores are undoable. Keep more or fewer with `tasksLibrary.snapshots.keep`.

## Commands

| Command | What it does |
| --- | --- |
| `Task Library: Quick Open Task…` (`Ctrl+Alt+T`) | Fuzzy launcher — Enter runs, buttons insert/preview |
| `Task Library: Run Task` | Run a library task directly |
| `Task Library: Add to Workspace tasks.json` | Insert a task (placeholders → preflight → dependsOn) |
| `Task Library: Import Tasks from Workspace…` | Scan workspace tasks.json files and multi-select |
| `Task Library: Generate Tasks from Project Files…` | Scaffold from package.json / Makefile / compose / Cargo.toml |
| `Task Library: Save Terminal Command as Task…` | Wrap a shell command (pre-filled from the terminal) |
| `Task Library: Import Tasks from URL… / File…` | Merge tasks from a URL, gist, or file |
| `Task Library: Export Tasks…` | Save/copy a selection of tasks for sharing |
| `Task Library: Sort Tasks By…` | Name / recently used / most used / recently added |
| `Task Library: Restore Library from Snapshot…` | Roll the library file back to a safety copy |
| `Task Library: Open Library File` | Open the primary library JSON |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tasksLibrary.libraryFile` | `""` | Path to the primary library JSON file. Empty = private global storage. |
| `tasksLibrary.extraLibraryFiles` | `[]` | Additional library files (e.g. a team library); tasks keep their source. |
| `tasksLibrary.codeLens.enabled` | `true` | Show the code lenses in tasks.json files. |
| `tasksLibrary.completion.enabled` | `true` | Suggest library tasks as completions in tasks.json. |
| `tasksLibrary.preflight.enabled` | `true` | Warn before inserting tasks that look broken for this workspace. |
| `tasksLibrary.sortBy` | `"name"` | Tree sort order: `name`, `recentlyUsed`, `mostUsed`, `recentlyAdded`. |
| `tasksLibrary.snapshots.keep` | `10` | Automatic library snapshots kept per library file. |
| `tasksLibrary.statusBar.enabled` | `true` | Show pinned tasks as status bar run buttons. |
| `tasksLibrary.statusBar.maxItems` | `3` | Maximum pinned tasks in the status bar. |

## Development

```sh
npm install
npm run compile   # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### Testing

The test suite covers the pure logic modules (label computation, `{{placeholder}}` parsing/substitution, tasks.json parsing/merging helpers) plus a `TaskLibrary` CRUD integration test and an extension-activation smoke test, using the standard [`@vscode/test-electron`](https://github.com/microsoft/vscode-test) harness (Mocha, real VS Code API).

```sh
npm test
```

The first run downloads a copy of VS Code into `.vscode-test/` to host the tests. Alternatively, use the **Extension Tests** launch config (`F5` → select it from the dropdown) to run and debug tests inside VS Code. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the suite on Linux, Windows, and macOS on every push/PR.

To package a `.vsix` (installable via *Extensions: Install from VSIX…*):

```sh
npx @vscode/vsce package
```

> Note: change the `publisher` field in `package.json` to your own Marketplace publisher id before publishing.
