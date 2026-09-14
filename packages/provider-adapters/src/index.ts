/** No external provider implementation is included in the foundation. */
export interface SimulatedExecutor {
  readonly mode: 'SIMULATION';
  simulateDelete(messageId: string): Promise<{ status: 'SIMULATED' }>;
}
