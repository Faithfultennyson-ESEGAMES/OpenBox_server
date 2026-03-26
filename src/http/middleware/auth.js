import config from '../../config.js';

export function requireControlAuth(req, res, next) {
  if (!config.controlApiToken) {
    next();
    return;
  }

  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (token !== config.controlApiToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
