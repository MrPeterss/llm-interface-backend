import { Router } from 'express';
import { validateIpAllowlist } from '../middleware/ipAllowlist.js';
import { validateServerSecret } from '../middleware/authentication.js';
import * as keysController from './keysController.js';

const router = Router();

router.use(validateIpAllowlist);
router.use(validateServerSecret);

router.get('/', keysController.listKeys);
router.get('/info', keysController.getKey);
router.post('/issue', keysController.issueKeys);
router.post('/revoke', keysController.revokeKeys);
router.patch('/limits', keysController.updateKeyLimits);

export { router as keysRouter };
