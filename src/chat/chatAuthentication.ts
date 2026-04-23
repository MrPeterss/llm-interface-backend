import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma.js';

export async function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }

  const apiKey = authHeader.substring(7);

  try {
    const key = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      select: {
        id: true,
        isActive: true,
        limitTokensPerMinute: true,
        limitTokensPerHour: true,
      },
    });

    if (!key || !key.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    // Only query usage when at least one rate limit is set. When both are null
    // (the common case), we skip the query entirely.
    if (key.limitTokensPerMinute !== null || key.limitTokensPerHour !== null) {
      const nowMs = Date.now();
      const oneHourAgoMs = nowMs - 60 * 60 * 1000;
      const oneMinuteAgoMs = nowMs - 60 * 1000;

      // Combine both windows into a single query. The index on
      // (apiKeyId, createdAt) scans only the last hour of rows for this key.
      const rows = await prisma.$queryRaw<
        { minuteTokens: bigint | null; hourTokens: bigint | null }[]
      >`
        SELECT
          COALESCE(SUM(CASE WHEN createdAt >= ${oneMinuteAgoMs} THEN totalTokens END), 0) as minuteTokens,
          COALESCE(SUM(totalTokens), 0) as hourTokens
        FROM ApiKeyRequest
        WHERE apiKeyId = ${key.id} AND createdAt >= ${oneHourAgoMs}
      `;
      const tokensLastMinute = Number(rows[0]?.minuteTokens ?? 0);
      const tokensLastHour = Number(rows[0]?.hourTokens ?? 0);

      if (
        key.limitTokensPerMinute !== null &&
        tokensLastMinute >= key.limitTokensPerMinute
      ) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          detail: `Token limit of ${key.limitTokensPerMinute} per minute reached (used ${tokensLastMinute})`,
        });
      }

      if (
        key.limitTokensPerHour !== null &&
        tokensLastHour >= key.limitTokensPerHour
      ) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          detail: `Token limit of ${key.limitTokensPerHour} per hour reached (used ${tokensLastHour})`,
        });
      }
    }

    res.locals.apiKeyId = key.id;

    // Fire-and-forget: updating lastUsedAt doesn't need to block the chat
    // request. Errors are logged but ignored.
    prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => console.error('Failed to update lastUsedAt:', err));

    return next();
  } catch (error) {
    console.error('Error validating API key:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
