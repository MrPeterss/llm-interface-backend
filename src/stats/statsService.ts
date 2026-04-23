import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

const STATS_RETENTION_DAYS = 2;
const HOURLY_WINDOW_HOURS = 48;

export interface HourlyBucket {
  hour: string;
  count: number;
  totalTokens: number;
}

export interface DailyBucket {
  date: string; // YYYY-MM-DD
  count: number;
  totalTokens: number;
}

export interface KeyStats {
  keyId: number;
  key: string;
  totalRequests: number;
  totalTokens: number;
  lastUsedAt: Date | null;
  hourly: HourlyBucket[];
  daily: DailyBucket[];
}

// ---------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------
//
// deleteOldRequests() moves per-request rows older than the retention window
// into the daily-aggregate table. Previously this ran on *every* stats read,
// which was by far the most expensive part of the endpoint (a full transaction
// with scans, grouped aggregation, and N upserts). It now runs as a scheduled
// background job (see `startRetentionCleanup`) and reads no longer block on it.

export async function deleteOldRequests(): Promise<number> {
  const cutoffMs = Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs);

  return prisma.$transaction(async (tx) => {
    // Defensive cleanup: if SQLite foreign keys were ever disabled, we can end up
    // with orphaned request/usage rows that will fail FK checks during aggregation.
    await tx.$executeRaw`
      DELETE FROM ApiKeyRequest
      WHERE apiKeyId NOT IN (SELECT id FROM ApiKey)
    `;
    await tx.$executeRaw`
      DELETE FROM ApiKeyUsageDaily
      WHERE apiKeyId NOT IN (SELECT id FROM ApiKey)
    `;

    const aggregates = await tx.$queryRaw<
      { apiKeyId: number; date: string; count: bigint; totalTokens: bigint }[]
    >`
      SELECT apiKeyId,
             strftime('%Y-%m-%d', r.createdAt / 1000, 'unixepoch') as date,
             COUNT(*) as count,
             COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM ApiKeyRequest r
      INNER JOIN ApiKey k ON k.id = r.apiKeyId
      WHERE r.createdAt < ${cutoffMs}
      GROUP BY apiKeyId, date
    `;

    for (const row of aggregates) {
      await tx.apiKeyUsageDaily.upsert({
        where: {
          apiKeyId_date: { apiKeyId: row.apiKeyId, date: row.date },
        },
        create: {
          apiKeyId: row.apiKeyId,
          date: row.date,
          count: Number(row.count),
          totalTokens: Number(row.totalTokens),
        },
        update: {
          count: { increment: Number(row.count) },
          totalTokens: { increment: Number(row.totalTokens) },
        },
      });
    }

    const result = await tx.apiKeyRequest.deleteMany({
      where: { createdAt: { lt: cutoffDate } },
    });
    return result.count;
  });
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupInFlight: Promise<unknown> | null = null;

function runCleanupOnce(): Promise<unknown> {
  if (cleanupInFlight) return cleanupInFlight;
  cleanupInFlight = deleteOldRequests()
    .catch((err) => {
      console.error('Retention cleanup failed:', err);
    })
    .finally(() => {
      cleanupInFlight = null;
    });
  return cleanupInFlight;
}

/**
 * Start a periodic retention-cleanup job. Runs once at startup and then every
 * `intervalMs` (default 5 minutes). Safe to call multiple times - subsequent
 * calls are no-ops.
 */
export function startRetentionCleanup(intervalMs: number = 5 * 60 * 1000): void {
  if (cleanupTimer) return;
  // Kick off an initial run but don't block startup on it.
  void runCleanupOnce();
  cleanupTimer = setInterval(runCleanupOnce, intervalMs);
  // Don't keep the event loop alive just for the cleanup timer.
  cleanupTimer.unref?.();
}

export function stopRetentionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Stats reads
// ---------------------------------------------------------------------------

export async function getKeyStatsByKey(keyString: string): Promise<KeyStats | null> {
  const [stats] = await getKeysStatsByKeys([keyString]);
  return stats ?? null;
}

/**
 * Fetch stats for many keys in a constant number of DB round-trips
 * (4 queries total, regardless of how many keys are requested).
 *
 * Keys that don't exist are simply omitted from the result.
 */
export async function getKeysStatsByKeys(keyStrings: string[]): Promise<KeyStats[]> {
  if (keyStrings.length === 0) return [];

  // De-duplicate while preserving input order so callers can correlate by position if they wish.
  const seen = new Set<string>();
  const uniqueKeys: string[] = [];
  for (const k of keyStrings) {
    if (!seen.has(k)) {
      seen.add(k);
      uniqueKeys.push(k);
    }
  }

  // 1) Resolve keys -> ids in one query
  const apiKeys = await prisma.apiKey.findMany({
    where: { key: { in: uniqueKeys } },
    select: { id: true, key: true, lastUsedAt: true },
  });
  if (apiKeys.length === 0) return [];

  const ids = apiKeys.map((k) => k.id);
  const cutoffMs = Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const idList = Prisma.join(ids);

  // 2-4) Run the three aggregation queries in parallel
  const [hourlyRows, recentDailyRows, historicalDailyRows] = await Promise.all([
    prisma.$queryRaw<
      { apiKeyId: number; hour: string; count: bigint; totalTokens: bigint }[]
    >`
      SELECT apiKeyId,
             strftime('%Y-%m-%dT%H:00:00.000Z', createdAt / 1000, 'unixepoch') as hour,
             COUNT(*) as count,
             COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM ApiKeyRequest
      WHERE apiKeyId IN (${idList}) AND createdAt >= ${cutoffMs}
      GROUP BY apiKeyId, hour
    `,
    prisma.$queryRaw<
      { apiKeyId: number; date: string; count: bigint; totalTokens: bigint }[]
    >`
      SELECT apiKeyId,
             strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch') as date,
             COUNT(*) as count,
             COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM ApiKeyRequest
      WHERE apiKeyId IN (${idList}) AND createdAt >= ${cutoffMs}
      GROUP BY apiKeyId, date
    `,
    prisma.apiKeyUsageDaily.findMany({
      where: { apiKeyId: { in: ids } },
      select: { apiKeyId: true, date: true, count: true, totalTokens: true },
    }),
  ]);

  // Index rows by apiKeyId for O(1) per-key lookup
  const hourlyByKey = new Map<number, Map<string, { count: number; totalTokens: number }>>();
  for (const r of hourlyRows) {
    let m = hourlyByKey.get(r.apiKeyId);
    if (!m) {
      m = new Map();
      hourlyByKey.set(r.apiKeyId, m);
    }
    m.set(r.hour, { count: Number(r.count), totalTokens: Number(r.totalTokens) });
  }

  const dailyByKey = new Map<number, Map<string, { count: number; totalTokens: number }>>();
  for (const r of historicalDailyRows) {
    let m = dailyByKey.get(r.apiKeyId);
    if (!m) {
      m = new Map();
      dailyByKey.set(r.apiKeyId, m);
    }
    m.set(r.date, { count: r.count, totalTokens: r.totalTokens });
  }
  for (const r of recentDailyRows) {
    let m = dailyByKey.get(r.apiKeyId);
    if (!m) {
      m = new Map();
      dailyByKey.set(r.apiKeyId, m);
    }
    const existing = m.get(r.date);
    const count = Number(r.count);
    const totalTokens = Number(r.totalTokens);
    if (existing) {
      m.set(r.date, {
        count: existing.count + count,
        totalTokens: existing.totalTokens + totalTokens,
      });
    } else {
      m.set(r.date, { count, totalTokens });
    }
  }

  // Pre-compute the hourly calendar once (identical across all keys in this response).
  const now = new Date();
  const hourTemplate: string[] = [];
  for (let i = 0; i < HOURLY_WINDOW_HOURS; i++) {
    const h = new Date(now.getTime() - (HOURLY_WINDOW_HOURS - 1 - i) * 60 * 60 * 1000);
    h.setMinutes(0, 0, 0);
    hourTemplate.push(h.toISOString());
  }

  // Preserve input order for the response.
  const byKeyString = new Map(apiKeys.map((k) => [k.key, k]));
  const result: KeyStats[] = [];

  for (const keyString of uniqueKeys) {
    const apiKey = byKeyString.get(keyString);
    if (!apiKey) continue;

    const hourlyMap = hourlyByKey.get(apiKey.id);
    const hourly: HourlyBucket[] = hourTemplate.map((hour) => {
      const bucket = hourlyMap?.get(hour);
      return {
        hour,
        count: bucket?.count ?? 0,
        totalTokens: bucket?.totalTokens ?? 0,
      };
    });

    const dailyMap = dailyByKey.get(apiKey.id);
    const daily: DailyBucket[] = dailyMap
      ? Array.from(dailyMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, { count, totalTokens }]) => ({ date, count, totalTokens }))
      : [];

    let totalRequests = 0;
    let totalTokens = 0;
    for (const d of daily) {
      totalRequests += d.count;
      totalTokens += d.totalTokens;
    }

    result.push({
      keyId: apiKey.id,
      key: apiKey.key,
      totalRequests,
      totalTokens,
      lastUsedAt: apiKey.lastUsedAt,
      hourly,
      daily,
    });
  }

  return result;
}
