import { boot, migrateAndStamp } from '../src/bootstrap.js';

const { config, logger } = boot('zentrix-migrate');
const applied = await migrateAndStamp(config, logger);
console.log(applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
console.log(`Database mode: ${config.appMode}`);
