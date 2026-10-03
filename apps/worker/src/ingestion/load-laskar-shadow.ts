import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { LASKAR_MODEL_ID, LaskarShadowAdapter, remapLaskarTokens } from './laskar-shadow-adapter';

const localRequire = createRequire(__filename);

async function packageVersion(name: string): Promise<string> {
  let directory = path.dirname(localRequire.resolve(name));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Dependency metadata unavailable.');
    directory = parent;
  }
}

// Explicit startup only. Importing this module does not load native code or download artifacts.
export async function loadLaskarShadow(cacheDirectory: string): Promise<LaskarShadowAdapter> {
  const manifest = JSON.parse(await readFile(path.join(cacheDirectory, 'manifest.json'), 'utf8'));
  if (
    manifest.modelId !== LASKAR_MODEL_ID ||
    typeof manifest.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.revision)
  ) {
    throw new Error('Invalid local AI manifest.');
  }
  const directory = path.resolve(cacheDirectory, manifest.revision);
  const meta = JSON.parse(await readFile(path.join(directory, 'guardrail_meta.json'), 'utf8'));
  if (
    meta.num_labels !== 4 ||
    !Number.isInteger(meta.max_length) ||
    meta.max_length < 2 ||
    meta.max_length > 512 ||
    !Number.isFinite(meta.temperature) ||
    meta.temperature <= 0 ||
    !Number.isInteger(meta.vocab_kept) ||
    meta.vocab_kept <= 0 ||
    !Number.isInteger(meta.vocab_original) ||
    meta.vocab_original <= 0 ||
    meta.vocab_original > 1_000_000 ||
    [0, 2, 3, 4].some((rating, i) => meta.train_to_rating?.[String(i)] !== rating)
  ) {
    throw new Error('Unsupported local AI metadata.');
  }
  const buffer = await readFile(path.join(directory, 'old2new.bin'));
  if (buffer.length !== meta.vocab_original * 4)
    throw new Error('Invalid token remapping artifact.');
  const remap = Int32Array.from({ length: buffer.length / 4 }, (_, i) => buffer.readInt32LE(i * 4));
  if (remap.some((value) => value < 0 || value >= meta.vocab_kept))
    throw new Error('Invalid remapped token ID.');
  if (
    (await packageVersion('@huggingface/transformers')) !== '3.8.1' ||
    (await packageVersion('onnxruntime-node')) !== '1.21.0'
  ) {
    throw new Error('AI requires Transformers.js 3.8.1 and ONNX Runtime 1.21.0.');
  }
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  const ort = await import('onnxruntime-node');
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const session = await ort.InferenceSession.create(path.join(directory, 'model.int8.onnx'), {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  try {
    if (
      session.inputNames.length !== 2 ||
      !session.inputNames.includes('input_ids') ||
      !session.inputNames.includes('attention_mask') ||
      !session.outputNames.includes('logits')
    ) {
      throw new Error('Unsupported AI model signature.');
    }
    return new LaskarShadowAdapter(
      {
        async infer(text) {
          const fullIds = tokenizer.encode(text);
          const encoded = await tokenizer(text, { truncation: true, max_length: meta.max_length });
          if (
            !(encoded.input_ids.data instanceof BigInt64Array) ||
            !(encoded.attention_mask.data instanceof BigInt64Array)
          ) {
            throw new Error('Unsupported AI token format.');
          }
          const output = await session.run({
            input_ids: new ort.Tensor(
              'int64',
              remapLaskarTokens(encoded.input_ids.data, remap),
              encoded.input_ids.dims,
            ),
            attention_mask: new ort.Tensor(
              'int64',
              encoded.attention_mask.data,
              encoded.attention_mask.dims,
            ),
          });
          const logits = output.logits;
          if (
            !logits ||
            !(logits.data instanceof Float32Array) ||
            logits.dims.length !== 2 ||
            logits.dims[0] !== 1 ||
            logits.dims[1] !== 4
          ) {
            throw new Error('Unsupported AI output format.');
          }
          return { logits: Array.from(logits.data), truncated: fullIds.length > meta.max_length };
        },
        dispose: () => session.release(),
      },
      manifest.revision,
      meta.temperature,
    );
  } catch (error) {
    await session.release();
    throw error;
  }
}
