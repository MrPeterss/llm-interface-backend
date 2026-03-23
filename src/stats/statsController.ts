import type { Request, Response } from 'express';
import { z } from 'zod';
import * as statsService from './statsService.js';

const singleKeySchema = z.object({
  key: z.string().min(1, 'key query param is required'),
});

const batchKeysSchema = z.object({
  keys: z
    .string({ message: 'keys query param is required' })
    .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
    .pipe(
      z.array(z.string().min(1)).min(1, 'At least one key required').max(100)
    ),
});

function queryString(param: unknown): string {
  if (typeof param === 'string') return param;
  if (Array.isArray(param)) return String(param[0] ?? '');
  return '';
}

export async function getKeyStats(req: Request, res: Response): Promise<Response> {
  const validation = singleKeySchema.safeParse({ key: queryString(req.query.key) });
  if (!validation.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validation.error.issues.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
  }

  try {
    const stats = await statsService.getKeyStatsByKey(validation.data.key);
    if (!stats) {
      return res.status(404).json({ error: 'Key not found' });
    }
    return res.json(stats);
  } catch (error) {
    console.error('Error fetching key stats:', error);
    return res.status(500).json({ error: 'Failed to fetch key stats' });
  }
}

export async function getKeysStats(req: Request, res: Response): Promise<Response> {
  const validation = batchKeysSchema.safeParse({ keys: queryString(req.query.keys) });
  if (!validation.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validation.error.issues.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
  }

  try {
    const stats = await statsService.getKeysStatsByKeys(validation.data.keys);
    return res.json({ stats });
  } catch (error) {
    console.error('Error fetching keys stats:', error);
    return res.status(500).json({ error: 'Failed to fetch keys stats' });
  }
}
