// Local SQLite store with a tiny D1-compatible surface.
//
// The route handlers and metrics queries were written against Cloudflare D1's
// prepared-statement API (`prepare(sql).bind(...).first()/.all()/.run()` plus
// `db.batch([...])`). This adapter reproduces that exact shape on top of the
// synchronous `better-sqlite3` driver — so the ported SQL needs no rewriting,
// it just runs locally against a file on disk and returns instantly.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

type Param = unknown;
type SqliteParam = string | number | bigint | Buffer | null;

// better-sqlite3 only binds string | number | bigint | Buffer | null. D1 was
// more forgiving, so callers pass `undefined`, booleans, and the occasional
// object. Normalize the same way D1 effectively did.
function coerce(params: Param[]): SqliteParam[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'bigint' || typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p;
    return JSON.stringify(p); // arrays/objects callers forgot to stringify
  });
}

export interface PreparedStatement {
  bind(...params: Param[]): PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true }>;
}

export interface Db {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}

class Stmt implements PreparedStatement {
  constructor(
    private readonly db: Database.Database,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}

  bind(...params: Param[]): Stmt {
    return new Stmt(this.db, this.sql, params);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...coerce(this.params));
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...coerce(this.params)) as T[];
    return { results: rows };
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...coerce(this.params));
    return { success: true };
  }

  /** Synchronous execution, used inside batch transactions. */
  execSync(): void {
    this.db.prepare(this.sql).run(...coerce(this.params));
  }
}

export class LocalDb implements Db {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql);
  }

  /** D1.batch — run a set of statements atomically (a single transaction). */
  async batch(statements: PreparedStatement[]): Promise<unknown[]> {
    const stmts = statements as Stmt[];
    const tx = this.db.transaction((items: Stmt[]) => {
      for (const s of items) s.execSync();
    });
    tx(stmts);
    return stmts.map(() => ({ success: true }));
  }
}

/**
 * Open (creating if needed) the SQLite file, apply the schema, and seed the
 * starter access codes + video catalog on first run. Idempotent across restarts.
 */
export function openDb(filePath: string, schemaSql: string, seedSql: string): LocalDb {
  mkdirSync(dirname(filePath), { recursive: true }); // ensure data/ exists (e.g. after a reset)
  const raw = new Database(filePath);
  raw.pragma('journal_mode = WAL'); // fast concurrent reads while writing
  raw.pragma('foreign_keys = ON');
  raw.exec(schemaSql);

  // Seed only when the catalog is empty, so restarts never reset uses_count.
  const seeded = (raw.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n;
  if (seeded === 0) raw.exec(seedSql);

  return new LocalDb(raw);
}
