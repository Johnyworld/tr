import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildGmGuide,
  isCommand,
  CharacterChoiceError,
  characterChoiceSchema,
  answerNewGame,
  backNewGame,
  createSeededRng,
  creationRules,
  describeNewGameStep,
  heirDraft,
  newGameDraft,
  setCustomStart,
  customStartSchema,
  worldInfo,
  type Content,
  type NewGameDraft,
  type Rng,
  type Scenario,
  formatReferences,
  formatSlotLine,
  createTakeActionSchema,
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

const NO_WORLD = "열린 세계가 없습니다. 먼저 start_session(또는 load_world)을 호출하세요.";
/** 세션을 시작할 때 GM이 할 일 (MCP prompt `play`, Claude Code 스킬 /play 가 같은 흐름) */
export const PLAY_START =
  "지금 list_worlds를 호출해 저장된 게임 목록(0번 새 게임, 1번부터 저장된 게임)을 플레이어에게 그대로 보여 주고, 어느 것을 할지 묻는다. " +
  "플레이어가 번호를 고르면 start_session(slot)으로 연다. 새 게임이면 start_session(new_world: true): 월드 → 시나리오 → 캐릭터를 create_character로 한 단계씩 고른다 (마지막 확인에서 세계가 열린다). 고르기 전에는 세계를 열지 않는다. " +
  "플레이어가 그만하자고 하면 end_session으로 닫는다.";

const HELP_HINT = "플레이어에게 한 줄 안내: \"?도움말 로 정보 명령어를 볼 수 있습니다.\" (이 모드에서는 \"!\" 대신 \"?\"를 쓴다. Claude 앱은 줄 맨 앞의 !를 셸 명령으로 바꾼다)";

/** 주인공이 죽은 뒤 GM이 서술할 동안 상태 화면에 사망을 미루는 최대 시간 */
const DEATH_HOLD_MS = 120 * 1000;

export type CharacterChoiceInput = z.infer<ReturnType<typeof characterChoiceSchema>>;

export function createMcpServer(
  manager: WorldManager,
  options: { statusUrl?: () => string | null; /** 치트(개발 모드)를 연다 */ debug?: boolean; /** 캐릭터 생성의 무작위 (테스트에서 고정) */ rng?: Rng } = {},
) {
  const packs = manager.packs;
  /** 세계를 열기 전(목록·새 게임)에 쓰는 기본 월드 */
  const defaultContent = manager.content;
  const server = new McpServer({ name: "trpg", version: "0.0.0" });
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
        `\n## 현재 장면\n${w.sceneForGm()}`,
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
  const creationStep = (d: NewGameDraft) => text(describeNewGameStep(packs, d));
  const anyCreationRules = () => [...packs.values()].some((c) => creationRules(c, firstRole(c)) !== null);

  /** 플레이어가 지금 보고 있는 게임 목록 (번호 → 세이브 id). 세계를 열면 닫힌다. 삭제는 목록이 열려 있을 때만 */
  let menu: string[] | null = null;

  const openWorld = (open: () => GameWorld): TextResult => {
    try {
      const next = open();
      world?.close();
      world = next;
      menu = null;
      draft = null;
      syncTools(next.content.scenario);
      return sessionStart(next);
    } catch (err) {
      if (err instanceof WorldLockedError) return text(err.message, true);
      if (err instanceof CharacterChoiceError) return text(`캐릭터 설정이 규칙에 맞지 않는다: ${err.message} 플레이어에게 알리고 다시 고르게 한다.`, true);
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };

  const sceneAfter = (w: GameWorld) => (w.isPlayerDead() ? "\n\n캐릭터가 사망했다. 죽음을 서술하고 write_epitaph로 묘비명을 남긴 뒤, get_chronicle로 연대기와 다음 캐릭터 후보를 보여 주고 플레이어가 고르면 choose_next_character를 호출하라." : `\n\n## 현재 장면 (지난번에서 바뀐 것)\n${w.sceneUpdate()}`);

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
        "아무것도 주지 않으면 세계를 열지 않고 게임 목록(0번 새 게임)을 돌려준다. " +
        "세계를 열면 GM 지침, 지난 이야기 요약, 현재 장면을 돌려준다.",
      inputSchema: z.strictObject({
        slot: z.number().int().min(0).nullable().optional().describe("list_worlds의 번호 (0은 새 게임)"),
        world_id: z.string().nullable().optional(),
        new_world: z.boolean().optional(),
        character: characterChoiceSchema().nullable().optional().describe("이미 다 정해진 캐릭터로 기본 월드·시나리오에서 바로 만든다 (자동 진행·테스트용). 플레이어와 함께라면 쓰지 않고 create_character로 한 단계씩"),
      }),
    },
    (args) => {
      draft = null;
      if (args.new_world || args.slot === 0) {
        if (!args.character && anyCreationRules()) {
          draft = newGameDraft(manager.unlocks());
          return creationStep(draft);
        }
        const choice = args.character ? { ...args.character, portrait: args.character.portrait ?? null } : undefined;
        return openWorld(() => manager.create("mcp", undefined, choice));
      }
      if (args.slot == null && !args.world_id) return text(slotMenu());
      const id = pickWorld(args);
      return typeof id === "string" ? openWorld(() => manager.open(id, "mcp")) : text(id.error, true);
    },
  );

  server.registerTool(
    "create_character",
    {
      description:
        "새 게임(월드 → 시나리오 → 캐릭터)이나 새 캐릭터 만들기를 한 단계 진행한다 (start_session(new_world) 또는 choose_next_character(new)로 시작한 뒤). " +
        "플레이어가 이번 단계에 답한 것을 answer로 넘긴다 (보기가 있으면 그 값, 트레잇은 이름이나 id 목록, 없으면 \"없음\"). " +
        "back: true면 한 단계 뒤로, 아무것도 없으면 지금 단계를 다시 돌려준다. 마지막 확인에서 \"start\"를 넘기면 세계(또는 새 캐릭터)가 만들어진다. 대신 답하지 않는다.",
      inputSchema: z.strictObject({
        answer: z.union([z.string().max(1500), z.array(z.string().max(40)).max(10)]).nullable().optional(),
        back: z.boolean().optional(),
        custom_start: customStartSchema().nullable().optional().describe("직접 쓰는 시나리오의 옮기기 단계에서만: 플레이어의 글을 월드의 부품으로 옮긴 것"),
      }),
    },
    (args) => {
      if (!draft) return text("만들고 있는 캐릭터가 없다. 새 게임은 start_session(new_world: true), 사망 뒤 새 캐릭터는 choose_next_character(new)로 시작한다.", true);
      if (args.back) {
        draft = backNewGame(draft);
        return creationStep(draft);
      }
      if (args.custom_start) {
        const set = setCustomStart(packs, draft, args.custom_start);
        if (!set.ok) return text(`${set.error} 고쳐서 다시 넘긴다.\n\n${describeNewGameStep(packs, draft)}`, true);
        draft = set.draft;
        return creationStep(draft);
      }
      if (args.answer == null) return creationStep(draft);
      const r = answerNewGame(packs, draft, args.answer, rng);
      if (!r.ok) return text(`${r.error} 플레이어에게 알리고 이 단계를 다시 묻는다.\n\n${describeNewGameStep(packs, draft)}`, true);
      if (!r.done) {
        draft = r.draft;
        return creationStep(draft);
      }
      const mode = draft.mode;
      const choice = r.choice;
      if (mode === "heir") {
        const result = withWorld((w) => {
          const heirRole = draft?.roleId && draft.roleId !== w.state().roleId ? `new:${draft.roleId}` : "new";
          const next = w.chooseNextCharacter(heirRole, null, choice);
          return next.ok ? text(`캐릭터를 만들었다. 세계 소개는 하지 않고 바로 새 캐릭터의 첫 장면을 서술한다.\n\n${next.text}`) : text(next.error, true);
        });
        if (!result.isError) draft = null;
        return result;
      }
      const result = openWorld(() => manager.create("mcp", r.roleId, choice, r.packId, r.custom ?? undefined));
      if (result.isError) return result;
      return { ...result, content: [{ type: "text", text: `캐릭터를 만들었다. 월드 이야기와 지금 상황은 이미 했으니 되풀이하지 말고, 지금 만든 사람으로 바로 첫 장면을 서술한다.\n\n${result.content[0]?.text ?? ""}` }] };
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
      draft = null;
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
      description: "장면이 끝나면 장면 요약을 남긴다. 다른 세션에서 이어 플레이할 때 쓴다.",
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
        "정보 명령어(?상태, ?소지품, ?인물 강태호 등)를 실행한다. 플레이어 입력이 ?로 시작하면 이것을 부른다 (!도 받는다). 읽기 전용이며 시간이 흐르지 않는다. 결과를 코드 블록으로 그대로 보여 준다.",
      inputSchema: z.strictObject({ input: z.string().min(1).max(200) }),
    },
    async (args) => {
      if (!world) return text(NO_WORLD, true);
      return text(await world.runCommand(isCommand(args.input) ? args.input : `?${args.input}`));
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
        "사망 후 같은 세계에서 다음 캐릭터로 이어 간다. get_chronicle의 후보 중 하나: \"new\"(새 캐릭터), \"new:<역할 id>\"(해금된 다른 시나리오의 새 캐릭터) 또는 인물 id. 플레이어가 고른 것만 넘긴다. 새 캐릭터는 이전 캐릭터의 기억을 모른다. " +
        "new는 새 게임처럼 캐릭터를 한 단계씩 만든다: 첫 단계를 돌려주고, 그 뒤로는 create_character로 진행한다.",
      inputSchema: z.strictObject({
        character_id: z.string(),
        name: z.string().max(20).nullable().optional().describe("(이전 방식) 새 캐릭터의 이름만 정할 때"),
        character: characterChoiceSchema().nullable().optional().describe("이미 다 정해진 새 캐릭터 (자동 진행·테스트용). 플레이어와 함께라면 create_character로 한 단계씩"),
      }),
    },
    (args) => {
      releaseFrozen();
      if (!world) return text(NO_WORLD, true);
      // new:<역할>이면 해금된 다른 시나리오로 (기획서 9.12)
      const newAs = args.character_id.startsWith("new:") ? args.character_id.slice(4) : null;
      const roleId = newAs ?? world.state().roleId;
      if ((args.character_id === "new" || newAs) && !args.character && !args.name && creationRules(world.content, roleId)) {
        if (!world.isPlayerDead()) return text("캐릭터가 살아 있다. 다음 캐릭터는 사망한 뒤에만 고른다.", true);
        if (newAs && !world.successionOptions().some((o) => o.id === args.character_id)) return text(`고를 수 없는 캐릭터: ${args.character_id}`, true);
        draft = heirDraft(world.content.scenario.id, roleId, newAs ? null : world.state().customRole);
        return creationStep(draft);
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
