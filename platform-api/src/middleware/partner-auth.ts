import { NextFunction, Request, Response } from 'express';

type PartnerKeys = Record<string, string>;

let partnerKeys: PartnerKeys | null = null;

function getPartnerKeys(): PartnerKeys {
  if (partnerKeys) return partnerKeys;
  const raw = process.env.PARTNER_KEYS;
  if (!raw) {
    partnerKeys = {};
    return partnerKeys;
  }
  try {
    partnerKeys = JSON.parse(raw);
    return partnerKeys!;
  } catch {
    console.error('[partner-auth] Invalid PARTNER_KEYS JSON');
    partnerKeys = {};
    return partnerKeys;
  }
}

export function partnerAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-partner-key'] as string | undefined;
  if (!key) {
    res.status(401).json({ error: 'x-partner-key header is required' });
    return;
  }

  const keys = getPartnerKeys();
  const partnerId = Object.entries(keys).find(([, v]) => v === key)?.[0];

  if (!partnerId) {
    res.status(403).json({ error: 'Invalid partner key' });
    return;
  }

  (req as Request & { partnerId: string }).partnerId = partnerId;
  next();
}
