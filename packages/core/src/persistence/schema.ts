import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 세계 세이브 DB 스키마. 세계 하나 = DB 파일 하나 (기획서 12.2).
 * events와 transcript는 append-only다 (UPDATE/DELETE를 트리거로 막는다).
 * 스키마를 바꾸면 `pnpm --filter @trpg/core db:generate` 로 마이그레이션을 만든다.
 */

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** 상태 변경의 원본 기록 */
export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 불러오기를 빠르게 하는 상태 사본. seq까지의 이벤트를 적용한 결과다 */
export const snapshots = sqliteTable("snapshots", {
  seq: integer("seq").primaryKey(),
  state: text("state", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 화면과 GM 프롬프트에 쓰는 대화 기록 */
export const transcript = sqliteTable("transcript", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turn: integer("turn").notNull(),
  entry: text("entry", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 턴·장면 요약 (기획서 11.5). 모드를 바꿔도 이야기가 이어지게 한다 */
export const summaries = sqliteTable("summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  turn: integer("turn").notNull(),
  time: integer("time").notNull(),
  mode: text("mode").notNull(),
  /** 요약을 남긴 시점의 플레이어 캐릭터 (memory 검색의 knownBy) */
  characterId: text("character_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

/** RAG 검색 기록 (디버깅, 기획서 11.4). 어떤 청크가 왜 들어갔는지. 게임 상태는 바꾸지 않는다 */
export const retrievals = sqliteTable("retrievals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turn: integer("turn").notNull(),
  time: integer("time").notNull(),
  mode: text("mode").notNull(),
  collection: text("collection").notNull(),
  purpose: text("purpose").notNull(),
  trace: text("trace", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});
