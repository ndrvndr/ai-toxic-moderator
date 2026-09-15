export * from './google-provider';
export * from './google-token-store';
export * from './youtube-chat';

/** Simulation-only executor used by the foundation. */
export interface SimulatedExecutor {
  readonly mode: 'SIMULATION';
  simulateDelete(messageId: string): Promise<{ status: 'SIMULATED' }>;
}
