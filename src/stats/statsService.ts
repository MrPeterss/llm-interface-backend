import { prisma } from '../prisma.js';

const STATS_RETENTION_DAYS = 2;

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
  totalRequests: number;
  totalTokens: number;
  lastUsedAt: Date | null;
  hourly: HourlyBucket[];
  daily: DailyBucket[];
}

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

export async function getKeyStatsByKey(keyString: string): Promise<KeyStats | null> {
  await deleteOldRequests();
  const apiKey = await prisma.apiKey.findUnique({
    where: { key: keyString },
    select: { id: true },
  });
  if (!apiKey) return null;
  return getKeyStatsForId(apiKey.id);
}

export async function getKeysStatsByKeys(keyStrings: string[]): Promise<KeyStats[]> {
  await deleteOldRequests();
  const stats: KeyStats[] = [];
  for (const keyString of keyStrings) {
    const apiKey = await prisma.apiKey.findUnique({
      where: { key: keyString },
      select: { id: true },
    });
    if (!apiKey) continue;
    const s = await getKeyStatsForId(apiKey.id);
    if (s) stats.push(s);
  }
  return stats;
}

async function getKeyStatsForId(keyId: number): Promise<KeyStats | null> {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: keyId },
    select: { id: true, lastUsedAt: true },
  });
  if (!apiKey) return null;

  const cutoffMs = Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const rows = await prisma.$queryRaw<
    { hour: string; count: bigint; totalTokens: bigint }[]
  >`
    SELECT strftime('%Y-%m-%dT%H:00:00.000Z', createdAt / 1000, 'unixepoch') as hour,
           COUNT(*) as count,
           COALESCE(SUM(totalTokens), 0) as totalTokens
    FROM ApiKeyRequest
    WHERE apiKeyId = ${keyId} AND createdAt >= ${cutoffMs}
    GROUP BY hour
    ORDER BY hour
  `;

  const hourlyMap = new Map(
    rows.map((r) => [r.hour, { count: Number(r.count), totalTokens: Number(r.totalTokens) }])
  );

  const hourly: HourlyBucket[] = [];
  const now = new Date();
  for (let i = 0; i < 48; i++) {
    const h = new Date(now.getTime() - (47 - i) * 60 * 60 * 1000);
    h.setMinutes(0, 0, 0);
    const hourStr = h.toISOString();
    const bucket = hourlyMap.get(hourStr);
    hourly.push({
      hour: hourStr,
      count: bucket?.count ?? 0,
      totalTokens: bucket?.totalTokens ?? 0,
    });
  }

  // Aggregate recent requests (within retention window) by day
  const recentDailyRows = await prisma.$queryRaw<
    { date: string; count: bigint; totalTokens: bigint }[]
  >`
    SELECT strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch') as date,
           COUNT(*) as count,
           COALESCE(SUM(totalTokens), 0) as totalTokens
    FROM ApiKeyRequest
    WHERE apiKeyId = ${keyId} AND createdAt >= ${cutoffMs}
    GROUP BY date
    ORDER BY date
  `;

  // Historical aggregated daily records (older than retention window)
  const historicalDailyRows = await prisma.apiKeyUsageDaily.findMany({
    where: { apiKeyId: keyId },
    orderBy: { date: 'asc' },
  });

  // Merge: historical rows first, then recent rows (keyed by date to avoid duplicates)
  const dailyMap = new Map<string, { count: number; totalTokens: number }>();
  for (const r of historicalDailyRows) {
    dailyMap.set(r.date, { count: r.count, totalTokens: r.totalTokens });
  }
  for (const r of recentDailyRows) {
    const existing = dailyMap.get(r.date);
    if (existing) {
      dailyMap.set(r.date, {
        count: existing.count + Number(r.count),
        totalTokens: existing.totalTokens + Number(r.totalTokens),
      });
    } else {
      dailyMap.set(r.date, { count: Number(r.count), totalTokens: Number(r.totalTokens) });
    }
  }

  const daily: DailyBucket[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { count, totalTokens }]) => ({ date, count, totalTokens }));

  const totalRequests = daily.reduce((sum, r) => sum + r.count, 0);
  const totalTokens = daily.reduce((sum, r) => sum + r.totalTokens, 0);

  return {
    keyId: apiKey.id,
    totalRequests,
    totalTokens,
    lastUsedAt: apiKey.lastUsedAt,
    hourly,
    daily,
  };
}
