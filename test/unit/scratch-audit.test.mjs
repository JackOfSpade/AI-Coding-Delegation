import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchFiles, scratchFilesLine } from '../../src/scratch-audit.mjs';

const created = (...paths) => ({ allFiles: paths.map((path) => ({ path, status: 'A' })) });

test('the files from the real session and other working files are flagged', () => {
  const paths = [
    'electron/_tmp_edit/a.mjs',
    'electron/_tmp_edit/rep.mjs',
    'tmp/x.js',
    'a/.tmp/y',
    '_temp-work/z',
    'scratch/n.py',
    'src/a.js.bak',
    'src/a.js.orig',
    'b.rej',
    'c.tmp',
    'd~',
    'src/tmp_fix.js',
    'scratch.py',
  ];
  assert.deepEqual(scratchFiles(created(...paths)), { total: paths.length, paths });
});

test('ordinary names are not flagged, and only files this job created count', () => {
  const ordinary = [
    'src/template/a.js',
    'src/attempt.js',
    'src/temperature.js',
    'src/context.tmpl',
    'templates/x.md',
    'src/temporal/a.js',
    'docs/scratchpad.md',
    'src/temp-converter/index.js',
    'src/tmp-utils/x.ts',
    'contemp/a.js',
    '.github/dependabot.yml',
  ];
  assert.equal(scratchFiles(created(...ordinary)), undefined);
  assert.equal(
    scratchFiles({
      allFiles: [
        { path: 'tmp/edited.js', status: 'M' },
        { path: 'tmp/gone.js', status: 'D' },
      ],
    }),
    undefined,
  );
  assert.equal(scratchFiles({}), undefined);
  assert.equal(scratchFiles(undefined), undefined);
});

test('the list is bounded and the warning counts what it leaves out', () => {
  const found = created(...Array.from({ length: 25 }, (_, index) => `tmp/${index}.js`));
  assert.equal(scratchFiles(found).paths.length, 20);
  assert.equal(scratchFiles(found).total, 25);
  assert.match(
    scratchFilesLine(found),
    /^possible worker scratch files created by this job \(25\): tmp\/0\.js.*\(\+5 more\); they integrate/,
  );
  assert.equal(scratchFilesLine({ ...found, mode: 'report' }), '');
  assert.equal(scratchFilesLine(created('src/a.js')), '');
  assert.match(
    scratchFilesLine(created('tmp/a'), (path) => `<${path}>`),
    /<tmp\/a>/,
  );
});
