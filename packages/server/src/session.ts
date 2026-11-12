import type { GameWorld, PlayerView, TranscriptView, WorldManager } from "@trpg/core";
import { runGmTurn, type EpitaphWriter, type LanguageModel, type Summarizer, type TurnEvent } from "@trpg/gm";

export class TurnInProgressError extends Error {}

export type GameView = {
  worldId: string;
  scenarioName: string;
  opening: string;
  player: PlayerView;
  transcript: TranscriptView[];
  busy: boolean;
  /** 사망했을 때만: 연대기와 다음 캐릭터 후보 */
  succession: { chronicle: string; options: { id: string; label: string; detail: string }[] } | null;
};

/**
 * 웹 앱 모드의 세션: 열린 세계 하나와 진행 중인 턴을 관리한다.
 * 게임 규칙·정보 필터는 core(GameWorld), GM 호출은 gm(runGmTurn)에 있고, 여기는 HTTP 쪽 흐름만 다룬다.
 */
export class WebSession {
  #world: GameWorld;
  #busy = false;

  constructor(
    private readonly manager: WorldManager,
    private readonly model: LanguageModel,
    private readonly summarizer?: Summarizer,
    world?: GameWorld,
    private readonly epitaphWriter?: EpitaphWriter,
  ) {
    this.#world = world ?? manager.openLatest("web");
  }

  get world(): GameWorld {
    return this.#world;
  }

  get busy() {
    return this.#busy;
  }

  view(): GameView {
    return {
      ...this.#world.intro(),
      player: this.#world.playerView(),
      transcript: this.#world.transcriptView(),
      busy: this.#busy,
      succession: this.#world.isPlayerDead()
        ? { chronicle: this.#world.chronicleText(), options: this.#world.successionOptions() }
        : null,
    };
  }

  /** 사망 뒤 다음 캐릭터로 이어 간다 */
  chooseNextCharacter(choice: string, name: string | null) {
    if (this.#busy) throw new TurnInProgressError();
    return this.#world.chooseNextCharacter(choice, name);
  }

  /** 지금 세계를 닫고 새 세계를 연다 (지금 세계는 saves/worlds/에 그대로 남는다) */
  newWorld() {
    if (this.#busy) throw new TurnInProgressError();
    this.#world.close();
    this.#world = this.manager.create("web");
  }

  close() {
    this.#world.close();
  }

  /**
   * 턴을 실행한다. 소비자가 중간에 멈추면(연결 끊김) 모델 호출을 중단하고 남은 처리를 마친다.
   * 상태 이벤트와 대화 기록은 생기는 대로 저장되므로 빠지지 않는다.
   */
  async *playTurn(input: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.#busy) throw new TurnInProgressError();
    this.#busy = true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    const turn = runGmTurn({
      model: this.model,
      world: this.#world,
      input,
      signal: abort.signal,
      ...(this.summarizer ? { summarizer: this.summarizer } : {}),
      ...(this.epitaphWriter ? { epitaphWriter: this.epitaphWriter } : {}),
    });
    let step: IteratorResult<TurnEvent, void> | undefined;
    try {
      step = await turn.next();
      while (!step.done) {
        yield step.value;
        step = await turn.next();
      }
    } finally {
      if (step && !step.done) {
        abort.abort();
        while (!step.done) step = await turn.next();
      }
      signal?.removeEventListener("abort", onAbort);
      this.#busy = false;
    }
  }
}
