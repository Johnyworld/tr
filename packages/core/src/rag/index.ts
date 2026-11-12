import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Embedder } from "./embedder.ts";
import type { LoreChunk } from "./chunk.ts";

/**
 * RAG 색인 (기획서 11.4): SQLite + sqlite-vec(벡터) + FTS5(키워드), RRF로 병합.
 * 벡터 검색·임베딩 모델은 가져다 쓰고, 청킹·메타데이터·필터·병합·잘라내기는 여기서 직접 한다.
 * 색인은 콘텐츠에서 다시 만들 수 있는 파생 데이터다 (.cache/rag/).
 */

/** 검색하는 캐릭터. 이 캐릭터가 볼 수 없는 청크는 결과에 절대 나오지 않는다 (원칙 4) */
export type Viewer = { factionId: string; flags: ReadonlySet<string> };

/** 공개 범위 판정: public | faction:<id> | secret:<flag> */
export function canSee(visibility: string, viewer: Viewer): boolean {
  if (visibility === "public") return true;
  const [kind, value] = visibility.split(":") as [string, string];
  if (kind === "faction") return viewer.factionId === value;
  if (kind === "secret") return viewer.flags.has(value);
  return false; // 모르는 형식은 보여 주지 않는다
}

export type SearchOptions = {
  /** 최종으로 돌려줄 최대 청크 수 */
  topK?: number;
  /** 결과 본문 글자 수 합의 상한 (토큰 예산 대신) */
  charBudget?: number;
  /** 벡터·키워드 검색에서 각각 가져올 후보 수 */
  candidates?: number;
  /** RRF 가중치 */
  weights?: { vector: number; keyword: number };
  /** RRF 상수 */
  rrfK?: number;
};

export const DEFAULT_SEARCH: Required<SearchOptions> = {
  topK: 4,
  charBudget: 2400,
  candidates: 20,
  weights: { vector: 1, keyword: 1 },
  rrfK: 60,
};

export type SearchHit = {
  id: string;
  sourceId: string;
  title: string;
  section: string;
  text: string;
  /** RRF 점수 */
  score: number;
  /** 어느 경로로 들어왔는지 (디버깅): 각 검색에서의 순위, 없으면 null */
  vectorRank: number | null;
  keywordRank: number | null;
};

export type SearchTrace = {
  query: string;
  keywordQuery: string | null;
  /** 필터 전 후보 수 */
  candidates: number;
  /** 정보 필터로 빠진 후보 수 (어떤 청크인지는 남기지 않는다) */
  filtered: number;
  /** 예산·개수로 잘린 청크 id */
  dropped: string[];
  hits: { id: string; score: number; vectorRank: number | null; keywordRank: number | null }[];
};

export type SyncReport = { added: number; updated: number; removed: number; unchanged: number; chunks: number };

export type SourceDoc = { sourceId: string; hash: string; chunks: LoreChunk[] };

/** 한국어 조사를 떼어 키워드 검색어를 만든다 ("강태호는" → "강태호") */
const JOSA = /(으로|에서|에게|한테|까지|부터|이다|이랑|은|는|이|가|을|를|의|에|와|과|도|로|만)$/;

export function keywordQuery(query: string): string | null {
  const terms = new Set<string>();
  for (const raw of query.split(/[\s,.!?'"“”‘’()[\]{}:;·…~\-]+/)) {
    const term = raw.trim().replaceAll('"', "");
    // 끝 글자가 조사인지 단어의 일부인지("고가도로"의 "로") 알 수 없으므로 원래 말과 뗀 말을 둘 다 찾는다
    const stripped = term.length > 3 ? term.replace(JOSA, "") : term;
    // trigram 토크나이저는 3글자 이상이어야 찾을 수 있다
    for (const t of [term, stripped]) if (t.length >= 3) terms.add(t);
  }
  return terms.size ? [...terms].map((t) => `"${t}"`).join(" OR ") : null;
}

export class RagIndex {
  #db: Database.Database;

  private constructor(
    db: Database.Database,
    readonly embedder: Embedder,
  ) {
    this.#db = db;
    this.#prepare();
  }

  /** 색인을 연다. 임베딩 모델이나 차원이 바뀌었으면 비우고 다시 만든다 */
  static open(path: string, embedder: Embedder): RagIndex {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    return new RagIndex(db, embedder);
  }

  #prepare() {
    const db = this.#db;
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    if (get("model_id") !== this.embedder.id || get("dimensions") !== String(this.embedder.dimensions)) {
      // 모델이 바뀌면 재임베딩 (기획서 11.4)
      db.exec(`
        DROP TABLE IF EXISTS chunks_vec;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS sources;
      `);
      const set = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      set.run("model_id", this.embedder.id);
      set.run("dimensions", String(this.embedder.dimensions));
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (source_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        visibility TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.embedder.dimensions}] distance_metric=cosine);
    `);
  }

  /**
   * 문서 목록에 맞춰 색인을 갱신한다. 해시가 같은 문서는 건너뛰고(재임베딩 없음),
   * 바뀐 문서는 청크를 갈아 끼우고, 없어진 문서는 지운다.
   */
  async sync(docs: readonly SourceDoc[]): Promise<SyncReport> {
    const db = this.#db;
    const known = new Map(
      (db.prepare("SELECT source_id, hash FROM sources").all() as { source_id: string; hash: string }[]).map((r) => [r.source_id, r.hash]),
    );
    const report: SyncReport = { added: 0, updated: 0, removed: 0, unchanged: 0, chunks: 0 };
    const changed = docs.filter((d) => {
      const old = known.get(d.sourceId);
      if (old === d.hash) {
        report.unchanged++;
        return false;
      }
      if (old === undefined) report.added++;
      else report.updated++;
      return true;
    });
    const removed = [...known.keys()].filter((id) => !docs.some((d) => d.sourceId === id));
    report.removed = removed.length;

    // 임베딩은 트랜잭션 밖에서 (비동기)
    const chunks = changed.flatMap((d) => d.chunks);
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    report.chunks = chunks.length;

    const deleteSource = (sourceId: string) => {
      const rows = db.prepare("SELECT rowid, text FROM chunks WHERE source_id = ?").all(sourceId) as { rowid: number; text: string }[];
      for (const r of rows) {
        db.prepare("INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', ?, ?)").run(r.rowid, r.text);
        db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(BigInt(r.rowid));
      }
      db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
      db.prepare("DELETE FROM sources WHERE source_id = ?").run(sourceId);
    };

    db.transaction(() => {
      for (const id of removed) deleteSource(id);
      let i = 0;
      for (const doc of changed) {
        deleteSource(doc.sourceId);
        for (const chunk of doc.chunks) {
          const { lastInsertRowid } = db
            .prepare("INSERT INTO chunks (id, source_id, title, section, visibility, text) VALUES (?, ?, ?, ?, ?, ?)")
            .run(chunk.id, chunk.sourceId, chunk.title, chunk.section, chunk.visibility, chunk.text);
          db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)").run(lastInsertRowid, chunk.text);
          db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(lastInsertRowid), vectors[i++]!);
        }
        db.prepare("INSERT INTO sources (source_id, hash) VALUES (?, ?)").run(doc.sourceId, doc.hash);
      }
    })();
    return report;
  }

  /**
   * 하이브리드 검색: 벡터 + 키워드 → 정보 필터 → RRF 병합 → 개수·글자 예산으로 자르기.
   * 필터는 순위를 매기기 전에 적용한다. 볼 수 없는 청크는 점수 계산에도 결과에도 남지 않는다.
   */
  async search(query: string, viewer: Viewer, options: SearchOptions = {}): Promise<{ hits: SearchHit[]; trace: SearchTrace }> {
    const opts = { ...DEFAULT_SEARCH, ...options, weights: { ...DEFAULT_SEARCH.weights, ...options.weights } };
    const db = this.#db;
    type Row = { rowid: number; id: string; source_id: string; title: string; section: string; visibility: string; text: string };
    const byRowid = (rowid: number) => db.prepare("SELECT rowid, * FROM chunks WHERE rowid = ?").get(rowid) as Row | undefined;

    const [vector] = await this.embedder.embed([query]);
    const vectorRows = (
      db
        .prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
        .all(vector!, opts.candidates) as { rowid: number; distance: number }[]
    ).map((r) => byRowid(Number(r.rowid)));

    const match = keywordQuery(query);
    const keywordRows = match
      ? (db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?").all(match, opts.candidates) as { rowid: number }[]).map(
          (r) => byRowid(r.rowid),
        )
      : [];

    const all = new Map<number, Row>();
    for (const r of [...vectorRows, ...keywordRows]) if (r) all.set(r.rowid, r);
    const visible = (r: Row | undefined): r is Row => r !== undefined && canSee(r.visibility, viewer);
    const vectorRanked = vectorRows.filter(visible);
    const keywordRanked = keywordRows.filter(visible);
    const filtered = [...all.values()].filter((r) => !canSee(r.visibility, viewer)).length;

    const scores = new Map<number, { row: Row; score: number; vectorRank: number | null; keywordRank: number | null }>();
    const add = (rows: Row[], weight: number, key: "vectorRank" | "keywordRank") =>
      rows.forEach((row, i) => {
        const entry = scores.get(row.rowid) ?? { row, score: 0, vectorRank: null, keywordRank: null };
        entry.score += weight / (opts.rrfK + i + 1);
        entry[key] = i + 1;
        scores.set(row.rowid, entry);
      });
    add(vectorRanked, opts.weights.vector, "vectorRank");
    add(keywordRanked, opts.weights.keyword, "keywordRank");

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
    const hits: SearchHit[] = [];
    const dropped: string[] = [];
    let used = 0;
    for (const e of ranked) {
      if (hits.length >= opts.topK || (hits.length > 0 && used + e.row.text.length > opts.charBudget)) {
        dropped.push(e.row.id);
        continue;
      }
      used += e.row.text.length;
      hits.push({
        id: e.row.id,
        sourceId: e.row.source_id,
        title: e.row.title,
        section: e.row.section,
        text: e.row.text,
        score: e.score,
        vectorRank: e.vectorRank,
        keywordRank: e.keywordRank,
      });
    }
    return {
      hits,
      trace: {
        query,
        keywordQuery: match,
        candidates: all.size,
        filtered,
        dropped,
        hits: hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(5)), vectorRank: h.vectorRank, keywordRank: h.keywordRank })),
      },
    };
  }

  /** 색인된 청크 수 */
  count(): number {
    return (this.#db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  }

  close() {
    this.#db.close();
  }
}
