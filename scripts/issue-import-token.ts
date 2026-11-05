import { issueImportToken } from '../packages/server/src/repository.ts';
import { openLocal } from './local-db.ts';

const { db } = await openLocal();
process.stdout.write(`${await issueImportToken(db)}\n`);
