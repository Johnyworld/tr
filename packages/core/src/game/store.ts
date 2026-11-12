import { applyEvent, EMPTY_STATE, type GameEvent, type GameState } from "./state.ts";

/**
 * 게임 상태 저장소. 이벤트를 append-only로 쌓고 상태를 갱신한다.
 * 메모리 구현(테스트용)과 SQLite 구현(persistence/)이 있다.
 */
export interface GameStore {
  getState(): GameState;
  /** 이벤트를 적용하고 기록한다. 적용에 실패하면 기록하지 않고 예외를 던진다 */
  append(event: GameEvent): GameState;
  events(): readonly GameEvent[];
}

export class InMemoryGameStore implements GameStore {
  #state: GameState;
  #events: GameEvent[] = [];

  constructor(initialEvents: GameEvent[] = []) {
    this.#state = EMPTY_STATE;
    for (const event of initialEvents) this.append(event);
  }

  getState(): GameState {
    return this.#state;
  }

  append(event: GameEvent): GameState {
    this.#state = applyEvent(this.#state, event);
    this.#events.push(event);
    return this.#state;
  }

  events(): readonly GameEvent[] {
    return this.#events;
  }
}
