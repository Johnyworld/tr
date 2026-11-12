import type { GameStore } from "../game/store.ts";
import { InMemoryGameStore } from "../game/store.ts";
import type { GameEvent } from "../game/state.ts";
import type { TranscriptEntry } from "../gm/turn.ts";

/**
 * 세이브 저장소. 게임 상태(이벤트)와 대화 기록을 함께 다룬다.
 * DB 접근은 이 인터페이스 뒤로 모은다 (나중에 Postgres로 바꿀 수 있게).
 */
export interface GameRepository extends GameStore {
  /** 세계가 만들어졌는지 (world_created 이벤트가 있는지) */
  hasWorld(): boolean;
  transcript(): readonly TranscriptEntry[];
  appendTranscript(entries: readonly TranscriptEntry[]): void;
  /** 현재 상태를 스냅샷으로 남긴다. 불러오기를 빠르게 할 뿐 원본은 이벤트다 */
  saveSnapshot(): void;
  close(): void;
}

/** 테스트와 임시 실행용 메모리 저장소 */
export class InMemoryRepository extends InMemoryGameStore implements GameRepository {
  #transcript: TranscriptEntry[] = [];

  constructor(initialEvents: GameEvent[] = []) {
    super(initialEvents);
  }

  hasWorld() {
    return this.getState().worldId !== "";
  }

  transcript() {
    return this.#transcript;
  }

  appendTranscript(entries: readonly TranscriptEntry[]) {
    this.#transcript.push(...structuredClone(entries));
  }

  saveSnapshot() {}

  close() {}
}
