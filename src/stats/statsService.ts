import { prisma } from '../prisma.js';

const STATS_RETENTION_DAYS = 2;

export interface HourlyBucket {
  hour: string;
  count: number;
}

export interface DailyBucket {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface KeyStats {
  keyId: number;
  totalRequests: number;
  lastUsedAt: Date | null;
  hourly: HourlyBucket[];
  daily: DailyBucket[];
}

export async function deleteOldRequests(): Promise<number> {
  const cutoff = new Date(Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    // Aggregate expiring requests into daily buckets (kept forever)
    const aggregates = await tx.$queryRaw<
      { apiKeyId: number; date: string; count: bigint }[]
    >`
      SELECT apiKeyId, strftime('%Y-%m-%d', datetime(createdAt)) as date, COUNT(*) as count
      FROM ApiKeyRequest
      WHERE createdAt < ${cutoff}
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
        },
        update: { count: { increment: Number(row.count) } },
      });
    }

    const result = await tx.apiKeyRequest.deleteMany({
      where: { createdAt: { lt: cutoff } },
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

  const cutoff = new Date(Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<{ hour: string; count: bigint }[]>`
    SELECT strftime('%Y-%m-%dT%H:00:00.000Z', datetime(createdAt)) as hour, COUNT(*) as count
    FROM ApiKeyRequest
    WHERE apiKeyId = ${keyId} AND createdAt >= ${cutoff}
    GROUP BY hour
    ORDER BY hour
  `;

  const hourlyMap = new Map(
    rows.map((r) => [r.hour, Number(r.count)])
  );

  const hourly: HourlyBucket[] = [];
  const now = new Date();
  for (let i = 0; i < 48; i++) {
    const h = new Date(now.getTime() - (47 - i) * 60 * 60 * 1000);
    h.setMinutes(0, 0, 0);
    const hourStr = h.toISOString();
    hourly.push({
      hour: hourStr,
      count: hourlyMap.get(hourStr) ?? 0,
    });
  }

  const recentCount = await prisma.apiKeyRequest.count({
    where: { apiKeyId: keyId, createdAt: { gte: cutoff } },
  });

  const dailyRows = await prisma.apiKeyUsageDaily.findMany({
    where: { apiKeyId: keyId },
    orderBy: { date: 'asc' },
  });

  const daily: DailyBucket[] = dailyRows.map((r) => ({
    date: r.date,
    count: r.count,
  }));

  const historicalTotal = dailyRows.reduce((sum, r) => sum + r.count, 0);
  const totalRequests = historicalTotal + recentCount;

  return {
    keyId: apiKey.id,
    totalRequests,
    lastUsedAt: apiKey.lastUsedAt,
    hourly,
    daily,
  };
}
