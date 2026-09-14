import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);

if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));

const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

if (parsed.errors.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );

const host = {
  ...ts.sys,
  getCompilationSettings: () => parsed.options,
  getScriptFileNames: () => parsed.fileNames,
  getScriptVersion: () => '0',
  getScriptSnapshot: (file) => {
    const text = ts.sys.readFile(file);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => root,
  getDefaultLibFileName: ts.getDefaultLibFilePath,
};

const service = ts.createLanguageService(host);
let changed = 0;

try {
  for (const file of parsed.fileNames.filter((file) => !file.endsWith('.d.ts'))) {
    const edits = service.organizeImports(
      { type: 'file', fileName: file, mode: ts.OrganizeImportsMode.SortAndCombine },
      { newLineCharacter: '\n' },
      {},
    );
    if (!edits.length || !edits.some((edit) => edit.textChanges.length)) continue;
    const original = fs.readFileSync(file, 'utf8');
    let updated = original;
    for (const edit of edits) {
      for (const change of [...edit.textChanges].sort((a, b) => b.span.start - a.span.start)) {
        updated =
          updated.slice(0, change.span.start) +
          change.newText +
          updated.slice(change.span.start + change.span.length);
      }
    }
    updated = await prettier.format(updated, {
      ...(await prettier.resolveConfig(file)),
      filepath: file,
    });
    if (original === updated) continue;
    changed++;
    console.log(path.relative(root, file));
    if (!process.argv.includes('--check')) fs.writeFileSync(file, updated);
  }
} finally {
  service.dispose();
}

if (changed && process.argv.includes('--check')) process.exitCode = 1;
