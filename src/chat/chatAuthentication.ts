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
    });

    if (!key || !key.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    const now = new Date();

    if (key.limitTokensPerMinute !== null) {
      const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
      const result = await prisma.apiKeyRequest.aggregate({
        where: { apiKeyId: key.id, createdAt: { gte: oneMinuteAgo } },
        _sum: { totalTokens: true },
      });
      const tokensLastMinute = result._sum.totalTokens ?? 0;
      if (tokensLastMinute >= key.limitTokensPerMinute) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          detail: `Token limit of ${key.limitTokensPerMinute} per minute reached (used ${tokensLastMinute})`,
        });
      }
    }

    if (key.limitTokensPerHour !== null) {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const result = await prisma.apiKeyRequest.aggregate({
        where: { apiKeyId: key.id, createdAt: { gte: oneHourAgo } },
        _sum: { totalTokens: true },
      });
      const tokensLastHour = result._sum.totalTokens ?? 0;
      if (tokensLastHour >= key.limitTokensPerHour) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          detail: `Token limit of ${key.limitTokensPerHour} per hour reached (used ${tokensLastHour})`,
        });
      }
    }

    // Pass keyId to controller for post-response request logging
    res.locals.apiKeyId = key.id;

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: now },
    });

    return next();
  } catch (error) {
    console.error('Error validating API key:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
