import { Router } from 'express';
import { validateIpAllowlist } from '../middleware/ipAllowlist.js';
import { validateServerSecret } from '../middleware/authentication.js';
import * as statsController from './statsController.js';

const router = Router();

router.use(validateIpAllowlist);
router.use(validateServerSecret);

// GET  /stats?key=<keystring>           - single key
// GET  /stats/batch?keys=<k1>,<k2>,...  - multiple keys (keep URL short)
// POST /stats/batch  { "keys": [...] }  - multiple keys (preferred for large batches)
router.get('/', statsController.getKeyStats);
router.get('/batch', statsController.getKeysStats);
router.post('/batch', statsController.getKeysStats);

export { router as statsRouter };
