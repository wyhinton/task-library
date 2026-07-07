import * as assert from 'assert';
import { computeLabel } from '../../types';

describe('computeLabel', () => {
  it('uses label when present', () => {
    assert.strictEqual(computeLabel({ label: 'Build' }), 'Build');
  });

  it('falls back to taskName for legacy 1.0-style tasks', () => {
    assert.strictEqual(computeLabel({ taskName: 'Legacy' }), 'Legacy');
  });

  it('formats "type: script" for npm-style tasks', () => {
    assert.strictEqual(computeLabel({ type: 'npm', script: 'build' }), 'npm: build');
  });

  it('falls back to the raw command', () => {
    assert.strictEqual(computeLabel({ command: 'echo hi' }), 'echo hi');
  });

  it('falls back to "unnamed task" when nothing matches', () => {
    assert.strictEqual(computeLabel({}), 'unnamed task');
    assert.strictEqual(computeLabel(undefined), 'unnamed task');
  });

  it('prefers label over every other field', () => {
    assert.strictEqual(
      computeLabel({ label: 'Custom', taskName: 'Legacy', command: 'echo hi' }),
      'Custom'
    );
  });
});
