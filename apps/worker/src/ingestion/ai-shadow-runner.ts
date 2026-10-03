import {
  aiShadowIdentity,
  aiShadowResult,
  type AiShadowErrorCode,
  type AiShadowIdentity,
  type AiShadowResult,
} from '@moderator/contracts';
import { fork, type ChildProcess, type ForkOptions, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  LASKAR_ADAPTER_VERSION,
  LASKAR_MODEL_ID,
  type ShadowObservationIdentity,
} from './laskar-shadow-adapter';

type Spawn = () => ChildProcess;
type RunnerOptions = {
  cacheDirectory: string;
  revision: string;
  startupMs?: number;
  inferenceMs?: number;
};

function failure(identity: AiShadowIdentity, error_code: AiShadowErrorCode): AiShadowResult {
  return aiShadowResult.parse({
    ...identity,
    status: 'ERROR',
    rating: null,
    severity_score: null,
    truncated: null,
    inference_ms: null,
    error_code,
  });
}

export class AiShadowRunner {
  private child: ChildProcess | null = null;
  private active: Promise<AiShadowResult> | null = null;
  private closed = false;
  private failures = 0;
  private disposal: Promise<void> | null = null;
  private readonly spawn: Spawn;
  private readonly startupMs: number;
  private readonly inferenceMs: number;

  constructor(
    private readonly options: RunnerOptions,
    spawn?: Spawn,
  ) {
    if (!/^[a-f0-9]{40}$/.test(options.revision)) throw new Error('Invalid AI revision.');
    this.startupMs = options.startupMs ?? 30_000;
    this.inferenceMs = options.inferenceMs ?? 5_000;
    if (
      ![this.startupMs, this.inferenceMs].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 300_000,
      )
    ) {
      throw new Error('Invalid AI deadline.');
    }
    this.spawn =
      spawn ??
      (() => {
        // The inference child needs local runtime paths, not application credentials.
        const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'development' };
        for (const [key, value] of Object.entries(process.env)) {
          if (
            [
              'PATH',
              'SYSTEMROOT',
              'WINDIR',
              'TEMP',
              'TMP',
              'TMPDIR',
              'HOME',
              'USERPROFILE',
              'LOCALAPPDATA',
            ].includes(key.toUpperCase())
          )
            env[key] = value;
        }
        const forkOptions: ForkOptions & Pick<SpawnOptions, 'windowsHide'> = {
          env,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        };
        return fork(path.join(__dirname, 'ai-shadow-child.js'), [], forkOptions);
      });
  }

  identity(observation: ShadowObservationIdentity): AiShadowIdentity {
    return aiShadowIdentity.parse({
      ...observation,
      model_id: LASKAR_MODEL_ID,
      model_revision: this.options.revision,
      model_variant: 'INT8',
      adapter_version: LASKAR_ADAPTER_VERSION,
    });
  }

  predict(observation: ShadowObservationIdentity, text: string): Promise<AiShadowResult> {
    const identity = this.identity(observation);
    if (this.active) return Promise.reject(new Error('AI_ADAPTER_BUSY'));
    const work = this.predictOne(identity, text).finally(() => {
      this.active = null;
    });
    this.active = work;
    return work;
  }

  private async predictOne(identity: AiShadowIdentity, text: string): Promise<AiShadowResult> {
    if (this.closed || this.failures >= 3) return failure(identity, 'MODEL_UNAVAILABLE');
    if (typeof text !== 'string' || !text.trim()) return failure(identity, 'INFERENCE_FAILED');
    if (text.length > 10_000) return failure(identity, 'INPUT_TOO_LONG');
    try {
      await this.ensureReady();
    } catch {
      this.failures++;
      await this.stopChild();
      return failure(identity, 'MODEL_UNAVAILABLE');
    }
    const child = this.child;
    if (!child || this.closed) return failure(identity, 'MODEL_UNAVAILABLE');
    const requestId = randomUUID();
    try {
      const message = await this.exchange(
        child,
        { type: 'predict', request_id: requestId, identity, text },
        this.inferenceMs,
        (value) => value.type === 'result' && value.request_id === requestId,
      );
      const parsed = aiShadowResult.safeParse(message.result);
      if (
        !parsed.success ||
        Object.entries(identity).some(
          ([key, value]) => parsed.data[key as keyof AiShadowResult] !== value,
        )
      ) {
        this.failures++;
        await this.stopChild();
        return failure(identity, 'INVALID_OUTPUT');
      }
      this.failures = 0;
      return parsed.data;
    } catch (error) {
      this.failures++;
      await this.stopChild();
      return failure(
        identity,
        error instanceof Error && error.message === 'AI_DEADLINE'
          ? 'INFERENCE_TIMEOUT'
          : 'INFERENCE_FAILED',
      );
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.child) return;
    const child = this.spawn();
    this.child = child;
    // Prevent an unhandled error after a request listener has been removed.
    child.on('error', () => undefined);
    const message = await this.exchange(
      child,
      {
        type: 'init',
        cache_directory: path.resolve(this.options.cacheDirectory),
        revision: this.options.revision,
      },
      this.startupMs,
      (value) => value.type === 'ready',
    );
    if (message.revision !== this.options.revision) throw new Error('AI_IDENTITY_MISMATCH');
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });
  }

  private exchange(
    child: ChildProcess,
    payload: object,
    timeoutMs: number,
    matches: (value: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
        if (error) reject(error);
        else resolve(value!);
      };
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.type === 'failed') finish(new Error('AI_CHILD_FAILED'));
        else if (matches(value)) finish(undefined, value);
      };
      const onExit = () => finish(new Error('AI_CHILD_EXITED'));
      const onError = () => finish(new Error('AI_CHILD_FAILED'));
      const timer = setTimeout(() => finish(new Error('AI_DEADLINE')), timeoutMs);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
      try {
        child.send(payload, (error) => {
          if (error) finish(new Error('AI_CHILD_FAILED'));
        });
      } catch {
        finish(new Error('AI_CHILD_FAILED'));
      }
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Do not start a replacement until the old native process has exited.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.closed = true;
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill('SIGKILL');
        } catch {
          clearTimeout(timer);
          this.closed = true;
          resolve();
        }
      });
    }
    if (this.child === child) this.child = null;
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposal ??= (async () => {
      await this.stopChild();
      if (this.active) await this.active;
    })();
    return this.disposal;
  }
}
