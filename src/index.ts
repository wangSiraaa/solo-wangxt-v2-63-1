import { Db } from './db.js';
import { Clock } from './domain/clock.js';
import { runMigrations } from './migrator.js';
import { buildApp } from './app.js';

const DB_FILE = process.env.DB_FILE ?? './data/enforcement.sqlite';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const clock = new Clock();
  const db = await Db.open(DB_FILE);
  const applied = await runMigrations(db, clock);
  if (applied.length) {
    console.log(`migrations applied: ${applied.join(', ')}`);
  }

  const app = await buildApp({ db, clock });
  await app.listen({ port: PORT, host: HOST });
  console.log(`listening on http://${HOST}:${PORT} (docs: /docs)`);

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
