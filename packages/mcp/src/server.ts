import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildGmGuide,
  CharacterChoiceError,
  characterChoiceSchema,
  creationRules,
  describeCreationRules,
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
  "지금 list_worlds를 호출해 저장된 게임 목록(번호 목록과 새 게임)을 플레이어에게 그대로 보여 주고, 어느 것을 할지 묻는다. " +
  "플레이어가 번호를 고르면 start_session(slot)으로 연다. 새 게임이면 start_session(new_world: true)로 캐릭터 생성 규칙을 받아 플레이어에게 이름·성별·능력을 묻고, character와 함께 다시 불러 연다. 고르기 전에는 세계를 열지 않는다. " +
  "플레이어가 그만하자고 하면 end_session으로 닫는다.";

const HELP_HINT = "플레이어에게 한 줄 안내: \"!도움말 로 정보 명령어를 볼 수 있습니다.\"";

export function createMcpServer(manager: WorldManager) {
  const content = manager.content;
  const scenario = content.scenario;
  const server = new McpServer({ name: "trpg", version: "0.0.0" });
  let world: GameWorld | null = null;

  const withWorld = (fn: (w: GameWorld) => TextResult): TextResult => (world ? fn(world) : text(NO_WORLD, true));
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
        `\n---\n\n세계 ${intro.worldId} (${intro.scenarioName})를 열었다.`,
        recap ? `\n${recap}` : `\n새로 시작하는 세계다. 시작 장면: ${intro.opening}`,
        `\n## 현재 장면\n${w.sceneForGm()}`,
        `\n${HELP_HINT}`,
      ].join("\n"),
    );
  };

  const openWorld = (open: () => GameWorld): TextResult => {
    try {
      const next = open();
      world?.close();
      world = next;
      return sessionStart(next);
    } catch (err) {
      if (err instanceof WorldLockedError) return text(err.message, true);
      if (err instanceof CharacterChoiceError) return text(`캐릭터 설정이 규칙에 맞지 않는다: ${err.message} 플레이어에게 알리고 다시 고르게 한다.`, true);
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };

  const sceneAfter = (w: GameWorld) => (w.isPlayerDead() ? "\n\n캐릭터가 사망했다. 죽음을 서술하고 write_epitaph로 묘비명을 남긴 뒤, get_chronicle로 연대기와 다음 캐릭터 후보를 보여 주고 플레이어가 고르면 choose_next_character를 호출하라." : `\n\n## 현재 장면\n${w.sceneForGm()}`);

  // ── 세계 ─────────────────────────────────────────

  /** 세이브 슬롯 메뉴: 번호 목록 + 새 게임. GM은 이 목록을 그대로 보여 주고 플레이어가 번호를 고르게 한다 */
  const slotMenu = (): string => {
    const slots = manager.listSlots();
    // 이 세션이 연 세계는 "사용 중"이 아니라 "지금 하는 게임"
    const lines = slots.map((slot, i) =>
      slot.id === world?.id ? `${formatSlotLine({ ...slot, lockedBy: null }, i + 1)} · (지금 하는 게임)` : formatSlotLine(slot, i + 1),
    );
    return [
      "저장된 게임 (아래 목록을 고치지 말고 그대로 보여 준다. 플레이어가 번호나 \"새 게임\"을 고르면 start_session에 slot 또는 new_world로 넘긴다):",
      "",
      ...(lines.length ? lines : ["(저장된 게임이 없다)"]),
      `${slots.length + 1}. 새 게임`,
    ].join("\n");
  };

  /** 슬롯 번호(1부터) 또는 world_id로 세계를 고른다 */
  const pickWorld = (args: { world_id?: string | null; slot?: number | null }): string | { error: string } => {
    if (args.world_id) return args.world_id;
    if (args.slot) {
      const slots = manager.listSlots();
      const slot = slots[args.slot - 1];
      if (!slot) return { error: `${args.slot}번 슬롯은 없다. list_worlds로 목록을 다시 보여 준다.` };
      return slot.id;
    }
    return { error: "slot 또는 world_id가 필요하다." };
  };

  server.registerTool(
    "list_worlds",
    { description: "세이브 슬롯 목록: 번호, 주인공(이름·계급·레벨·몸 상태), 게임 안 시각과 장소, 마지막 플레이. 마지막 번호는 새 게임이다." },
    () => text(slotMenu()),
  );

  server.registerTool(
    "start_session",
    {
      description:
        "플레이 세션을 시작한다. slot(list_worlds의 번호)이나 world_id를 주면 그 세계를 연다. " +
        "새 게임은 new_world: true. character 없이 부르면 세계를 만들지 않고 캐릭터 생성 규칙을 돌려준다: 플레이어에게 이름·성별·능력을 물은 뒤 character와 함께 다시 부른다. " +
        "아무것도 주지 않으면 세계를 열지 않고 슬롯 목록(마지막 번호는 새 게임)을 돌려준다. " +
        "세계를 열면 GM 지침, 지난 이야기 요약, 현재 장면을 돌려준다.",
      inputSchema: z.strictObject({
        slot: z.number().int().min(1).nullable().optional().describe("list_worlds의 번호"),
        world_id: z.string().nullable().optional(),
        new_world: z.boolean().optional(),
        character: characterChoiceSchema().nullable().optional().describe("새 게임의 캐릭터 (플레이어가 정한 것)"),
      }),
    },
    (args) => {
      if (args.new_world) {
        if (!args.character) {
          const rules = creationRules(content, Object.keys(content.roles)[0] ?? "");
          if (rules) {
            return text(
              `${describeCreationRules(rules)}\n\n아직 세계를 만들지 않았다. 위 내용을 플레이어에게 묻고(한 번에 물어도 된다), 정해지면 start_session에 new_world: true와 character({name, gender, abilities, portrait: null})를 넣어 다시 부른다.`,
            );
          }
        }
        const choice = args.character ? { ...args.character, portrait: args.character.portrait ?? null } : undefined;
        return openWorld(() => manager.create("mcp", undefined, choice));
      }
      if (!args.slot && !args.world_id) return text(slotMenu());
      const id = pickWorld(args);
      return typeof id === "string" ? openWorld(() => manager.open(id, "mcp")) : text(id.error, true);
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
        "플레이를 마치고 세계를 닫는다 (메인 화면으로). 진행은 행동마다 자동 저장돼 있다. 잠금이 풀려 웹 앱이나 다른 세션에서 열 수 있다. 플레이어가 그만하자고 할 때 부른다.",
    },
    () => {
      if (!world) return text("열린 세계가 없다.");
      const name = world.playerView().name;
      const id = world.id;
      world.close();
      world = null;
      return text(`세계 ${id}를 닫았다 (${name}의 이야기는 저장돼 있다). 플레이어에게 짧게 마무리 인사를 하고, 다시 하려면 /play 로 이어 할 수 있다고 알려 준다.\n\n${slotMenu()}`);
    },
  );

  // ── 장면과 턴 ─────────────────────────────────────

  server.registerTool(
    "get_gm_guide",
    { description: "GM 지침(진행 규칙, 시나리오 톤, 형식)을 다시 읽는다. start_session 결과에도 들어 있다." },
    () => text(world ? world.guide() : buildGmGuide(content, Object.keys(content.roles)[0] ?? "", "mcp")),
  );

  server.registerTool(
    "get_scene",
    { description: "현재 장면: 시각, 플레이어 상태, 함께 있는 인물(프로필과 태도), 아는 것, 임무. 캐릭터가 아는 것만 담긴다." },
    () => withWorld((w) => text(w.sceneForGm())),
  );

  const takeAction = gmTools(scenario).find((t) => t.name === "take_action")!;
  server.registerTool(
    "take_action",
    { description: takeAction.description, inputSchema: createTakeActionSchema(scenario) },
    (args) => withWorld((w) => fromOutcome(w.executeTool("take_action", args), sceneAfter(w))),
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
  for (const tool of gmTools(scenario)) {
    if (tool.name === "take_action") continue;
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, (args: unknown) =>
      withWorld((w) => fromOutcome(w.executeTool(tool.name, args))),
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
      description: "장면이 끝나면 장면 요약을 남긴다. 다른 세션이나 웹 앱에서 이어 플레이할 때 쓴다.",
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
      description: "정보 명령어(!상태, !소지품, !인물 등)를 실행한다. 읽기 전용이며 시간이 흐르지 않는다. 결과를 코드 블록으로 그대로 보여 준다.",
      inputSchema: z.strictObject({ input: z.string().min(1).max(200) }),
    },
    async (args) => {
      if (!world) return text(NO_WORLD, true);
      return text(await world.runCommand(args.input.startsWith("!") ? args.input : `!${args.input}`));
    },
  );

  server.registerTool(
    "get_chronicle",
    { description: "죽은 캐릭터들의 기록과, 사망했다면 다음 캐릭터 후보." },
    async () => (world ? text(await world.runCommand("!연대기")) : text(NO_WORLD, true)),
  );

  server.registerTool(
    "choose_next_character",
    {
      description:
        "사망 후 같은 세계에서 다음 캐릭터로 이어 간다. get_chronicle의 후보 중 하나: \"new\"(새 캐릭터) 또는 인물 id. " +
        "플레이어가 고른 것만 넘긴다. 새 캐릭터는 이전 캐릭터의 기억을 모른다.",
      inputSchema: z.strictObject({
        character_id: z.string(),
        name: z.string().max(20).nullable().optional().describe("새 캐릭터의 이름 (new일 때만, 없으면 기본 이름)"),
      }),
    },
    (args) =>
      withWorld((w) => {
        const result = w.chooseNextCharacter(args.character_id, args.name ?? null);
        return result.ok ? text(result.text) : text(result.error, true);
      }),
  );

  // ── GM 지침 ───────────────────────────────────────

  server.registerPrompt(
    "play",
    { description: `${scenario.name} TRPG를 GM으로 진행한다 (GM 지침 + 세션 시작 안내).` },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${buildGmGuide(content, Object.keys(content.roles)[0] ?? "", "mcp")}\n\n${PLAY_START}`,
          },
        },
      ],
    }),
  );

  return {
    server,
    get world() {
      return world;
    },
    close() {
      world?.close();
      world = null;
    },
  };
}
