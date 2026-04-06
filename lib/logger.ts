/**
 * Minimal structured logger. Writes JSON lines so Vercel log drains
 * and any observability backend can parse fields directly.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ACTIVE_LEVEL: Level =
  (process.env.LOG_LEVEL as Level) ?? 'info';

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[ACTIVE_LEVEL]) return;
  const line = {
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/**
 * Charter §13.1: every cache miss logs a miss_reason label.
 */
export type MissReason =
  | 'not_in_off'
  | 'no_ingredients'
  | 'ocr_failed'
  | 'provider_disabled';

export function logCacheMiss(barcode: string, reason: MissReason, extra?: Record<string, unknown>) {
  log.info('product_cache_miss', {
    barcode,
    miss_reason: reason,
    ...extra,
  });
}

export function logCacheHit(barcode: string, source: string) {
  log.info('product_cache_hit', {
    barcode,
    source,
  });
}
