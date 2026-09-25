import type { Db } from './db.js';
import type { Database } from 'sql.js';
import { runStmt } from './db.js';
import * as m001 from '../migrations/001_core_schema.ts';
import * as m002 from '../migrations/002_legacy_baseline.ts';
import type { Clock } from './domain/clock.js';

interface Migration {
  id: string;
  name: string;
  up: (db: Database, nowIso: string) => void;
}

const migrations: Migration[] = [
  { id: m001.id, name: m001.name, up: (db) => m001.up(db) },
  { id: m002.id, name: m002.name, up: (db, now) => m002.up(db, now) },
];

/** 按序执行未应用的版本，每个迁移包在一个事务里；全部成功才落盘。 */
export async function runMigrations(db: Db, clock: Clock): Promise<string[]> {
  return db.serialTxn((tx) => {
    tx.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const appliedRows = tx.exec('SELECT id FROM schema_migrations');
    const applied = new Set(
      appliedRows.flatMap((r) => r.values.map((v) => String(v[0]))),
    );
    const done: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      m.up(tx, clock.nowIso());
      runStmt(tx, `INSERT INTO schema_migrations(id, name, applied_at) VALUES (?,?,?)`, [
        m.id,
        m.name,
        clock.nowIso(),
      ]);
      done.push(m.id);
    }
    return done;
  });
}
