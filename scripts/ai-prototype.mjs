import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const modelId = 'laskar-ks/toxic-guardrail-minilm-id-en';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache', 'ai-prototype');
const manifestFile = path.join(directory, 'manifest.json');
const command = process.argv[2];
const require = createRequire(import.meta.url);

async function packageMetadata(name) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return metadata;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package metadata: ${name}`);
    directory = parent;
  }
}

async function checkRuntimeVersions() {
  // Check metadata before native imports: incompatible runtimes can crash the process.
  const transformers = await packageMetadata('@huggingface/transformers');
  const runtime = await packageMetadata('onnxruntime-node');
  if (transformers.version !== '3.8.1' || runtime.version !== '1.21.0') {
    throw new Error(
      `Incompatible prototype dependencies: Transformers.js ${transformers.version}, ONNX Runtime ${runtime.version}. ` +
        'Run npm install --save-dev --save-exact @huggingface/transformers@3.8.1 onnxruntime-node@1.21.0',
    );
  }
}

async function fetchResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return response;
}

async function download() {
  const info = await (await fetchResponse(`https://huggingface.co/api/models/${modelId}`)).json();
  if (!/^[a-f0-9]{40}$/.test(info.sha)) throw new Error('Invalid model revision.');
  const available = new Set(info.siblings.map((entry) => entry.rfilename));
  const files = [
    'model.int8.onnx',
    'old2new.bin',
    'guardrail_meta.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'config.json',
    'README.md',
  ];
  for (const optional of ['special_tokens_map.json', 'added_tokens.json']) {
    if (available.has(optional)) files.push(optional);
  }
  for (const name of files) {
    if (!available.has(name)) throw new Error(`Required artifact missing: ${name}`);
  }
  const artifactDirectory = path.join(directory, info.sha);
  await mkdir(artifactDirectory, { recursive: true });
  for (const name of files) {
    console.log(`Downloading ${name}`);
    const response = await fetchResponse(
      `https://huggingface.co/${modelId}/resolve/${info.sha}/${name}`,
    );
    const destination = path.join(artifactDirectory, name);
    await writeFile(`${destination}.partial`, Buffer.from(await response.arrayBuffer()));
    await rename(`${destination}.partial`, destination);
  }
  await writeFile(
    manifestFile,
    JSON.stringify({ modelId, revision: info.sha, files }, null, 2) + '\n',
  );
  console.log(`Model ready at revision ${info.sha}`);
}

// Match the model author's preprocessing; do not reinterpret general toxicity as an app category.
function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/g, ' <url> ')
    .replace(/@\w+/g, ' <user> ')
    .replace(/[\n\t]/g, ' ')
    .replace(/USER/g, ' <user> ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function infer() {
  await checkRuntimeVersions();
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.modelId !== modelId || !/^[a-f0-9]{40}$/.test(manifest.revision)) {
    throw new Error('Invalid prototype manifest. Run download again.');
  }
  const artifactDirectory = path.join(directory, manifest.revision);
  const meta = JSON.parse(
    await readFile(path.join(artifactDirectory, 'guardrail_meta.json'), 'utf8'),
  );
  const ratings = Array.from(
    { length: meta.num_labels },
    (_, index) => meta.train_to_rating[String(index)],
  );
  if (
    !Number.isInteger(meta.num_labels) ||
    meta.num_labels < 2 ||
    !Number.isInteger(meta.max_length) ||
    meta.max_length < 2 ||
    !Number.isFinite(meta.temperature) ||
    meta.temperature <= 0 ||
    ratings.some((rating) => !Number.isInteger(rating) || rating < 0 || rating > 4)
  )
    throw new Error('Unsupported model metadata.');
  const buffer = await readFile(path.join(artifactDirectory, 'old2new.bin'));
  if (buffer.length === 0 || buffer.length % 4 !== 0)
    throw new Error('Invalid token remapping artifact.');
  const remap = Array.from({ length: buffer.length / 4 }, (_, index) =>
    buffer.readInt32LE(index * 4),
  );
  const casesFile = path.resolve(root, process.argv[3] ?? 'scripts/ai-prototype-cases.json');
  const cases = JSON.parse(await readFile(casesFile, 'utf8'));
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    cases.some(
      (item) =>
        typeof item.id !== 'string' ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.length > 10_000,
    )
  )
    throw new Error(
      'Cases must be a nonempty array of id/text objects; text limit is 10000 characters.',
    );
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  const ort = await import('onnxruntime-node');
  env.allowRemoteModels = false;
  const started = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(artifactDirectory, {
    local_files_only: true,
  });
  const session = await ort.InferenceSession.create(
    path.join(artifactDirectory, 'model.int8.onnx'),
    {
      executionProviders: ['cpu'],
    },
  );
  const loadMs = performance.now() - started;
  const results = [];
  try {
    for (const item of cases) {
      const inferenceStarted = performance.now();
      const text = normalize(item.text);
      const fullIds = tokenizer.encode(text);
      const encoded = await tokenizer(text, { truncation: true, max_length: meta.max_length });
      const ids = BigInt64Array.from(encoded.input_ids.data, (value) => {
        const index = Number(value);
        const mapped = remap[index];
        if (!Number.isInteger(index) || !Number.isInteger(mapped) || mapped < 0) {
          throw new Error('Token remapping failed.');
        }
        return BigInt(mapped);
      });
      const feeds = {
        input_ids: new ort.Tensor('int64', ids, encoded.input_ids.dims),
        attention_mask: new ort.Tensor(
          'int64',
          BigInt64Array.from(encoded.attention_mask.data),
          encoded.attention_mask.dims,
        ),
      };
      if (session.inputNames.some((name) => !(name in feeds)))
        throw new Error('Unsupported ONNX input signature.');
      const outputs = await session.run(feeds);
      const logits = outputs.logits;
      if (!logits || logits.data.length !== meta.num_labels)
        throw new Error('Unsupported ONNX output signature.');
      const scaled = Array.from(logits.data, (value) => Number(value) / meta.temperature);
      if (scaled.some((value) => !Number.isFinite(value)))
        throw new Error('Nonfinite model output.');
      const maximum = Math.max(...scaled);
      const exp = scaled.map((value) => Math.exp(value - maximum));
      const sum = exp.reduce((total, value) => total + value, 0);
      const probabilities = exp.map((value) => value / sum);
      const index = probabilities.indexOf(Math.max(...probabilities));
      results.push({
        ...item,
        rating: ratings[index],
        label: meta.rating_label?.[String(ratings[index])] ?? String(ratings[index]),
        severity_score:
          probabilities.reduce((total, value, i) => total + value * ratings[i], 0) / 4,
        probabilities: probabilities.map((value, i) => ({ rating: ratings[i], value })),
        truncated: fullIds.length > meta.max_length,
        inference_ms: performance.now() - inferenceStarted,
      });
    }
  } finally {
    await session.release();
  }
  const reportFile = path.join(directory, `results-${Date.now()}.json`);
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        model_id: modelId,
        revision: manifest.revision,
        variant: 'INT8',
        runtime: process.version,
        load_ms: loadMs,
        count: results.length,
        note: 'Exploratory results only. Severity score is not an application violation probability. No moderation actions were sent.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.table(
    results.map(({ id, rating, label, severity_score, inference_ms, truncated }) => ({
      id,
      rating,
      label,
      severity_score: severity_score.toFixed(4),
      inference_ms: inference_ms.toFixed(1),
      truncated,
    })),
  );
  console.log(`Load time: ${loadMs.toFixed(1)} ms; results: ${reportFile}`);
}

try {
  if (command === 'download') await download();
  else if (command === 'run') await infer();
  else throw new Error('Usage: node scripts/ai-prototype.mjs download | run [cases.json]');
} catch (error) {
  console.error('AI prototype failed:', error.message);
  process.exitCode = 1;
}
