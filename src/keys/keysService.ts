import { randomBytes } from 'crypto';
import { prisma } from '../prisma.js';

function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

export interface IssuedKey {
  id: number;
  key: string;
  description: string | null;
  origin: string | null;
  limitTokensPerMinute: number | null;
  limitTokensPerHour: number | null;
}

export interface KeyLimits {
  limitTokensPerMinute?: number | null;
  limitTokensPerHour?: number | null;
}

export async function issueKeys(
  descriptions: string[],
  limits: KeyLimits = {},
  origin?: string | null
): Promise<IssuedKey[]> {
  const keys = await Promise.all(
    descriptions.map(async (description) => {
      const key = generateApiKey();
      const apiKey = await prisma.apiKey.create({
        data: {
          key,
          description: description || 'No description',
          origin: origin ?? null,
          limitTokensPerMinute: limits.limitTokensPerMinute ?? null,
          limitTokensPerHour: limits.limitTokensPerHour ?? null,
        },
      });
      return {
        id: apiKey.id,
        key: apiKey.key,
        description: apiKey.description,
        origin: apiKey.origin,
        limitTokensPerMinute: apiKey.limitTokensPerMinute,
        limitTokensPerHour: apiKey.limitTokensPerHour,
      };
    })
  );
  return keys;
}

export interface KeyInfo {
  id: number;
  key: string;
  description: string | null;
  origin: string | null;
  isActive: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  limitTokensPerMinute: number | null;
  limitTokensPerHour: number | null;
}

const KEY_INFO_SELECT = {
  id: true,
  key: true,
  description: true,
  origin: true,
  isActive: true,
  createdAt: true,
  lastUsedAt: true,
  limitTokensPerMinute: true,
  limitTokensPerHour: true,
};

export async function getKey(keyString: string): Promise<KeyInfo | null> {
  return prisma.apiKey.findUnique({
    where: { key: keyString },
    select: KEY_INFO_SELECT,
  });
}

export interface ListKeysFilters {
  origin?: string;
}

export async function listKeys(filters: ListKeysFilters = {}): Promise<KeyInfo[]> {
  return prisma.apiKey.findMany({
    where: filters.origin ? { origin: filters.origin } : undefined,
    select: KEY_INFO_SELECT,
    orderBy: [{ origin: 'asc' }, { createdAt: 'desc' }],
  });
}

export interface RevokeKeysResult {
  revoked: number;
}

export async function revokeKeys(keyIds: number[]): Promise<RevokeKeysResult> {
  const result = await prisma.apiKey.updateMany({
    where: { id: { in: keyIds } },
    data: { isActive: false },
  });
  return { revoked: result.count };
}

export interface UpdateLimitsResult {
  updated: number;
}

export async function updateKeyLimits(
  keyIds: number[],
  limits: KeyLimits
): Promise<UpdateLimitsResult> {
  const result = await prisma.apiKey.updateMany({
    where: { id: { in: keyIds } },
    data: {
      limitTokensPerMinute: limits.limitTokensPerMinute ?? null,
      limitTokensPerHour: limits.limitTokensPerHour ?? null,
    },
  });
  return { updated: result.count };
}
