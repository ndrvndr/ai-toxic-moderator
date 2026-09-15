import { createHash } from 'node:crypto';

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function matchesMigrationChecksum(sql, expected) {
  if (checksum(sql) === expected) return true;

  const lf = sql.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');

  return checksum(lf) === expected || checksum(crlf) === expected;
}
