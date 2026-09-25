import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * sql.js 是同步 WASM SQLite：拥有完整事务/唯一索引语义，
 * 但同一 Database 句柄的执行必须串行。所有写操作经 serialTxn 排队，
 * 配合表上的 UNIQUE 索引，保证重复发布/并发升级不产生双记录。
 */
export class Db {
  private SQL!: SqlJsStatic;
  database!: Database;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(public readonly file: string) {}

  static async open(file: string): Promise<Db> {
    const db = new Db(file);
    db.SQL = await initSqlJs();
    if (file !== ':memory:' && existsSync(file)) {
      db.database = new db.SQL.Database(readFileSync(file));
    } else {
      db.database = new db.SQL.Database();
    }
    // 外键约束需要逐连接开启。
    db.database.run('PRAGMA foreign_keys = ON');
    return db;
  }

  /** 以排他写事务排队执行；唯一索引冲突由调用方识别为并发冲突。 */
  async serialTxn<T>(fn: (tx: Database) => T): Promise<T> {
    const run = this.chain.then(async () => {
      this.database.run('BEGIN IMMEDIATE');
      try {
        const result = fn(this.database);
        this.database.run('COMMIT');
        return result;
      } catch (e) {
        this.database.run('ROLLBACK');
        throw e;
      }
    });
    // 串行化：无论上一笔成功失败，下一笔都可继续。
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    const out = await run;
    this.persist();
    return out;
  }

  /** 只读执行（由 serialTxn 之外调用，用于查询/试算）。 */
  read<T>(fn: (db: Database) => T): T {
    return fn(this.database);
  }

  private persist(): void {
    if (this.file === ':memory:') return;
    mkdirSync(dirname(this.file), { recursive: true });
    const data = this.database.export();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, Buffer.from(data));
    renameSync(tmp, this.file);
  }

  close(): void {
    this.database.close();
  }
}

/** 行类型辅助。 */
export type Row = Record<string, unknown>;

export function queryAll(db: Database, sql: string, params: unknown[] = []): Row[] {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params as (number | string | null | Uint8Array)[]);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

export function queryOne(db: Database, sql: string, params: unknown[] = []): Row | null {
  const rows = queryAll(db, sql, params);
  return rows[0] ?? null;
}

export function runStmt(db: Database, sql: string, params: unknown[] = []): number {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params as (number | string | null | Uint8Array)[]);
    return db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] as number;
  } finally {
    stmt.free();
  }
}

/** sql.js 唯一索引冲突信息识别（错误码不暴露时回退到消息匹配）。 */
export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

export function isCheckViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /CHECK constraint failed/i.test(msg);
}
