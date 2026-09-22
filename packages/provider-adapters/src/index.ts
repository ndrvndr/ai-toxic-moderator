export * from './google-provider';
export * from './google-token-store';
export * from './youtube-ban';
export { parseYoutubeBanEvent, type YoutubeBanEventEvidence } from './youtube-ban-event';
export * from './youtube-chat';
export * from './youtube-moderation';

/** Simulation-only executor used by the foundation. */
export interface SimulatedExecutor {
  readonly mode: 'SIMULATION';
  simulateDelete(messageId: string): Promise<{ status: 'SIMULATED' }>;
}
