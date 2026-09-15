const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const modulePromise = import('../scripts/migration-checksum.mjs');

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('accepts an unchanged migration', async () => {
  const { matchesMigrationChecksum } = await modulePromise;
  const sql = 'SELECT 1;\n';

  assert.equal(matchesMigrationChecksum(sql, checksum(sql)), true);
});

test('accepts LF and CRLF equivalents in either direction', async () => {
  const { matchesMigrationChecksum } = await modulePromise;
  const lf = '-- Migration\nSELECT 1;\n';
  const crlf = lf.replace(/\n/g, '\r\n');

  assert.equal(matchesMigrationChecksum(lf, checksum(crlf)), true);
  assert.equal(matchesMigrationChecksum(crlf, checksum(lf)), true);
});

test('rejects SQL changes even when line endings also change', async () => {
  const { matchesMigrationChecksum } = await modulePromise;
  const original = '-- Migration\r\nSELECT 1;\r\n';
  const modified = '-- Migration\nSELECT 2;\n';

  assert.equal(matchesMigrationChecksum(modified, checksum(original)), false);
});

test('rejects comment, whitespace and trailing newline changes', async () => {
  const { matchesMigrationChecksum } = await modulePromise;
  const original = '-- Migration\nSELECT 1;\n';

  for (const modified of [
    '-- Changed comment\nSELECT 1;\n',
    '-- Migration\nSELECT  1;\n',
    '-- Migration\nSELECT 1;',
    '-- Migration\nSELECT 1;\n\n',
  ]) {
    assert.equal(matchesMigrationChecksum(modified, checksum(original)), false);
  }
});
