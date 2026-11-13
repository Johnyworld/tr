import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { asc, desc, eq, gt } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  applyEvent,
  createGameSchemas,
  EMPTY_STATE,
  MIN_READABLE_SAVE_VERSION,
  SAVE_SCHEMA_VERSION,
  type GameEvent,
  type GameState,
} from "../game/state.ts";
import type { RetrievalRecord, TranscriptEntry, TurnSummary } from "../engine/log.ts";
import type { GameRepository } from "./repository.ts";
import * as schema from "./schema.ts";
import type { Scenario } from "../scenario/schema.ts";

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
  /** 마지막으로 스냅숏을 남긴 이벤트 번호 */
  #snapSeq = 0;
  #transcript: TranscriptEntry[];
  #schemas: ReturnType<typeof createGameSchemas>;
  readonly scenarioId: string;

  private constructor(sqlite: Database.Database, scenario: Scenario) {
    this.#sqlite = sqlite;
    this.#db = drizzle(sqlite, { schema });
    this.#schemas = createGameSchemas(scenario);
    this.scenarioId = scenario.id;
    migrate(this.#db, { migrationsFolder: MIGRATIONS_DIR });
    const upgradeFrom = this.#checkMeta();
    if (upgradeFrom === null) {
      ({ state: this.#state, lastSeq: this.#lastSeq } = this.#loadState(true));
    } else {
      // 이전 형식: 스냅숏은 믿지 않고 이벤트를 처음부터 다시 읽는다 (새 필드는 스키마 기본값으로 채워진다)
      try {
        ({ state: this.#state, lastSeq: this.#lastSeq } = this.#loadState(false));
      } catch (err) {
        throw new SaveFormatError(`이전 형식(${upgradeFrom})의 세이브를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#db.update(schema.meta).set({ value: String(SAVE_SCHEMA_VERSION) }).where(eq(schema.meta.key, "schema_version")).run();
      if (this.#lastSeq > 0) this.saveSnapshot();
    }
    this.#transcript = this.#db
      .select()
      .from(schema.transcript)
      .orderBy(asc(schema.transcript.id))
      .all()
      .map((row) => row.entry as TranscriptEntry);
  }

  /**
   * 파일을 연다. 없으면 새로 만든다. ":memory:"는 테스트용.
   * 세이브는 시나리오 하나에 묶인다. 다른 시나리오의 세이브나 형식 버전이 다른 세이브는 열지 않는다.
   */
  static open(path: string, scenario: Scenario): SqliteRepository {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    try {
      return new SqliteRepository(sqlite, scenario);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }

  getState(): GameState {
    return this.#state;
  }

  append(event: GameEvent): GameState {
    const valid = this.#schemas.event.parse(event);
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
      .map((row) => this.#schemas.event.parse(row.payload));
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

  appendSummary(summary: TurnSummary): void {
    this.#db
      .insert(schema.summaries)
      .values({ ...summary, createdAt: new Date().toISOString() })
      .run();
  }

  summaries(options: { kind?: TurnSummary["kind"]; limit?: number } = {}): TurnSummary[] {
    const query = this.#db.select().from(schema.summaries);
    const rows = (options.kind ? query.where(eq(schema.summaries.kind, options.kind)) : query)
      .orderBy(desc(schema.summaries.id))
      .limit(options.limit ?? 1_000_000)
      .all();
    return rows.reverse().map((r) => ({
      kind: r.kind as TurnSummary["kind"],
      text: r.text,
      turn: r.turn,
      time: r.time,
      mode: r.mode as TurnSummary["mode"],
      characterId: r.characterId,
    }));
  }

  appendRetrieval(record: RetrievalRecord): void {
    this.#db.insert(schema.retrievals).values({ ...record, createdAt: new Date().toISOString() }).run();
  }

  retrievals(limit = 20): RetrievalRecord[] {
    return this.#db
      .select()
      .from(schema.retrievals)
      .orderBy(desc(schema.retrievals.id))
      .limit(limit)
      .all()
      .reverse()
      .map((r) => ({
        turn: r.turn,
        time: r.time,
        mode: r.mode as RetrievalRecord["mode"],
        collection: r.collection as RetrievalRecord["collection"],
        purpose: r.purpose as RetrievalRecord["purpose"],
        trace: r.trace,
      }));
  }

  saveSnapshot(options: { every?: number } = {}): void {
    if (this.#lastSeq === 0) return;
    // 스냅숏은 불러오기를 빠르게 할 뿐이다 (이벤트가 원본). 턴마다 상태 전체를 쓰지 않는다
    if (options.every && this.#lastSeq - this.#snapSeq < options.every) return;
    this.#snapSeq = this.#lastSeq;
    this.#db
      .insert(schema.snapshots)
      .values({ seq: this.#lastSeq, state: this.#state, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  close(): void {
    this.#sqlite.close();
  }

  /** 세이브 메타: 형식 버전과 시나리오 (기획서 12.2, 12.3). 올려 읽어야 하는 이전 형식이면 그 버전 */
  #checkMeta(): number | null {
    const rows = this.#db.select().from(schema.meta).all();
    const get = (key: string) => rows.find((r) => r.key === key)?.value;
    const version = get("schema_version");
    if (version === undefined) {
      this.#db
        .insert(schema.meta)
        .values([
          { key: "schema_version", value: String(SAVE_SCHEMA_VERSION) },
          { key: "scenario_id", value: this.scenarioId },
        ])
        .run();
      return null;
    }
    const scenarioId = get("scenario_id");
    if (scenarioId !== this.scenarioId) {
      throw new SaveFormatError(`다른 시나리오의 세이브입니다 (세이브 ${scenarioId ?? "없음"}, 현재 ${this.scenarioId}).`);
    }
    const v = Number(version);
    if (v === SAVE_SCHEMA_VERSION) return null;
    // 형식이 바뀌어도 이벤트는 스키마 기본값으로 올려 읽는다 (MIN_READABLE_SAVE_VERSION부터)
    if (v >= MIN_READABLE_SAVE_VERSION && v < SAVE_SCHEMA_VERSION) return v;
    throw new SaveFormatError(`세이브 형식 버전이 다릅니다 (세이브 ${version}, 현재 ${SAVE_SCHEMA_VERSION}, 읽을 수 있는 것은 ${MIN_READABLE_SAVE_VERSION}부터).`);
  }

  #loadState(useSnapshot: boolean): { state: GameState; lastSeq: number } {
    const snapshot = useSnapshot ? this.#db.select().from(schema.snapshots).orderBy(desc(schema.snapshots.seq)).limit(1).get() : undefined;
    let state = snapshot ? this.#schemas.state.parse(snapshot.state) : EMPTY_STATE;
    let lastSeq = snapshot?.seq ?? 0;
    const rows = this.#db
      .select()
      .from(schema.events)
      .where(gt(schema.events.seq, lastSeq))
      .orderBy(asc(schema.events.seq))
      .all();
    for (const row of rows) {
      state = applyEvent(state, this.#schemas.event.parse(row.payload));
      lastSeq = row.seq;
    }
    return { state, lastSeq };
  }
}

/**
 * 세이브 파일을 archive/ 폴더로 옮긴다 (새 게임을 시작할 때).
 * 기록을 지우지 않고 보관한다. 파일은 닫힌 상태여야 한다. 옮긴 경로를 돌려준다.
 */
export function archiveSave(path: string, now = new Date(), archiveDir = join(dirname(path), "archive")): string | null {
  if (!existsSync(path)) return null;
  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const target = join(archiveDir, `${basename(path, ".db")}-${stamp}.db`);
  renameSync(path, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  }
  return target;
}
