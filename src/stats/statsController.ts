import type { Request, Response } from 'express';
import { z } from 'zod';
import * as statsService from './statsService.js';

const MAX_BATCH_KEYS = 200;

const singleKeySchema = z.object({
  key: z.string().min(1, 'key query param is required'),
});

// Accepts either a comma-delimited string (GET ?keys=k1,k2,...) or a
// pre-parsed array (from the JSON body of POST /stats/batch).
const batchKeysSchema = z.object({
  keys: z
    .union([
      z
        .string({ message: 'keys is required' })
        .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean)),
      z.array(z.string()).transform((arr) => arr.map((k) => k.trim()).filter(Boolean)),
    ])
    .pipe(
      z
        .array(z.string().min(1))
        .min(1, 'At least one key required')
        .max(MAX_BATCH_KEYS, `At most ${MAX_BATCH_KEYS} keys per batch`),
    ),
});

function queryString(param: unknown): string {
  if (typeof param === 'string') return param;
  if (Array.isArray(param)) return String(param[0] ?? '');
  return '';
}

function validationErrorResponse(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: 'Validation failed',
    details: error.issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    })),
  });
}

export async function getKeyStats(req: Request, res: Response): Promise<Response> {
  const validation = singleKeySchema.safeParse({ key: queryString(req.query.key) });
  if (!validation.success) {
    return validationErrorResponse(res, validation.error);
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
  // Support GET with ?keys=k1,k2 and POST with JSON { "keys": ["k1","k2"] }
  const rawKeys =
    req.method === 'POST'
      ? (req.body as { keys?: unknown })?.keys
      : queryString(req.query.keys);

  const validation = batchKeysSchema.safeParse({ keys: rawKeys });
  if (!validation.success) {
    return validationErrorResponse(res, validation.error);
  }

  try {
    const stats = await statsService.getKeysStatsByKeys(validation.data.keys);
    return res.json({ stats });
  } catch (error) {
    console.error('Error fetching keys stats:', error);
    return res.status(500).json({ error: 'Failed to fetch keys stats' });
  }
}
