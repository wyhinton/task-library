/** A task definition captured into the library, plus library metadata. */
export interface LibraryTask {
  id: string;
  /** Display label, derived from the task definition (label / taskName / "type: script"). */
  label: string;
  /** The raw task object exactly as it appears in a tasks.json `tasks` array. */
  definition: Record<string, unknown>;
  /** Input definitions (from tasks.json `inputs`) referenced by this task via ${input:...}. */
  inputs?: Record<string, unknown>[];
  group?: string;
  tags?: string[];
  /** A VS Code theme color id, e.g. "charts.red". */
  color?: string;
  description?: string;
  /** Pinned tasks surface in the tree's Pinned section and the status bar. */
  pinned?: boolean;
  /** Times this task was inserted into a workspace tasks.json. */
  insertCount?: number;
  /** Times this task was run from the library. */
  runCount?: number;
  /** Last time it was inserted or run (ISO). */
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type SortMode = 'name' | 'recentlyAdded' | 'recentlyUsed' | 'mostUsed';

export interface LibraryFile {
  version: 1;
  tasks: LibraryTask[];
}

export interface TaskColor {
  label: string;
  id?: string;
}

export const TASK_COLORS: TaskColor[] = [
  { label: 'Red', id: 'charts.red' },
  { label: 'Orange', id: 'charts.orange' },
  { label: 'Yellow', id: 'charts.yellow' },
  { label: 'Green', id: 'charts.green' },
  { label: 'Blue', id: 'charts.blue' },
  { label: 'Purple', id: 'charts.purple' },
  { label: 'Foreground', id: 'charts.foreground' },
  { label: 'None', id: undefined },
];

/** Derive the label VS Code would show for a raw task definition. */
export function computeLabel(def: unknown): string {
  const d = def as Record<string, unknown> | undefined;
  if (typeof d?.label === 'string') {
    return d.label;
  }
  if (typeof d?.taskName === 'string') {
    return d.taskName;
  }
  if (typeof d?.type === 'string' && typeof d?.script === 'string') {
    return `${d.type}: ${d.script}`;
  }
  if (typeof d?.command === 'string') {
    return d.command;
  }
  return 'unnamed task';
}
