import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildGmGuide,
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
const HELP_HINT = "플레이어에게 한 줄 안내: \"!도움말 로 정보 명령어를 볼 수 있습니다.\"";

export function createMcpServer(manager: WorldManager) {
  const content = manager.content;
  const scenario = content.scenario;
  const server = new McpServer({ name: "trpg", version: "0.0.0" });
  let world: GameWorld | null = null;

  const withWorld = (fn: (w: GameWorld) => TextResult): TextResult => (world ? fn(world) : text(NO_WORLD, true));
  const fromOutcome = (outcome: ToolOutcome, extra = ""): TextResult =>
    outcome.ok ? text(outcome.resultText + extra) : text(outcome.error, true);

  /** 새 세션의 GM이 바로 이어 갈 수 있게: 세계 정보, 지난 이야기, 현재 장면 */
  const sessionStart = (w: GameWorld) => {
    const intro = w.intro();
    const recap = w.recap();
    return text(
      [
        `세계 ${intro.worldId} (${intro.scenarioName})를 열었다.`,
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
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };

  const sceneAfter = (w: GameWorld) => (w.isPlayerDead() ? "\n\n캐릭터가 사망했다. get_chronicle로 기록을 보여 주고 choose_next_character를 안내하라." : `\n\n## 현재 장면\n${w.sceneForGm()}`);

  // ── 세계 ─────────────────────────────────────────

  server.registerTool(
    "list_worlds",
    { description: "저장된 세계 목록 (최근에 플레이한 것부터)." },
    () => {
      const worlds = manager.listWorlds().filter((w) => w.scenarioId === scenario.id);
      if (worlds.length === 0) return text("저장된 세계가 없다. start_session으로 새 세계를 만든다.");
      return text(
        worlds
          .map(
            (w) =>
              `- ${w.id}: ${w.playerName ?? "?"} · ${w.timeLabel ?? "?"} · 턴 ${w.turn ?? 0}${w.dead ? " · 사망" : ""}` +
              (w.lockedBy ? ` · 사용 중(${w.lockedBy.mode === "web" ? "웹 앱" : "MCP"})` : ""),
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "start_session",
    {
      description:
        "플레이 세션을 시작한다. world_id를 주면 그 세계를, 없으면 가장 최근 세계를 연다 (없으면 새로 만든다). " +
        "new_world가 true면 새 세계를 만든다. 현재 장면과 지난 이야기 요약을 돌려준다.",
      inputSchema: z.strictObject({
        world_id: z.string().nullable().optional(),
        new_world: z.boolean().optional(),
      }),
    },
    (args) =>
      openWorld(() =>
        args.new_world ? manager.create("mcp") : args.world_id ? manager.open(args.world_id, "mcp") : manager.openLatest("mcp"),
      ),
  );

  server.registerTool(
    "load_world",
    {
      description: "저장된 세계를 연다 (list_worlds의 id). 현재 장면과 지난 이야기 요약을 돌려준다.",
      inputSchema: z.strictObject({ world_id: z.string() }),
    },
    (args) => openWorld(() => manager.open(args.world_id, "mcp")),
  );

  // ── 장면과 턴 ─────────────────────────────────────

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
    (args) => withWorld((w) => text(w.runCommand(`!일지 ${args.query}`))),
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
    (args) => withWorld((w) => text(w.runCommand(args.input.startsWith("!") ? args.input : `!${args.input}`))),
  );

  server.registerTool(
    "get_chronicle",
    { description: "죽은 캐릭터들의 기록." },
    () => withWorld((w) => text(w.runCommand("!연대기"))),
  );

  server.registerTool(
    "choose_next_character",
    {
      description: "사망 후 다음 캐릭터를 고른다 (기존 인물 id 또는 \"new\").",
      inputSchema: z.strictObject({ character_id: z.string() }),
    },
    () => text("캐릭터 교체는 아직 없다 (사망·계승 단계에서 추가된다). 지금은 start_session으로 새 세계를 만들 수 있다.", true),
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
            text: `${buildGmGuide(content, Object.keys(content.roles)[0] ?? "", "mcp")}\n\n지금 start_session을 호출해 세계를 열고 진행을 시작하라.`,
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
