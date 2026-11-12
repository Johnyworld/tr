import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSeededRng, WorldManager, type GameState } from "@trpg/core";
import { TEST_CONTENT } from "@trpg/core/testing";
import { runGmTurn, type LanguageModel } from "@trpg/gm";
import { createMcpServer } from "./server.ts";

/** 같은 행동 순서 (판정·위험·행적·활동이 섞인 턴들) */
const ACTIONS: Record<string, unknown>[] = [
  { intent: "사물함을 뒤진다", check: { move: "search", stat: "sense", difficulty: "normal", harm_on_failure: "light", harm_cause: "녹슨 철판" }, activity: { kind: "search", until: null }, deed: null },
  { intent: "몰래 통조림을 챙긴다", check: { move: "stealth", stat: "agility", difficulty: "hard", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: { summary: "통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "semi_private", noisy: false, condition: "on_success" } },
  { intent: "보초를 선다", check: null, activity: { kind: "guard_duty", until: null }, deed: null },
  { intent: "잠을 잔다", check: null, activity: { kind: "sleep", until: "morning" }, deed: null },
].map((a) => ({ target: null, narration_summary: null, ...a }));

function manager(seed = 42) {
  return new WorldManager({
    savesDir: mkdtempSync(join(tmpdir(), "trpg-modes-")),
    content: TEST_CONTENT,
    rngFactory: () => createSeededRng(seed),
  });
}

/** 매 입력마다 정해진 take_action을 한 번 부르고 서술로 끝내는 가짜 GM */
function scriptedGm(): LanguageModel {
  let turn = 0;
  return async function* (request) {
    const last = request.messages.at(-1)!;
    if (last.content.some((b) => b.type === "tool_result")) {
      yield `서술 ${turn}`;
      return { stopReason: "end", content: [{ type: "text", text: `서술 ${turn}` }] };
    }
    const input = ACTIONS[turn++]!;
    return { stopReason: "tool_use", content: [{ type: "tool_call", id: `t${turn}`, name: "take_action", input }] };
  };
}

async function mcpClient(m: WorldManager) {
  const app = createMcpServer(m);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await app.server.connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return { app, call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) };
}

/** 세계 id처럼 경로마다 다를 수밖에 없는 값을 뺀 상태 */
const comparable = (state: GameState) => JSON.stringify({ ...state, worldId: "" });

describe("웹 앱 경로와 MCP 경로", () => {
  it("같은 시드와 같은 행동 순서면 세계 상태가 같다", async () => {
    // 웹 앱 경로: gm 턴 루프 → take_action
    const web = manager().create("web");
    const model = scriptedGm();
    for (let i = 0; i < ACTIONS.length; i++) {
      for await (const _ of runGmTurn({ model, world: web, input: `입력 ${i}` }));
    }

    // MCP 경로: MCP 클라이언트 → take_action
    const { app, call } = await mcpClient(manager());
    await call("start_session", { new_world: true });
    for (const a of ACTIONS) await call("take_action", a);

    expect(comparable(app.world!.state())).toBe(comparable(web.state()));
    expect(web.state().turn).toBe(ACTIONS.length);
    web.close();
    app.close();
  });

  it("모드 전환: 웹 앱 → MCP → 웹 앱으로 이어서 플레이해도 상태와 기록이 이어진다", async () => {
    const m = manager();

    // 1. 웹 앱에서 2턴
    let web = m.create("web");
    const worldId = web.id;
    const model = scriptedGm();
    for (let i = 0; i < 2; i++) for await (const _ of runGmTurn({ model, world: web, input: `웹 입력 ${i}` }));
    web.close();

    // 2. MCP에서 같은 세계를 열고 1턴
    const { app, call } = await mcpClient(m);
    const opened = (await call("load_world", { world_id: worldId })) as { content: { text: string }[] };
    expect(opened.content[0]!.text).toContain("지난 이야기"); // 웹 앱 턴 요약이 이어진다
    await call("take_action", { ...ACTIONS[2]!, narration_summary: "웹 앱에서의 일을 이어받았다." });
    await call("record_turn_summary", { text: "보초를 서며 밤을 넘겼다." });
    app.close();

    // 3. 다시 웹 앱에서 연다
    web = m.open(worldId, "web");
    expect(web.state().turn).toBe(3);
    expect(web.transcript().map((e) => e.kind)).toEqual(
      expect.arrayContaining(["player", "gm", "note"]),
    );
    expect(web.summaries().map((s) => s.mode)).toEqual(["web", "web", "mcp", "mcp"]);
    expect(web.recap()).toContain("보초를 서며 밤을 넘겼다.");
    web.close();
  });
});
