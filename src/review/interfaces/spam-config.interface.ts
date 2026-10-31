export interface SpamConfig {
  blockedWords: string[];
  maxContentLength: number;
}

export const DEFAULT_SPAM_CONFIG: SpamConfig = {
  blockedWords: [],
  maxContentLength: 5000,
};
