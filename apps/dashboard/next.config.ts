import type { NextConfig } from 'next';

const config: NextConfig = {
  // Worker threads avoid child-process IPC restrictions in the local Windows runner.
  experimental: { workerThreads: true, cpus: 2, useTypeScriptCli: false },
};

export default config;
