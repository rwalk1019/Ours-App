import { issueDeviceSetupCode } from '../packages/server/src/repository.ts';
import { openLocal } from './local-db.ts';

const { db, config } = await openLocal();
const code = await issueDeviceSetupCode(db, config.pepper, config.setupCodeTtlSeconds, new Date());
process.stdout.write(`${code}\n`);
