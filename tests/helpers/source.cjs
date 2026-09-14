// Test current source without relying on stale dist. Run tsc --noEmit separately.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();

function source(relative) {
  let filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) throw Error('Source must be inside the project');
  if (!filename.endsWith('.ts')) filename += '.ts';
  if (cache.has(filename)) return cache.get(filename).exports;
  const instance = new Module(filename, module);
  instance.filename = filename;
  cache.set(filename, instance);
  const nativeRequire = Module.createRequire(filename);
  instance.require = (specifier) => {
    if (specifier.startsWith('@moderator/')) {
      return source(`packages/${specifier.slice('@moderator/'.length)}/src/index.ts`);
    }
    if (specifier.startsWith('.')) {
      return source(path.relative(root, path.resolve(path.dirname(filename), specifier)));
    }
    return nativeRequire(specifier);
  };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  });
  instance._compile(compiled.outputText, filename);
  return instance.exports;
}
module.exports = { source };
