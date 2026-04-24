#!/usr/bin/env node
// Post-processes dist/src/content/content.js to be pure ASCII
// by replacing any non-ASCII characters with \uXXXX escape sequences.
// Chrome's extension loader rejects content scripts with non-ASCII bytes
// even when the file is technically valid UTF-8.

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'dist', 'src', 'content', 'content.js');

if (!fs.existsSync(target)) {
  console.log('ascii-safe: content.js not found, skipping');
  process.exit(0);
}

const original = fs.readFileSync(target, 'utf-8');
let replaced = 0;

const safe = original.replace(/[^\x00-\x7F]/g, (ch) => {
  replaced++;
  const cp = ch.codePointAt(0);
  return cp <= 0xffff
    ? '\\u' + cp.toString(16).padStart(4, '0')
    : '\\u{' + cp.toString(16) + '}';
});

fs.writeFileSync(target, safe, 'utf-8');
console.log(`ascii-safe: escaped ${replaced} non-ASCII chars in content.js (${original.length} → ${safe.length} bytes)`);
