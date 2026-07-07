import * as path from 'path';
import Mocha from 'mocha';

const TEST_FILES = [
  'types.test.js',
  'placeholders.test.js',
  'tasksJson.test.js',
  'library.test.js',
  'extension.test.js',
];

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname);

  return new Promise((resolve, reject) => {
    for (const file of TEST_FILES) {
      mocha.addFile(path.join(testsRoot, file));
    }
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
