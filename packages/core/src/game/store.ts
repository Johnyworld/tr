import { applyEvent, type GameEvent, type GameState } from "./state.ts";

/**
 * 게임 상태 저장소. 이벤트를 append-only로 쌓고 상태를 갱신한다.
 * 지금은 메모리 구현만 있다. 4단계에서 SQLite 구현으로 바꾼다.
 */
export interface GameStore {
  getState(): GameState;
  append(event: GameEvent): GameState;
  events(): readonly GameEvent[];
}

export class InMemoryGameStore implements GameStore {
  #state: GameState;
  #events: GameEvent[] = [];

  constructor(initial: GameState) {
    this.#state = initial;
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
