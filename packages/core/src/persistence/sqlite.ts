import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { asc, desc, gt } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  applyEvent,
  EMPTY_STATE,
  gameEventSchema,
  gameStateSchema,
  SAVE_SCHEMA_VERSION,
  type GameEvent,
  type GameState,
} from "../game/state.ts";
import type { TranscriptEntry } from "../gm/turn.ts";
import type { GameRepository } from "./repository.ts";
import * as schema from "./schema.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export class SaveFormatError extends Error {
  override name = "SaveFormatError";
}

/**
 * SQLite 세계 세이브. 세계 하나 = DB 파일 하나.
 * - 이벤트를 먼저 상태에 적용해 보고, 성공하면 DB에 기록한다
 * - 불러올 때는 마지막 스냅샷 + 그 이후 이벤트로 상태를 복원한다
 */
export class SqliteRepository implements GameRepository {
  #sqlite: Database.Database;
  #db: BetterSQLite3Database<typeof schema>;
  #state: GameState;
  #lastSeq: number;
  #transcript: TranscriptEntry[];

  private constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
    this.#db = drizzle(sqlite, { schema });
    migrate(this.#db, { migrationsFolder: MIGRATIONS_DIR });
    this.#checkVersion();
    ({ state: this.#state, lastSeq: this.#lastSeq } = this.#loadState());
    this.#transcript = this.#db
      .select()
      .from(schema.transcript)
      .orderBy(asc(schema.transcript.id))
      .all()
      .map((row) => row.entry as TranscriptEntry);
  }

  /** 파일을 연다. 없으면 새로 만든다. ":memory:"는 테스트용 */
  static open(path: string): SqliteRepository {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    return new SqliteRepository(sqlite);
  }

  getState(): GameState {
    return this.#state;
  }

  append(event: GameEvent): GameState {
    const valid = gameEventSchema.parse(event);
    const next = applyEvent(this.#state, valid);
    const row = this.#db
      .insert(schema.events)
      .values({ type: valid.type, payload: valid, createdAt: new Date().toISOString() })
      .returning({ seq: schema.events.seq })
      .get();
    this.#state = next;
    this.#lastSeq = row.seq;
    return next;
  }

  events(): readonly GameEvent[] {
    return this.#db
      .select()
      .from(schema.events)
      .orderBy(asc(schema.events.seq))
      .all()
      .map((row) => gameEventSchema.parse(row.payload));
  }

  hasWorld(): boolean {
    return this.#state.worldId !== "";
  }

  transcript(): readonly TranscriptEntry[] {
    return this.#transcript;
  }

  appendTranscript(entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) return;
    const createdAt = new Date().toISOString();
    const turn = this.#state.turn;
    this.#db.transaction((tx) => {
      for (const entry of entries) tx.insert(schema.transcript).values({ turn, entry, createdAt }).run();
    });
    this.#transcript.push(...structuredClone(entries));
  }

  saveSnapshot(): void {
    if (this.#lastSeq === 0) return;
    this.#db
      .insert(schema.snapshots)
      .values({ seq: this.#lastSeq, state: this.#state, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  close(): void {
    this.#sqlite.close();
  }

  #checkVersion() {
    const row = this.#db.select().from(schema.meta).all().find((r) => r.key === "schema_version");
    if (!row) {
      this.#db.insert(schema.meta).values({ key: "schema_version", value: String(SAVE_SCHEMA_VERSION) }).run();
      return;
    }
    if (Number(row.value) !== SAVE_SCHEMA_VERSION) {
      throw new SaveFormatError(
        `세이브 형식 버전이 다릅니다 (세이브 ${row.value}, 현재 ${SAVE_SCHEMA_VERSION}). 이전 세이브를 옮기는 방법이 아직 없습니다.`,
      );
    }
  }

  #loadState(): { state: GameState; lastSeq: number } {
    const snapshot = this.#db.select().from(schema.snapshots).orderBy(desc(schema.snapshots.seq)).limit(1).get();
    let state = snapshot ? gameStateSchema.parse(snapshot.state) : EMPTY_STATE;
    let lastSeq = snapshot?.seq ?? 0;
    const rows = this.#db
      .select()
      .from(schema.events)
      .where(gt(schema.events.seq, lastSeq))
      .orderBy(asc(schema.events.seq))
      .all();
    for (const row of rows) {
      state = applyEvent(state, gameEventSchema.parse(row.payload));
      lastSeq = row.seq;
    }
    return { state, lastSeq };
  }
}

/**
 * 세이브 파일을 archive/ 폴더로 옮긴다 (새 게임을 시작할 때).
 * 기록을 지우지 않고 보관한다. 파일은 닫힌 상태여야 한다. 옮긴 경로를 돌려준다.
 */
export function archiveSave(path: string, now = new Date()): string | null {
  if (!existsSync(path)) return null;
  const archiveDir = join(dirname(path), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const target = join(archiveDir, `${basename(path, ".db")}-${stamp}.db`);
  renameSync(path, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  }
  return target;
}
