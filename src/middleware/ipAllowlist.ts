import type { Request, Response, NextFunction } from 'express';

/**
 * Restricts access to requests originating from ADMIN_ALLOWED_IP.
 * Checks req.ip (set by Express, respecting trust proxy if configured).
 * Apply to any router that should only be reachable from the local network peer.
 */
export function validateIpAllowlist(
  req: Request,
  res: Response,
  next: NextFunction
): void | Response {
  const allowedIp = process.env.ADMIN_ALLOWED_IP;
  if (!allowedIp) {
    return res.status(503).json({ error: 'Admin IP allowlist not configured' });
  }

  // req.ip may include IPv6-mapped IPv4 prefix (::ffff:192.168.x.x)
  const requestIp = req.ip?.replace(/^::ffff:/, '');

  if (requestIp !== allowedIp) {
    console.warn(`Blocked request from disallowed IP: ${requestIp}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
