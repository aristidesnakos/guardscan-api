/**
 * Exponential backoff retry wrapper.
 *
 * Used by DSLD adapter (intermittent 500s) and cron ingest jobs.
 * Defaults: 3 attempts, 500ms base delay (500 → 1500 → 4500ms).
 */

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  label?: string;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const { attempts = 3, baseDelayMs = 500, label = 'operation' } = options ?? {};

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(3, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
