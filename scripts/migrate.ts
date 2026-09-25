import { Db } from '../src/db.ts';
import { Clock } from '../src/domain/clock.ts';
import { runMigrations } from '../src/migrator.ts';

const file = process.env.DB_FILE ?? './data/enforcement.sqlite';
const db = await Db.open(file);
const clock = new Clock();
const applied = await runMigrations(db, clock);
console.log(JSON.stringify({ db: file, applied }, null, 2));
db.close();
