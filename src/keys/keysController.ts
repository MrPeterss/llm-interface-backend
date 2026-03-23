import type { Request, Response } from 'express';
import { z } from 'zod';
import * as keysService from './keysService.js';

const rateLimitFields = {
  limitTokensPerMinute: z.number().int().positive().nullable().optional(),
  limitTokensPerHour: z.number().int().positive().nullable().optional(),
};

const issueKeysSchema = z.object({
  descriptions: z
    .array(z.string())
    .min(1, 'At least one description is required')
    .max(50),
  origin: z.string().nullable().optional(),
  ...rateLimitFields,
});

const revokeKeysSchema = z.object({
  keyIds: z
    .array(z.number().int().positive())
    .min(1, 'At least one keyId is required')
    .max(100),
});

const updateLimitsSchema = z.object({
  keyIds: z
    .array(z.number().int().positive())
    .min(1, 'At least one keyId is required')
    .max(100),
  ...rateLimitFields,
});

function validationErrorResponse(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: 'Validation failed',
    details: error.issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    })),
  });
}

export async function listKeys(req: Request, res: Response): Promise<Response> {
  const origin = typeof req.query.origin === 'string' ? req.query.origin : undefined;

  try {
    const keys = await keysService.listKeys({ origin });
    return res.json({ keys });
  } catch (error) {
    console.error('Error listing keys:', error);
    return res.status(500).json({ error: 'Failed to list keys' });
  }
}

export async function getKey(req: Request, res: Response): Promise<Response> {
  const keyString = typeof req.query.key === 'string' ? req.query.key : '';
  if (!keyString) {
    return res.status(400).json({ error: 'key query param is required' });
  }

  try {
    const key = await keysService.getKey(keyString);
    if (!key) {
      return res.status(404).json({ error: 'Key not found' });
    }
    return res.json(key);
  } catch (error) {
    console.error('Error fetching key:', error);
    return res.status(500).json({ error: 'Failed to fetch key' });
  }
}

export async function issueKeys(req: Request, res: Response): Promise<Response> {
  const validation = issueKeysSchema.safeParse(req.body);
  if (!validation.success) {
    return validationErrorResponse(res, validation.error);
  }

  const { descriptions, origin, limitTokensPerMinute, limitTokensPerHour } = validation.data;

  try {
    const keys = await keysService.issueKeys(
      descriptions,
      { limitTokensPerMinute, limitTokensPerHour },
      origin
    );
    return res.json({ keys });
  } catch (error) {
    console.error('Error issuing keys:', error);
    return res.status(500).json({ error: 'Failed to issue keys' });
  }
}

export async function revokeKeys(req: Request, res: Response): Promise<Response> {
  const validation = revokeKeysSchema.safeParse(req.body);
  if (!validation.success) {
    return validationErrorResponse(res, validation.error);
  }

  const { keyIds } = validation.data;

  try {
    const { revoked } = await keysService.revokeKeys(keyIds);
    return res.json({
      revoked,
      keyIds,
      message: `Successfully revoked ${revoked} key(s)`,
    });
  } catch (error) {
    console.error('Error revoking keys:', error);
    return res.status(500).json({ error: 'Failed to revoke keys' });
  }
}

export async function updateKeyLimits(req: Request, res: Response): Promise<Response> {
  const validation = updateLimitsSchema.safeParse(req.body);
  if (!validation.success) {
    return validationErrorResponse(res, validation.error);
  }

  const { keyIds, limitTokensPerMinute, limitTokensPerHour } = validation.data;

  try {
    const { updated } = await keysService.updateKeyLimits(keyIds, {
      limitTokensPerMinute,
      limitTokensPerHour,
    });
    return res.json({
      updated,
      keyIds,
      message: `Successfully updated limits on ${updated} key(s)`,
    });
  } catch (error) {
    console.error('Error updating key limits:', error);
    return res.status(500).json({ error: 'Failed to update key limits' });
  }
}
