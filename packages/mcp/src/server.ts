import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  argsHelp,
  buildGmGuide,
  isCommand,
  CharacterChoiceError,
  characterChoiceSchema,
  answerNewGame,
  backNewGame,
  createSeededRng,
  creationRules,
  describeNewGameStep,
  newGameStep,
  newGameView,
  withPortraitStep,
  heirDraft,
  newGameDraft,
  worldInfo,
  type Content,
  type NewGameDraft,
  type Rng,
  type Scenario,
  formatReferences,
  formatSlotLine,
  createTakeActionSchema,
  heirSeat,
  parseNewAs,
  gmTools,
  timeSegmentSchema,
  WorldLockedError,
  type GameWorld,
  type ToolOutcome,
  type WorldManager,
} from "@trpg/core";

/**
 * MCP 어댑터 (기획서 11.6). core만 쓰고 게임 로직은 두지 않는다 (원칙 9).
 * - Claude는 tool 결과로 받은 정보만 본다. 결과 텍스트는 모두 core가 정보 필터를 거쳐 만든다
 * - 시간 경과와 상태 변경은 tool을 거쳐야만 일어난다
 * - 로그는 stderr로만 (stdout은 MCP 프로토콜 전용, 원칙 12)
 */

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (body: string, isError = false): TextResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

const NO_WORLD = "열린 세계가 없습니다 (플레이어가 상태 화면에서 게임을 끝냈을 수 있다: 그렇다면 짧게 마무리 인사를 하고, 다시 하려면 /play라고 알린다). 새로 열려면 start_session(또는 load_world)을 호출하세요.";
/** 세션을 시작할 때 GM이 할 일 (MCP prompt `play`, Claude Code 스킬 /play 가 같은 흐름) */
export const PLAY_START =
  "지금 list_worlds를 호출한다. 상태 화면 주소가 있으면 먼저 어디서 고를지 묻는다: 상태 화면에서(start_session(in_browser: true): 메인 메뉴에서 이어 할 게임이나 새 게임을 고르고 만들 때까지 기다린다) / 채팅으로. " +
  "채팅이면 목록(0번 새 게임, 1번부터 저장된 게임)을 그대로 보여 주고 어느 것을 할지 묻는다. 번호를 고르면 start_session(slot)으로 연다. 새 게임이면 월드 → 시나리오 → 캐릭터 → 수위 → 서술 방식을 create_character로 한 단계씩 고른다 (마지막 것을 고르면 세계가 열린다). 고르기 전에는 세계를 열지 않는다. " +
  "플레이어가 그만하자고 하면 end_session으로 닫는다.";

const HELP_HINT = "플레이어에게 한 줄 안내 (존댓말): \"?도움말로 정보 명령어를 볼 수 있습니다.\" (이 모드에서는 \"!\" 대신 \"?\"를 쓴다. Claude 앱은 줄 맨 앞의 !를 셸 명령으로 바꾼다)";

/** 주인공이 죽은 뒤 GM이 서술할 동안 상태 화면에 사망을 미루는 최대 시간 */
const DEATH_HOLD_MS = 120 * 1000;

/** 상태 화면을 기다리는 tool이 기다리는 최대 시간. 넘으면 "다 했어"를 기다렸다가 create_character(wait)로 이어 간다 */
const SCREEN_WAIT_MS = Number(process.env.TRPG_CREATE_WAIT_MS ?? 10 * 60 * 1000);
/** 기다리는 동안 연결을 잇는 진행 알림 간격 */
const KEEP_ALIVE_MS = 15 * 1000;

/** tool 호출의 부가 정보 중 기다리기에 쓰는 것 */
type WaitExtra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

/** 상태 화면이 보내는 만들기 답. version: 화면이 보고 있던 초안의 판 (어긋나면 거절), menu: 첫 단계에서 메인 메뉴로 */
export type ScreenCreationInput = { answer?: string | string[]; back?: boolean; menu?: boolean; version?: number };
/** 상태 화면 메인 메뉴에서 고른 것 (12-214) */
export type MenuInput = { action: "new" | "open" | "delete"; id?: string };
type Done = { ok: true } | { ok: false; error: string };

export type CharacterChoiceInput = z.infer<ReturnType<typeof characterChoiceSchema>>;

export function createMcpServer(
  manager: WorldManager,
  options: {
    statusUrl?: () => string | null;
    /** 치트(개발 모드)를 연다 */ debug?: boolean;
    /** 캐릭터 생성의 무작위 (테스트에서 고정) */ rng?: Rng;
    /** 상태 화면을 한 번에 기다리는 시간 (테스트용) */ creationWaitMs?: number;
  } = {},
) {
  const packs = manager.packs;
  /** 세계를 열기 전(목록·새 게임)에 쓰는 기본 월드 */
  const defaultContent = manager.content;
  const server = new McpServer({ name: "trpg", version: "0.0.0" });
  // SDK가 인자를 먼저 검증해 core의 인자 안내가 닿지 않는다: SDK 검증 오류에 같은 안내를 붙인다 (12-261, PT16 네 판)
  {
    const sdk = server as unknown as { validateToolInput(tool: { inputSchema?: unknown }, args: unknown, name: string): Promise<unknown> };
    const validate = sdk.validateToolInput.bind(server);
    sdk.validateToolInput = async (tool, args, name) => {
      try {
        return await validate(tool, args, name);
      } catch (err) {
        const help = tool.inputSchema && err instanceof Error ? argsHelp(name, tool.inputSchema as Parameters<typeof argsHelp>[1], args) : null;
        if (help && err instanceof Error) err.message = `${err.message}\n${help}`;
        throw err;
      }
    };
  }
  let world: GameWorld | null = null;

  const rng = options.rng ?? createSeededRng(Math.floor(Math.random() * 2 ** 31));
  const firstRole = (c: Content) => Object.keys(c.roles)[0] ?? "";
  /** 지금 열린 세계의 월드 이름 (상태 화면 머리) */
  const titleOf = (c: Content) => worldInfo(c).title;
  /**
   * 주인공이 죽은 순간: GM이 무슨 일이 있었는지 채팅에 서술할 때까지 상태 화면은 죽기 직전 모습을 보여 준다.
   * GM이 서술 뒤에 부르는 write_epitaph·get_chronicle·choose_next_character, 또는 시간이 지나면 풀린다
   */
  let frozen: { payload: unknown; until: number } | null = null;
  const releaseFrozen = () => {
    frozen = null;
  };
  const sheetPayload = (w: GameWorld) => ({ open: true, scenarioName: titleOf(w.content), worldId: w.id, player: w.playerView() });
  const withWorld = (fn: (w: GameWorld) => TextResult): TextResult => {
    if (!world) return text(NO_WORLD, true);
    const wasDead = world.isPlayerDead();
    const before = wasDead ? null : sheetPayload(world);
    const result = fn(world);
    if (before && world?.isPlayerDead() && !frozen) frozen = { payload: before, until: Date.now() + DEATH_HOLD_MS };
    return result;
  };
  const fromOutcome = (outcome: ToolOutcome, extra = ""): TextResult =>
    outcome.ok ? text(outcome.resultText + extra) : text(outcome.error, true);

  /**
   * 새 세션의 GM이 바로 이어 갈 수 있게: GM 지침, 세계 정보, 지난 이야기, 현재 장면.
   * Claude Code에서는 MCP prompt(play)를 사용자가 직접 불러야 보이므로 지침을 여기에도 넣는다.
   */
  const sessionStart = (w: GameWorld) => {
    const intro = w.intro();
    const recap = w.recap();
    return text(
      [
        `# GM 지침 (이 세션 내내 따른다)\n\n${w.guide()}`,
        `\n---\n\n세계 ${intro.worldId} (${intro.scenarioName})를 열었다. [trpg-world:${intro.worldId}]`,
        recap ? `\n${recap}` : `\n새로 시작하는 세계다. 시작 장면: ${intro.opening}`,
        ...(() => {
          const notes = w.takeOpeningNotes();
          return notes.length ? [`\n## 지난번 뒤에 일어난 일 (먼저 서술한다)\n${notes.join("\n")}`] : [];
        })(),
        `\n## 현재 장면\n${w.sceneForGm()}`,
        ...(w.isPlayerDead() ? [sceneAfter(w)] : []),
        `\n${HELP_HINT}`,
        ...(options.statusUrl?.()
          ? [
              `\n상태 화면: ${options.statusUrl()} — 플레이어에게 한 번 알려 준다: "캐릭터 시트를 옆에 띄워 두려면 이 주소를 앱의 브라우저 패널(또는 브라우저)에서 여세요." 서술은 지금처럼 채팅에 쓴다.`,
            ]
          : []),
      ].join("\n"),
    );
  };

  /**
   * 대화로 하는 캐릭터 생성 (기획서 11.6): 한 단계씩 묻는다. 초안은 메모리에만 있고, 마지막 확인에서 세계(또는 새 캐릭터)를 만든다.
   * new_world: 새 게임 / heir: 사망 뒤 같은 세계의 새 캐릭터
   */
  let draft: NewGameDraft | null = null;
  /** 초안의 판: 바뀔 때마다 1씩. 화면이 옛 단계에 답하지 않게 (12-214) */
  let draftVersion = 0;
  const setDraft = (d: NewGameDraft | null) => {
    draft = d;
    draftVersion++;
  };
  /**
   * 지금 만들기를 어디서 하는지 (12-214). 한 번 정하면 끝까지 그곳에서 한다 (도중에 화면 ↔ 채팅으로 넘기지 않는다).
   * 화면이면 얼굴 단계가 있다. 채팅이면 화면은 진행을 보여 주기만 한다
   */
  let driver: "screen" | "chat" = "chat";
  /** 메인 메뉴의 새로운 게임으로 연 만들기 (첫 단계에서 메인 메뉴로 돌아갈 수 있다) */
  let fromMenu = false;
  const resetCreation = () => {
    setDraft(null);
    driver = "chat";
    fromMenu = false;
  };
  const creationStep = (d: NewGameDraft) => text(describeNewGameStep(packs, d));

  /**
   * 상태 화면을 기다리는 GM의 tool 호출들 (12-67, 12-214). MCP 서버는 세션에 먼저 말을 걸 수 없어서 기다리는 tool 호출이 그 자리를 대신한다.
   * 화면은 GM이 기다리고 있을 때만 쓰는 리모컨이다: 게임을 열거나 새로 시작하는 것은 기다리는 GM이 있을 때만 된다.
   * 예외: 기다림이 시간을 넘긴 뒤 화면에서 만들기를 마치면 결과를 finished에 두고, GM의 다음 기다림(create_character(wait))이 받는다
   */
  const waiters = new Set<(r: TextResult) => void>();
  let finished: TextResult | null = null;
  const deliver = (r: TextResult) => {
    if (waiters.size) {
      for (const w of waiters) w(r);
      waiters.clear();
      return;
    }
    finished = r;
  };
  const anyCreationRules = () => [...packs.values()].some((c) => creationRules(c, firstRole(c)) !== null);

  /** 플레이어가 지금 보고 있는 게임 목록 (번호 → 세이브 id). 세계를 열면 닫힌다. 삭제는 목록이 열려 있을 때만 */
  let menu: string[] | null = null;

  const openWorld = (open: () => GameWorld): TextResult => {
    try {
      const next = open();
      world?.close();
      world = next;
      menu = null;
      finished = null;
      resetCreation();
      syncTools(next.content.scenario);
      const started = sessionStart(next);
      // 끝난 판(튜토리얼에서 죽었다)을 다시 열었으면: 이어 할 것이 없다
      if (next.storyEnded()) return { ...started, content: [...started.content, { type: "text" as const, text: `\n\n(이 판은 끝났다) ${next.storyEndedText()} 연대기는 get_chronicle로 볼 수 있다.` }] };
      return started;
    } catch (err) {
      if (err instanceof WorldLockedError) return text(err.message, true);
      if (err instanceof CharacterChoiceError) return text(`캐릭터 설정이 규칙에 맞지 않는다: ${err.message} 플레이어에게 알리고 다시 고르게 한다.`, true);
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };

  /**
   * 새 게임을 막 만들었을 때 GM에게: 시나리오의 지금 상황을 먼저 그대로 보여 주고 첫 장면으로 (캐릭터 만들기에서는 묻지 않는다)
   */
  const startingWords = (w: GameWorld | null): string => {
    const intro = w ? w.content.roles[w.state().scenarioRole]?.scenario?.intro : undefined;
    if (!intro) return "캐릭터를 만들었다. 지금 만든 사람으로 바로 첫 장면을 서술한다.";
    return [
      "캐릭터를 만들었다. 첫 장면을 서술하기 전에, 아래 \"지금 상황\"을 플레이어에게 먼저 보여 준다. 글을 고치거나 줄이지 말고, 단락(빈 줄)을 그대로 지켜 읽기 좋게 쓴다. 그다음 지금 만든 사람으로 첫 장면을 서술한다.",
      "",
      "## 지금 상황",
      intro,
    ].join("\n");
  };

  const sceneAfter = (w: GameWorld) =>
    w.isPlayerDead()
      ? w.storyEnded()
        ? "\n\n캐릭터가 사망했다. 이 판은 다음 캐릭터로 이어 갈 수 없다: 죽음을 이야기의 끝으로 서술하고 write_epitaph로 묘비명을 남긴 뒤, get_chronicle로 연대기를 보여 주고 이 판이 끝났다고 알린다. 새 게임에서 열린 시나리오를 고를 수 있다고 안내하고 end_session으로 닫는다."
        : "\n\n캐릭터가 사망했다. 죽음을 서술하고 write_epitaph로 묘비명을 남긴 뒤, get_chronicle로 연대기와 다음 캐릭터 후보를 보여 주고 플레이어가 고르면 choose_next_character를 호출하라."
      : `\n\n## 현재 장면 (지난번에서 바뀐 것)\n${w.sceneUpdate()}`;

  // ── 세계 ─────────────────────────────────────────

  /** 세이브 슬롯 메뉴: 0번 새 게임, 1번부터 저장된 게임. GM은 이 목록을 그대로 보여 주고 플레이어가 번호를 고르게 한다 */
  const slotMenu = (): string => {
    const slots = manager.listSlots();
    if (!world) menu = slots.map((s) => s.id);
    // 이 세션이 연 세계는 "사용 중"이 아니라 "지금 하는 게임"
    const lines = slots.map((slot, i) =>
      slot.id === world?.id ? `${formatSlotLine({ ...slot, lockedBy: null }, i + 1)} · (지금 하는 게임)` : formatSlotLine(slot, i + 1),
    );
    return [
      "게임 목록 (고치지 말고 그대로 보여 준다. 플레이어가 0이나 \"새 게임\"을 고르면 start_session(new_world: true), 1번부터는 start_session(slot)):",
      "",
      "0. 새 게임",
      ...(lines.length ? lines : ["(저장된 게임이 없다)"]),
      // 세션마다 MCP 서버가 따로 떠서 상태 화면 주소가 다르다 (8790, 8791, …). 이 세션의 주소를 알려 준다
      ...(options.statusUrl?.() ? ["", `(이 세션의 상태 화면: ${options.statusUrl()} — 시트는 꼭 이 주소로 안내한다. 다른 세션은 주소가 다르다)`] : []),
      ...(lines.length && !world ? ["", "(플레이어가 저장 데이터를 지우고 싶다고 하면 delete_world로 지울 수 있다. 되돌릴 수 없으니 먼저 확인받는다)"] : []),
    ].join("\n");
  };

  /** 슬롯 번호(1부터) 또는 world_id로 세계를 고른다 */
  const pickWorld = (args: { world_id?: string | null; slot?: number | null }): string | { error: string } => {
    if (args.world_id) return args.world_id;
    if (args.slot) {
      // 플레이어가 본 목록의 번호를 쓴다 (그 사이 목록이 바뀌어도 고른 게임이 열리게)
      const id = menu?.[args.slot - 1] ?? manager.listSlots()[args.slot - 1]?.id;
      if (!id) return { error: `${args.slot}번 슬롯은 없다. list_worlds로 목록을 다시 보여 준다.` };
      return id;
    }
    return { error: "slot 또는 world_id가 필요하다." };
  };

  server.registerTool(
    "list_worlds",
    { description: "게임 목록: 0번은 새 게임, 1번부터 저장된 게임(주인공 이름·계급·레벨·몸 상태, 게임 안 시각과 장소, 마지막 플레이)." },
    () => text(slotMenu()),
  );

  server.registerTool(
    "start_session",
    {
      description:
        "플레이 세션을 시작한다. slot(list_worlds의 번호, 1부터)이나 world_id를 주면 그 세계를 연다. " +
        "새 게임은 new_world: true (slot 0도 새 게임). 세계를 바로 만들지 않고 새 게임 고르기를 시작한다: 월드 → 시나리오 → 캐릭터를 create_character로 한 단계씩 고른다. " +
        "상태 화면이 있으면 먼저 플레이어에게 어디서 고를지 묻고, 상태 화면이면 in_browser: true만: 화면의 메인 메뉴에서 이어 할 게임을 열거나 새 게임을 다 만들 때까지 기다렸다가 돌려준다 (그러면 바로 이어서 서술). new_world와 in_browser를 함께 주면 메인 메뉴 없이 바로 만들기 화면. " +
        "아무것도 주지 않으면 세계를 열지 않고 게임 목록(0번 새 게임)을 돌려준다. " +
        "세계를 열면 GM 지침, 지난 이야기 요약, 현재 장면을 돌려준다.",
      inputSchema: z.strictObject({
        slot: z.number().int().min(0).nullable().optional().describe("list_worlds의 번호 (0은 새 게임)"),
        world_id: z.string().nullable().optional(),
        new_world: z.boolean().optional(),
        in_browser: z.boolean().optional().describe("상태 화면에서 고른다 (플레이어가 골랐을 때). 메인 메뉴(또는 new_world면 만들기)에서 다 고를 때까지 기다린다"),
        character: characterChoiceSchema().nullable().optional().describe("이미 다 정해진 캐릭터로 기본 월드·시나리오에서 바로 만든다 (자동 진행·테스트용). 플레이어와 함께라면 쓰지 않고 create_character로 한 단계씩"),
      }),
    },
    async (args, extra) => {
      if (args.in_browser && !args.new_world && args.slot == null && !args.world_id) {
        // 메인 메뉴에서 고를 때까지 (화면에서 이미 만들기를 시작했으면 그것을 이어 기다린다)
        if (world) return text(`이 세션에 이미 열린 게임이 있다 (${world.id}). 그대로 이어 간다: get_scene으로 현재 장면을 본다.`, true);
        return waitForScreen(extra as WaitExtra);
      }
      resetCreation();
      if (args.new_world || args.slot === 0) {
        if (!args.character && anyCreationRules()) {
          const fresh = newGameDraft(manager.unlocks());
          setDraft(fresh);
          if (args.in_browser) return waitForScreen(extra as WaitExtra);
          return creationStep(fresh);
        }
        const choice = args.character ? { ...args.character, portrait: args.character.portrait ?? null } : undefined;
        return openWorld(() => manager.create("mcp", undefined, choice));
      }
      if (args.slot == null && !args.world_id) return text(slotMenu());
      const id = pickWorld(args);
      return typeof id === "string" ? openWorld(() => manager.open(id, "mcp")) : text(id.error, true);
    },
  );

  /**
   * 만들기를 한 단계 진행한다 (채팅의 create_character와 상태 화면이 같이 쓴다).
   * error: 이 단계에 맞지 않는 답 / step: 다음 단계로 / done: 세계(또는 새 캐릭터)가 생겼다
   */
  type CreationAdvance = { kind: "error"; error: string } | { kind: "step" } | { kind: "done"; result: TextResult };
  const advanceCreation = (args: { answer?: string | string[] | null; back?: boolean }): CreationAdvance => {
    if (!draft) return { kind: "error", error: "만들고 있는 캐릭터가 없다." };
    if (args.back) {
      setDraft(backNewGame(draft));
      return { kind: "step" };
    }
    if (args.answer == null) return { kind: "step" };
    const r = answerNewGame(packs, draft, args.answer, rng);
    if (!r.ok) return { kind: "error", error: r.error };
    if (!r.done) {
      setDraft(r.draft);
      return { kind: "step" };
    }
    const choice = r.choice;
    if (draft.mode === "heir") {
      const result = withWorld((w) => {
        const next = w.chooseNextCharacter(r.heirOption ?? "", null, choice);
        return next.ok ? text(`캐릭터를 만들었다. 세계 소개는 하지 않고 바로 새 캐릭터의 첫 장면을 서술한다.\n\n${next.text}`) : text(next.error, true);
      });
      if (result.isError) return { kind: "error", error: result.content[0]?.text ?? "" };
      resetCreation();
      return { kind: "done", result };
    }
    const result = openWorld(() => manager.create("mcp", r.roleId, choice, r.packId, undefined, r.options));
    if (result.isError) return { kind: "error", error: result.content[0]?.text ?? "" };
    return {
      kind: "done",
      result: { ...result, content: [{ type: "text", text: `${startingWords(world)}\n\n${result.content[0]?.text ?? ""}` }] },
    };
  };

  /** 화면에서 끝났을 때 GM에게 줄 말 */
  const fromScreen = (result: TextResult): TextResult => text(`플레이어가 상태 화면에서 골랐다.\n\n${result.content[0]?.text ?? ""}`, result.isError);

  /** 상태 화면을 기다린다 (메인 메뉴 또는 만들기). 넘으면 "다 했어"를 기다리라고 돌려준다 */
  async function waitForScreen(extra: WaitExtra): Promise<TextResult> {
    if (finished) {
      const done = finished;
      finished = null;
      return done;
    }
    const url = options.statusUrl?.();
    if (!url) {
      driver = "chat";
      if (draft) return text(`상태 화면이 없어 채팅으로 만든다.\n\n${describeNewGameStep(packs, draft)}`);
      return text(`상태 화면이 없어 채팅으로 고른다.\n\n${slotMenu()}`);
    }
    if (draft) {
      // 화면에서 만든다 (끝까지). 화면에서 시작하면 얼굴도 고른다
      driver = "screen";
      const withFace = withPortraitStep(draft);
      if (withFace !== draft) setDraft(withFace);
    }
    const token = extra._meta?.progressToken;
    let tick = 0;
    const keepAlive =
      token === undefined
        ? null
        : setInterval(() => {
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++tick, message: "상태 화면에서 고르는 중" } })
              .catch(() => {});
          }, KEEP_ALIVE_MS);
    try {
      const result = await new Promise<TextResult | null>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(null);
        }, options.creationWaitMs ?? SCREEN_WAIT_MS);
        function done(r: TextResult) {
          clearTimeout(timer);
          resolve(r);
        }
        waiters.add(done);
        extra.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(null);
        });
      });
      if (result) return result;
      return text(
        `아직 상태 화면에서 고르는 중이다 (${url}). 플레이어에게 "상태 화면에서 다 고른 뒤 여기에 '다 했어'라고 입력해 주세요"라고 짧게 안내하고 기다린다. 그러면 create_character(wait: true)를 다시 부른다. 고르는 것은 끝까지 상태 화면에서 한다 (채팅으로 넘기지 않는다).`,
      );
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
  }

  /** 상태 화면이 보낸 만들기 답 (POST /api/creation). 규칙은 채팅과 같다. 기다리는 GM이 없어도 진행한다 (12-214) */
  const submitFromScreen = (input: ScreenCreationInput): Done => {
    if (!draft) return { ok: false, error: "만들고 있는 캐릭터가 없습니다." };
    // 채팅에서 만드는 중이면 화면은 보여 주기만 한다 (12-214)
    if (driver === "chat") return { ok: false, error: "채팅에서 만드는 중입니다. 채팅에서 이어 가 주세요." };
    if (input.version !== undefined && input.version !== draftVersion) return { ok: false, error: "그사이 단계가 바뀌었습니다. 지금 단계를 확인해 주세요." };
    if (input.menu) {
      if (!fromMenu || draft.mode !== "new_world" || newGameStep(draft) !== "world") return { ok: false, error: "지금은 메인 메뉴로 돌아갈 수 없습니다." };
      resetCreation();
      return { ok: true };
    }
    const r = advanceCreation({ answer: input.answer ?? null, back: input.back });
    if (r.kind === "error") return { ok: false, error: r.error };
    if (r.kind === "done") deliver(fromScreen(r.result));
    return { ok: true };
  };

  /** 상태 화면 메인 메뉴 (12-214): 새로운 게임, 이어서 하기(열기·삭제) */
  const menuAction = (input: MenuInput): Done => {
    if (world) return { ok: false, error: "게임이 열려 있습니다." };
    if (input.action === "delete") {
      if (!input.id) return { ok: false, error: "id가 필요합니다." };
      try {
        manager.deleteWorld(input.id);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      console.error(`[status] 세이브 삭제: ${input.id}`);
      return { ok: true };
    }
    if (draft) return { ok: false, error: "만들고 있는 캐릭터가 있습니다." };
    // 게임을 열거나 새로 시작하는 것은 GM이 기다리고 있을 때만 (이어 갈 GM이 없으면 채팅이 따라오지 못한다)
    if (!waiters.size) return { ok: false, error: "Claude 채팅에 /play를 입력한 뒤에 고를 수 있습니다." };
    if (input.action === "new") {
      if (!anyCreationRules()) return { ok: false, error: "이 월드는 화면에서 캐릭터를 만들 수 없습니다." };
      setDraft(withPortraitStep(newGameDraft(manager.unlocks())));
      driver = "screen";
      fromMenu = true;
      return { ok: true };
    }
    if (!input.id) return { ok: false, error: "id가 필요합니다." };
    const id = input.id;
    const result = openWorld(() => manager.open(id, "mcp"));
    if (result.isError) return { ok: false, error: result.content[0]?.text ?? "열지 못했습니다." };
    deliver(text(`플레이어가 상태 화면의 이어서 하기에서 저장된 게임을 열었다. 지난 이야기와 현재 장면을 읽고 바로 이어서 서술한다.\n\n${result.content.map((c) => c.text).join("\n")}`));
    return { ok: true };
  };

  /** 시트의 게임 종료 (12-214): 세계를 닫는다 (end_session과 같다) */
  const exitFromScreen = (): Done => {
    if (!world) return { ok: false, error: "열린 게임이 없습니다." };
    const id = world.id;
    world.close();
    world = null;
    frozen = null;
    resetCreation();
    console.error(`[status] 게임 종료: ${id}`);
    // GM에게는 따로 알리지 않는다: 다음 tool 호출이 "열린 세계가 없다"를 받는다
    return { ok: true };
  };

  server.registerTool(
    "create_character",
    {
      description:
        "새 게임(월드 → 시나리오 → 캐릭터 → 수위 → 서술 방식)이나 새 캐릭터 만들기를 한 단계 진행한다 (start_session(new_world) 또는 choose_next_character(new)로 시작한 뒤). " +
        "플레이어가 이번 단계에 답한 것을 answer로 넘긴다 (보기가 있으면 그 값, 트레잇은 이름이나 id 목록, 없으면 \"없음\"). " +
        "back: true면 한 단계 뒤로, 아무것도 없으면 지금 단계를 다시 돌려준다. 캐릭터 확인에서 \"start\"를 넘기고, 새 게임이면 수위·서술 방식까지 고르면 세계(또는 새 캐릭터)가 만들어진다. 대신 답하지 않는다. " +
        "상태 화면에서 만드는 중이면 답을 받지 않는다 (끝까지 화면에서 한다): wait: true로 기다린다. " +
        "wait: true는 상태 화면을 기다릴 때: 플레이어가 화면에서 고를 때까지 기다린다 (메인 메뉴든 만들기든).",
      inputSchema: z.strictObject({
        answer: z.union([z.string().max(1500), z.array(z.string().max(40)).max(10)]).nullable().optional(),
        back: z.boolean().optional(),
        wait: z.boolean().optional().describe("상태 화면을 기다릴 때 true: 플레이어가 화면에서 고를 때까지 기다린다"),
      }),
    },
    async (args, extra) => {
      if (args.wait) {
        if (world && !draft && !finished) return text("상태 화면에서 고를 것이 없다 (게임이 열려 있다). get_scene으로 현재 장면을 보고 이어 간다.", true);
        return waitForScreen(extra as WaitExtra);
      }
      if (!draft) {
        return text("만들고 있는 캐릭터가 없다. 새 게임은 start_session(new_world: true), 사망 뒤 새 캐릭터는 choose_next_character(new:<세력>:<계급>)로 시작한다.", true);
      }
      if (driver === "screen") {
        // 한 번 화면에서 시작한 만들기는 끝까지 화면에서 한다 (12-214)
        return text(
          `이 캐릭터는 상태 화면에서 만드는 중이다 (${options.statusUrl?.() ?? "상태 화면"}). 채팅으로 넘기지 않는다: 플레이어에게 화면에서 이어 가 달라고 짧게 알리고 create_character(wait: true)로 기다린다.`,
          true,
        );
      }
      const r = advanceCreation(args);
      if (r.kind === "error") {
        return text(`${r.error} 플레이어에게 알리고 이 단계를 다시 묻는다.\n\n${describeNewGameStep(packs, draft)}`, true);
      }
      if (r.kind === "done") return r.result;
      return creationStep(draft);
    },
  );

  server.registerTool(
    "load_world",
    {
      description: "저장된 세계를 연다 (list_worlds의 번호 slot 또는 world_id). 현재 장면과 지난 이야기 요약을 돌려준다.",
      inputSchema: z.strictObject({ slot: z.number().int().min(1).nullable().optional(), world_id: z.string().nullable().optional() }),
    },
    (args) => {
      const id = pickWorld(args);
      return typeof id === "string" ? openWorld(() => manager.open(id, "mcp")) : text(id.error, true);
    },
  );

  server.registerTool(
    "end_session",
    {
      description:
        "플레이를 마치고 세계를 닫는다 (메인 화면으로). 진행은 행동마다 자동 저장돼 있다. 잠금이 풀려 다른 세션에서 열 수 있다. 플레이어가 그만하자고 할 때 부른다.",
    },
    () => {
      if (!world) return text("열린 세계가 없다.");
      const name = world.playerView().name;
      const id = world.id;
      world.close();
      world = null;
      resetCreation();
      return text(`세계 ${id}를 닫았다 (${name}의 이야기는 저장돼 있다). 플레이어에게 짧게 마무리 인사를 하고, 다시 하려면 /play 로 이어 할 수 있다고 알려 준다.\n\n${slotMenu()}`);
    },
  );

  server.registerTool(
    "delete_world",
    {
      description:
        "저장 데이터를 지운다 (되돌릴 수 없다). 게임 목록을 보고 있을 때만 쓸 수 있다 (게임 중에는 안 된다). " +
        "플레이어가 \"2번 지워 줘\"처럼 말하면 먼저 confirmed 없이 불러 무엇이 지워지는지 받고, 플레이어에게 확인받은 뒤 confirmed: true로 다시 부른다. 대신 확인하지 않는다.",
      inputSchema: z.strictObject({
        slot: z.number().int().min(1).describe("게임 목록의 번호 (1부터)"),
        confirmed: z.boolean().optional().describe("플레이어가 삭제를 확인했으면 true"),
      }),
    },
    (args) => {
      if (world) return text("게임 중에는 저장 데이터를 지울 수 없다. end_session으로 게임을 닫고 목록에서 지운다.", true);
      if (!menu) return text("저장 목록을 보고 있을 때만 지울 수 있다. 먼저 list_worlds로 목록을 보여 준다.", true);
      const id = menu[args.slot - 1];
      const slot = id ? manager.listSlots().find((s) => s.id === id) : undefined;
      if (!id || !slot) return text(`${args.slot}번 저장 데이터는 없다. list_worlds로 목록을 다시 보여 준다.`, true);
      const line = formatSlotLine(slot, args.slot);
      if (!args.confirmed) {
        return text(`지울 저장 데이터:\n${line}\n\n아직 지우지 않았다. 되돌릴 수 없다는 것을 알리고 플레이어에게 확인받은 뒤 confirmed: true로 다시 부른다.`);
      }
      try {
        manager.deleteWorld(id);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
      return text(`삭제했다: ${line}\n\n${slotMenu()}`);
    },
  );

  // ── 장면과 턴 ─────────────────────────────────────

  server.registerTool(
    "get_gm_guide",
    { description: "GM 지침(진행 규칙, 시나리오 톤, 형식)을 다시 읽는다. start_session 결과에도 들어 있다." },
    () => text(world ? world.guide() : buildGmGuide(defaultContent, firstRole(defaultContent), "mcp")),
  );

  server.registerTool(
    "get_scene",
    { description: "현재 장면: 시각, 플레이어 상태, 함께 있는 인물(프로필과 태도), 아는 것, 임무. 캐릭터가 아는 것만 담긴다." },
    () => withWorld((w) => text(w.sceneForGm())),
  );

  /**
   * 월드마다 달라지는 tool 입력(행동·능력 id 등). 세계를 열 때 그 월드의 스키마로 바꾸고 목록이 바뀌었다고 알린다.
   * 검증은 어차피 core가 그 세계의 월드로 한 번 더 한다
   */
  const registered = new Map<string, RegisteredTool>();
  let toolsFor: Scenario = defaultContent.scenario;
  const schemaOf = (s: Scenario, name: string) =>
    name === "take_action" ? createTakeActionSchema(s) : gmTools(s).find((t) => t.name === name)?.schema;
  function syncTools(s: Scenario) {
    if (s === toolsFor) return;
    toolsFor = s;
    for (const tool of gmTools(s)) {
      const r = registered.get(tool.name);
      if (!r) continue;
      r.inputSchema = schemaOf(s, tool.name);
      r.description = tool.description;
    }
    try {
      server.sendToolListChanged();
    } catch {
      // 연결 전이면 알릴 곳이 없다
    }
  }

  const takeAction = gmTools(defaultContent.scenario).find((t) => t.name === "take_action")!;
  registered.set(
    "take_action",
    server.registerTool(
      "take_action",
      { description: takeAction.description, inputSchema: createTakeActionSchema(defaultContent.scenario) },
      (args) => withWorld((w) => fromOutcome(w.executeTool("take_action", args), sceneAfter(w))),
    ),
  );

  server.registerTool(
    "fast_forward",
    {
      description: "지정한 시간대가 될 때까지 기다린다 (빨리감기). 도중에 무슨 일이 생기면 멈추고 돌려준다.",
      inputSchema: z.strictObject({ until: timeSegmentSchema }),
    },
    (args) => withWorld((w) => fromOutcome(w.fastForward(args.until), sceneAfter(w))),
  );



  // 장면 정리 tool (인물 등장, 물건, 기억, 임무, 목격자, 비밀): core 정의를 그대로 연다
  for (const tool of gmTools(defaultContent.scenario)) {
    if (tool.name === "take_action") continue;
    registered.set(
      tool.name,
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, (args: unknown) => {
        const result = withWorld((w) => fromOutcome(w.executeTool(tool.name, args)));
        // 묘비명은 죽음을 서술한 뒤에 남긴다: 이제 상태 화면에 사망을 보여 준다
        if (tool.name === "write_epitaph") releaseFrozen();
        return result;
      }),
    );
  }

  // ── 기억과 정보 ───────────────────────────────────

  server.registerTool(
    "recall",
    {
      description: "지난 일과 세계 배경을 찾는다. 현재 캐릭터가 아는 것만 돌려준다. 결과에 없는 사실을 만들어 내지 않는다.",
      inputSchema: z.strictObject({ query: z.string().min(1).max(200) }),
    },
    async (args) => {
      if (!world) return text(NO_WORLD, true);
      const w = world;
      const [lore, memory] = await Promise.all([
        w.searchLore(args.query, "recall"),
        w.searchMemory(args.query, "recall", { topK: 6, charBudget: 3000 }),
      ]);
      const empty = (r: { error?: string }) => (r.error ? `(검색할 수 없다: ${r.error})` : "(찾은 것이 없다)");
      const sections = [
        lore.hits.length ? formatReferences(lore.hits, []) : `## 세계 배경\n${empty(lore)}`,
        memory.hits.length ? formatReferences([], memory.hits) : `## 지난 기억\n${empty(memory)}`,
      ];
      return text(sections.join("\n\n"));
    },
  );

  server.registerTool(
    "record_turn_summary",
    {
      description: "장면이 끝나면 장면 요약을 남긴다. 다른 세션에서 이어 플레이할 때 쓰고, 상태 화면 일지에 쌓인다. 평서체(~했다)로 쓴다 (존댓말 아님).",
      inputSchema: z.strictObject({
        text: z.string().min(1).max(2000),
        kind: z.enum(["scene", "turn"]).optional(),
      }),
    },
    (args) =>
      withWorld((w) => {
        w.recordSummary(args.kind ?? "scene", args.text);
        return text("요약을 남겼다.");
      }),
  );

  server.registerTool(
    "run_command",
    {
      description:
        "정보 명령어(?상태, ?소지품, ?인물 강태호 등)를 실행한다. 플레이어 입력이 ?로 시작하면 이것을 부른다 (!도 받는다). 시간이 흐르지 않는다. 결과를 코드 블록으로 그대로 보여 준다. " +
        "읽기 전용이지만 ?메모만 예외로, 뒤에 내용이 있으면 플레이어의 메모에 적는다 (입력을 고치지 말고 그대로 넘긴다).",
      inputSchema: z.strictObject({ input: z.string().min(1).max(4100) }),
    },
    async (args) => {
      if (!world) return text(NO_WORLD, true);
      const input = isCommand(args.input) ? args.input : `?${args.input}`;
      // 메모 적기만 상태를 바꾼다 (규칙은 core GameWorld.memoCommand, 12-75)
      const wrote = world.memoCommand(input);
      if (wrote !== null) return text(wrote);
      return text(await world.runCommand(input));
    },
  );

  server.registerTool(
    "get_chronicle",
    { description: "죽은 캐릭터들의 기록과, 사망했다면 다음 캐릭터 후보." },
    async () => {
      releaseFrozen();
      return world ? text(await world.runCommand("!연대기")) : text(NO_WORLD, true);
    },
  );

  server.registerTool(
    "choose_next_character",
    {
      description:
        "사망 후 같은 세계에서 다음 캐릭터로 이어 간다 (시나리오 없이 세계만 이어 간다). get_chronicle의 후보 중 하나: \"new:<세력>:<계급>\"(조우한 무리의 새 캐릭터) 또는 조우한 인물 id. 플레이어가 고른 것만 넘긴다. 새 캐릭터는 이전 캐릭터의 기억을 모른다. " +
        "new:…는 새 게임처럼 캐릭터를 한 단계씩 만든다: 첫 단계를 돌려주고, 그 뒤로는 create_character로 진행한다. " +
        "상태 화면이 있으면 어디서 만들지 묻고, 상태 화면이면 in_browser: true (다 만들 때까지 기다린다).",
      inputSchema: z.strictObject({
        character_id: z.string(),
        name: z.string().max(20).nullable().optional().describe("(이전 방식) 새 캐릭터의 이름만 정할 때"),
        in_browser: z.boolean().optional().describe("new:…일 때 상태 화면에서 만든다 (플레이어가 골랐을 때). 다 만들 때까지 기다린다"),
        character: characterChoiceSchema().nullable().optional().describe("이미 다 정해진 새 캐릭터 (자동 진행·테스트용). 플레이어와 함께라면 create_character로 한 단계씩"),
      }),
    },
    async (args, extra) => {
      releaseFrozen();
      if (!world) return text(NO_WORLD, true);
      // new:<세력>:<계급>이면 그 무리·계급의 새 캐릭터 (기획서 12.4.1): 캐릭터 만들기부터
      const newAs = parseNewAs(args.character_id);
      if (newAs && !args.character && !args.name && world.content.scenario.creation) {
        if (!world.isPlayerDead()) return text("캐릭터가 살아 있다. 다음 캐릭터는 사망한 뒤에만 고른다.", true);
        if (world.storyEnded()) return text(world.storyEndedText(), true);
        if (!world.successionOptions().some((o) => o.id === args.character_id)) return text(`고를 수 없는 캐릭터: ${args.character_id}`, true);
        const seat = heirSeat(world.content, newAs.faction, newAs.rank, { age: null });
        resetCreation();
        const heir = heirDraft(world.content.scenario.id, args.character_id, seat.role, seat.custom, world.content.scenario.creation?.rank_min_age[newAs.rank]);
        setDraft(heir);
        if (args.in_browser) return waitForScreen(extra as WaitExtra);
        return creationStep(heir);
      }
      return withWorld((w) => {
        const picked = args.character ? { ...args.character, portrait: args.character.portrait ?? null } : undefined;
        const result = w.chooseNextCharacter(args.character_id, args.name ?? null, picked);
        return result.ok ? text(result.text) : text(result.error, true);
      });
    },
  );

  // ── 치트 (개발 모드, .env의 TRPG_DEBUG=1) ─────────────
  if (options.debug) {
    server.registerTool(
      "cheat",
      {
        description:
          "개발 모드 치트. 플레이어 입력이 ~로 시작하면(예: ~kill me, ~give shotgun) 서술하지 말고 그 입력을 그대로 넘긴 뒤 결과를 코드 블록으로 보여 준다. " +
          "GM이 스스로 쓰지 않는다. ~help로 목록.",
        inputSchema: z.strictObject({ input: z.string().min(1).max(300) }),
      },
      (args) =>
        withWorld((w) => {
          const r = w.runCheat(args.input.startsWith("~") ? args.input : `~${args.input}`);
          return r.ok ? text(`${r.text}\n\n(치트 결과다. 서술하지 말고 그대로 보여 준다. 이야기는 플레이어의 다음 행동부터 이어진다)`) : text(r.error, true);
        }),
    );
  }

  // ── GM 지침 ───────────────────────────────────────

  server.registerPrompt(
    "play",
    { description: "TRPG를 GM으로 진행한다 (GM 지침 + 세션 시작 안내)." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${buildGmGuide(defaultContent, firstRole(defaultContent), "mcp")}\n\n${PLAY_START}`,
          },
        },
      ],
    }),
  );

  return {
    server,
    /** 대화로 캐릭터를 만드는 중 (상태 화면 안내용) */
    get creating() {
      return draft !== null;
    },
    /**
     * 만드는 중이면 그 단계 (화면이 그린다), 아니면 null. 채팅으로 만들어도 화면이 따라 그린다 (12-214).
     * driver: 누가 진행하는지, version: 초안의 판 (화면이 답과 함께 돌려보낸다)
     */
    get creation() {
      if (!draft) return null;
      return { view: newGameView(packs, draft), driver, fromMenu, version: draftVersion };
    },
    /** 상태 화면을 기다리는 GM이 있는지 (메인 메뉴·안내 띠) */
    get gm() {
      return { waiting: waiters.size > 0 };
    },
    /** 상태 화면이 보낸 답 */
    submitCreation: (input: ScreenCreationInput) => submitFromScreen(input),
    /** 메인 메뉴에서 고른 것 */
    menuAction: (input: MenuInput) => menuAction(input),
    /** 메인 메뉴의 이어서 하기 목록 */
    slots: () => manager.listSlots(),
    /** 시트의 게임 종료 */
    exitGame: () => exitFromScreen(),
    /** 아직 닫지 않은 시나리오 해금 알림 (상태 화면의 토스트) */
    unlockNotices: () => manager.unlockNotices(),
    /** 해금 알림을 닫는다 (토스트의 ×) */
    dismissUnlockNotice: (pack: string, roleId: string) => manager.dismissUnlockNotice(pack, roleId),
    /** 상태 화면 머리의 이름: 열린 세계의 월드, 없으면 "TRPG" */
    get title() {
      return world ? titleOf(world.content) : "TRPG";
    },
    /** 주인공이 죽은 직후 GM이 서술하는 동안 상태 화면에 보여 줄 죽기 직전 모습 (없으면 null) */
    get frozenStatus() {
      if (frozen && frozen.until <= Date.now()) frozen = null;
      return frozen?.payload ?? null;
    },
    get world() {
      return world;
    },
    close() {
      world?.close();
      world = null;
    },
  };
}
