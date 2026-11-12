import { creationRules, randomAbilityBuy, randomTraits, createSeededRng, type CharacterChoice, type GameWorld, type PlayerView, type TranscriptView, type WorldManager } from "@trpg/core";
import { runGmTurn, type EpitaphWriter, type LanguageModel, type Summarizer, type TurnEvent } from "@trpg/gm";

export class TurnInProgressError extends Error {}
/** 시작 화면: 아직 연 세계가 없다 */
export class NoWorldError extends Error {
  constructor() {
    super("열린 세계가 없습니다. 시작 화면에서 세이브를 고르거나 새 게임을 시작하세요.");
  }
}

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
  #world: GameWorld | null;
  #busy = false;

  constructor(
    private readonly manager: WorldManager,
    private readonly model: LanguageModel,
    private readonly summarizer?: Summarizer,
    world?: GameWorld,
    private readonly epitaphWriter?: EpitaphWriter,
  ) {
    // 서버를 켜도 세계를 바로 열지 않는다 (시작 화면에서 고른다. 그동안 MCP 모드가 어느 세계든 열 수 있다)
    this.#world = world ?? null;
  }

  get world(): GameWorld {
    if (!this.#world) throw new NoWorldError();
    return this.#world;
  }

  get scenarioName() {
    return this.manager.content.scenario.name;
  }

  get hasWorld() {
    return this.#world !== null;
  }

  /** 세이브 슬롯 (지금 이 세션이 연 세계는 current) */
  slots() {
    const current = this.#world?.id ?? null;
    return this.manager.listSlots().map((slot) => ({ ...slot, current: slot.id === current, lockedBy: slot.id === current ? null : slot.lockedBy }));
  }

  /** 세이브를 연다 (지금 세계는 닫는다). 다른 곳에서 열려 있으면 WorldLockedError */
  openWorld(worldId: string) {
    if (this.#busy) throw new TurnInProgressError();
    if (this.#world?.id === worldId) return;
    const next = this.manager.open(worldId, "web");
    this.#world?.close();
    this.#world = next;
  }

  /** 세이브를 지운다. 지금 이 세션이 연 세계나 다른 곳에서 열린 세계는 지우지 않는다 */
  deleteWorld(worldId: string) {
    if (this.#world?.id === worldId) throw new TurnInProgressError();
    this.manager.deleteWorld(worldId);
  }

  /** 지금 세계를 닫고 시작 화면으로 (세이브는 그대로 남는다) */
  closeWorld() {
    if (this.#busy) throw new TurnInProgressError();
    this.#world?.close();
    this.#world = null;
  }

  get busy() {
    return this.#busy;
  }

  view(): GameView {
    return {
      ...this.world.intro(),
      player: this.world.playerView(),
      transcript: this.world.transcriptView(),
      busy: this.#busy,
      succession: this.world.isPlayerDead()
        ? { chronicle: this.world.chronicleText(), options: this.world.successionOptions() }
        : null,
    };
  }

  /** 사망 뒤 다음 캐릭터로 이어 간다 */
  chooseNextCharacter(choice: string, name: string | null) {
    if (this.#busy) throw new TurnInProgressError();
    return this.world.chooseNextCharacter(choice, name);
  }

  /** 지금 세계를 닫고 새 세계를 연다 (지금 세계는 saves/worlds/에 그대로 남는다). 캐릭터 생성에서 고른 것을 받는다 */
  newWorld(choice?: CharacterChoice) {
    if (this.#busy) throw new TurnInProgressError();
    const next = this.manager.create("web", undefined, choice); // 규칙 위반이면 지금 세계를 닫기 전에 던진다
    this.#world?.close();
    this.#world = next;
  }

  /** 캐릭터 생성 규칙 (첫 시작 역할 기준) */
  creationRules() {
    return creationRules(this.manager.content, Object.keys(this.manager.content.roles)[0] ?? "");
  }

  /** 생성 화면의 트레잇 "무작위" 버튼 */
  randomTraits() {
    return randomTraits(this.manager.content.scenario, createSeededRng(Math.floor(Math.random() * 2 ** 31)));
  }

  /** 생성 화면의 "무작위" 버튼 */
  randomAbilities() {
    return randomAbilityBuy(this.manager.content.scenario, createSeededRng(Math.floor(Math.random() * 2 ** 31)));
  }

  close() {
    this.#world?.close();
    this.#world = null;
  }

  /**
   * 턴을 실행한다. 소비자가 중간에 멈추면(연결 끊김) 모델 호출을 중단하고 남은 처리를 마친다.
   * 상태 이벤트와 대화 기록은 생기는 대로 저장되므로 빠지지 않는다.
   */
  async *playTurn(input: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.#busy) throw new TurnInProgressError();
    const world = this.world;
    this.#busy = true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    const turn = runGmTurn({
      model: this.model,
      world,
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
