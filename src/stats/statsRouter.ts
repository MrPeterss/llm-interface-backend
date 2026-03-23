import { Router } from 'express';
import { validateIpAllowlist } from '../middleware/ipAllowlist.js';
import { validateServerSecret } from '../middleware/authentication.js';
import * as statsController from './statsController.js';

const router = Router();

router.use(validateIpAllowlist);
router.use(validateServerSecret);

// GET /stats?key=<keystring>          - single key
// GET /stats/batch?keys=<k1>,<k2>     - multiple keys
router.get('/', statsController.getKeyStats);
router.get('/batch', statsController.getKeysStats);

export { router as statsRouter };
