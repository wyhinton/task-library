import * as assert from 'assert';
import { findPlaceholders, substitutePlaceholders } from '../../placeholders';

describe('findPlaceholders', () => {
  it('finds a simple placeholder', () => {
    const found = findPlaceholders({ command: 'echo {{NAME}}' });
    assert.deepStrictEqual(found, [{ name: 'NAME', defaultValue: undefined }]);
  });

  it('captures an inline default value', () => {
    const found = findPlaceholders({ command: 'docker compose up {{SERVICE:web}}' });
    assert.deepStrictEqual(found, [{ name: 'SERVICE', defaultValue: 'web' }]);
  });

  it('dedupes repeated placeholders and keeps the first default seen', () => {
    const found = findPlaceholders(['{{PORT:3000}}', '{{PORT}}']);
    assert.deepStrictEqual(found, [{ name: 'PORT', defaultValue: '3000' }]);
  });

  it('returns an empty array when there are no placeholders', () => {
    assert.deepStrictEqual(findPlaceholders({ command: 'npm test' }), []);
  });

  it('walks nested objects and arrays', () => {
    const found = findPlaceholders({ options: { env: { HOST: '{{HOST}}' } }, args: ['{{FLAG}}'] });
    const names = found.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['FLAG', 'HOST']);
  });
});

describe('substitutePlaceholders', () => {
  it('replaces values across nested objects and arrays', () => {
    const def = { command: '{{CMD}}', args: ['--port', '{{PORT}}'] };
    const result = substitutePlaceholders(
      def,
      new Map([
        ['CMD', 'serve'],
        ['PORT', '8080'],
      ])
    );
    assert.deepStrictEqual(result, { command: 'serve', args: ['--port', '8080'] });
  });

  it('falls back to the inline default when no value is supplied', () => {
    const result = substitutePlaceholders({ command: '{{SERVICE:web}}' }, new Map());
    assert.deepStrictEqual(result, { command: 'web' });
  });

  it('leaves the placeholder untouched when there is no value and no default', () => {
    const result = substitutePlaceholders({ command: '{{MYSTERY}}' }, new Map());
    assert.deepStrictEqual(result, { command: '{{MYSTERY}}' });
  });

  it('does not mutate the original definition', () => {
    const def = { command: '{{CMD}}' };
    substitutePlaceholders(def, new Map([['CMD', 'build']]));
    assert.strictEqual(def.command, '{{CMD}}');
  });
});
