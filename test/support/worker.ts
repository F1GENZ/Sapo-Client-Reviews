// @ts-expect-error the Cloudflare Worker is plain JavaScript and ships no declaration file
import workerModule from '../../worker/src/index.js';

export type WorkerEnv = Record<string, unknown>;

export const worker: { fetch: (request: Request, env: WorkerEnv) => Promise<Response> } = workerModule;
