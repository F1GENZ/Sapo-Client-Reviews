import { appEnv } from '../config/env';

export const reportError = (context: string, error: unknown): void => {
  if (!appEnv.isDev) return;
  console.error(`[${context}]`, error);
};
