import { Router } from 'express';
import { validateIpAllowlist } from '../middleware/ipAllowlist.js';
import { validateServerSecret } from '../middleware/authentication.js';
import * as statsController from './statsController.js';

const router = Router();

router.use(validateIpAllowlist);
router.use(validateServerSecret);

router.get('/', statsController.getKeysStats);
router.get('/:keyId', statsController.getKeyStats);

export { router as statsRouter };
