import type { GameState } from "../game/state.ts";
import type { TurnSummary } from "../engine/log.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { DEED_TAG_LABELS } from "../game/reputation.ts";
import { formatTime } from "../rules/time.ts";
import type { Embedder } from "./embedder.ts";
import { RagIndex, type IndexChunk, type SearchOptions, type Viewer } from "./index.ts";
import type { LoreSearch } from "./library.ts";

/**
 * memory 컬렉션 (기획서 11.4): 플레이 중 쌓이는 장기 기억.
 * 세이브에 있는 것(요약, 행적, 믿음)에서 만들어지는 파생 데이터라, 언제든 세이브로부터 다시 맞출 수 있다.
 * 각 기억에는 그것을 아는 캐릭터(knownBy)를 붙인다. 검색은 현재 캐릭터가 아는 기억만 돌려준다.
 */

export type MemoryKind = "turn_summary" | "scene_summary" | "deed" | "belief";

/** 세이브에서 기억 청크를 모은다. id는 세이브가 append-only라 안정적이다 */
export function memoryItemsOf(state: GameState, summaries: readonly TurnSummary[]): IndexChunk[] {
  const items: IndexChunk[] = [];
  const memo = (id: string, kind: MemoryKind, title: string, text: string, knownBy: string[], createdAt: number): IndexChunk => ({
    id,
    sourceId: `memory/${kind}`,
    title,
    section: "",
    visibility: "known_by",
    kind,
    knownBy,
    createdAt,
    text,
  });

  summaries.forEach((s, i) => {
    const kind: MemoryKind = s.kind === "scene" ? "scene_summary" : "turn_summary";
    const label = s.kind === "scene" ? "장면 요약" : "지난 일";
    // 캐릭터 id가 없던 이전 요약은 그때의 플레이어 캐릭터로 본다
    const owner = s.characterId || state.playerId;
    items.push(memo(`summary:${i}`, kind, label, `[${formatTime(s.time)} · ${label}] ${s.text}`, [owner], s.time));
  });

  for (const deed of Object.values(state.deeds)) {
    // 행적은 한 사람과, 그 일을 보거나 전해 들은 사람이 안다 (소문이 퍼지면 늘어난다)
    const knowers = Object.entries(state.deedKnowledge)
      .filter(([, known]) => known[deed.id])
      .map(([npcId]) => npcId);
    const tags = deed.tags.map((t) => DEED_TAG_LABELS[t]).join("·");
    items.push(
      memo(`deed:${deed.id}`, "deed", "행적", `[${formatTime(deed.at)} · 행적] ${deed.summary} (${tags})`, [deed.actorId, ...knowers].sort(), deed.at),
    );
  }

  for (const [characterId, beliefs] of Object.entries(state.beliefs)) {
    for (const b of beliefs) {
      items.push(
        memo(
          `belief:${characterId}:${b.id}`,
          "belief",
          "알게 된 것",
          `[${formatTime(b.learnedAt)} · ${BELIEF_SOURCE_LABELS[b.source]}] ${b.fact}`,
          [characterId],
          b.learnedAt,
        ),
      );
    }
  }
  return items;
}

/**
 * 세계 하나의 memory 색인 (saves/worlds/<id>.memory.db).
 * 맞추기(sync)는 차례로 실행되고, 검색은 그때까지의 맞추기가 끝난 뒤에 한다 (방금 저장한 기억도 찾게).
 */
export class MemoryStore {
  #index: RagIndex;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(index: RagIndex) {
    this.#index = index;
  }

  static open(path: string, embedder: Embedder): MemoryStore {
    return new MemoryStore(RagIndex.open(path, embedder));
  }

  /** 세이브에서 모은 기억에 색인을 맞춘다. 새 것·바뀐 것만 임베딩한다 */
  sync(items: readonly IndexChunk[]): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#closed) return;
      await this.#index.upsert(items, { removeMissingWithPrefix: "" });
    });
    this.#queue = run.catch((err: unknown) => console.error(`[rag] memory 적재 실패: ${err instanceof Error ? err.message : String(err)}`));
    return this.#queue.then(() => undefined);
  }

  async search(query: string, viewer: Viewer, options?: SearchOptions): Promise<LoreSearch> {
    await this.#queue;
    if (this.#closed) return { hits: [], trace: null, error: "닫힌 세계" };
    const result = await this.#index.search(query, viewer, options);
    // 같은 문장의 기억(같은 일을 두 번 요약한 경우 등)은 한 번만 보여 준다
    const seen = new Set<string>();
    const body = (text: string) => text.replace(/^\[[^\]]*\]\s*/, "");
    return { ...result, hits: result.hits.filter((h) => !seen.has(body(h.text)) && seen.add(body(h.text))) };
  }

  count(): number {
    return this.#index.count();
  }

  async close() {
    await this.#queue;
    this.#closed = true;
    this.#index.close();
  }
}
