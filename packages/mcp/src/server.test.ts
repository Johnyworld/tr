import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, createSeededRng, loadContent, WorldManager, type Content } from "@trpg/core";
import { TEST_CONTENT } from "@trpg/core/testing";
import { createMcpServer } from "./server.ts";

const REAL_CONTENT = loadContent(
  resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../content/scenarios/post_apoc"),
);

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

async function connect(content: Content = TEST_CONTENT, seed = 7, rng?: () => number) {
  const manager = new WorldManager({
    savesDir: mkdtempSync(join(tmpdir(), "trpg-mcp-")),
    content,
    rngFactory: () => rng ?? createSeededRng(seed),
  });
  const app = createMcpServer(manager);
  opened.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  };
  return { app, manager, client, call };
}

const action = (overrides: Record<string, unknown> = {}) => ({
  intent: "주변을 살핀다",
  check: null,
  activity: null,
  deed: null,
  target: null,
  narration_summary: null, for_mission: false,
  ...overrides,
});

describe("MCP tool", () => {
  it("턴 단위 tool과 run_command 하나만 연다 (정보용 개별 tool은 없다)", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["get_gm_guide", "start_session", "load_world", "list_worlds", "get_scene", "take_action", "fast_forward", "recall", "record_turn_summary", "run_command"]) {
      expect(names).toContain(name);
    }
    for (const removed of ["get_character_sheet", "get_map", "get_relations", "request_check", "spend_time"]) {
      expect(names).not.toContain(removed);
    }
  });

  it("세계를 열기 전에는 오류를 돌려준다", async () => {
    const { call } = await connect();
    expect((await call("get_scene")).isError).toBe(true);
  });

  it("start_session → take_action → 결과와 다음 장면, 의도와 요약은 세이브에 남는다", async () => {
    const { call, app } = await connect();
    const start = await call("start_session", { new_world: true });
    expect(start.text).toContain("## 현재 장면");
    expect(start.text).toContain("?도움말");
    // play 프롬프트를 부르지 않아도 지침이 전달된다 (플레이 테스트 1회차: 지침을 못 읽음)
    expect(start.text).toContain("# GM 지침");
    expect(start.text).toContain("record_turn_summary");

    const result = await call("take_action", action({ activity: { kind: "talk", until: null }, narration_summary: "막사에서 깨어났다." }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain("대화: 10분 경과");
    expect(result.text).toContain("## 현재 장면");
    expect(app.world?.transcript().slice(0, 2)).toEqual([
      { kind: "note", text: "막사에서 깨어났다." },
      { kind: "player", text: "주변을 살핀다" },
    ]);
  });

  it("run_command는 읽기 전용이다", async () => {
    const { call, app } = await connect();
    await call("start_session", { new_world: true });
    const before = JSON.stringify(app.world!.state());
    const out = await call("run_command", { input: "!상태" });
    expect(out.text).toContain("━━━ 신병");
    expect((await call("run_command", { input: "?상태" })).text).toBe(out.text);
    expect((await call("run_command", { input: "?" })).text).toContain("?상태");
    expect(JSON.stringify(app.world!.state())).toBe(before);
  });

  it("같은 세계는 동시에 열 수 없다 (다른 MCP 세션·웹 앱과 잠금으로 막는다)", async () => {
    const first = await connect();
    await first.call("start_session", { new_world: true });
    const worldId = first.app.world!.id;
    const second = createMcpServer(first.manager);
    opened.push(second);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await second.server.connect(s);
    const client = new Client({ name: "t2", version: "0" });
    await client.connect(c);
    const res = (await client.callTool({ name: "load_world", arguments: { world_id: worldId } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("다른 곳에서 열려 있습니다");
  });
});

describe("세이브 슬롯과 종료", () => {
  it("저장된 게임이 있으면 start_session은 세계를 열지 않고 번호 목록을 준다. 번호로 열고, end_session으로 닫는다", async () => {
    const { call, app } = await connect();
    await call("start_session", { new_world: true }); // 이 테스트 콘텐츠에는 생성 규칙이 없어 바로 만든다
    const first = app.world!.id;
    await call("take_action", action());
    const closed = await call("end_session");
    expect(closed.text).toContain("닫았다");
    expect(app.world).toBeNull();

    const menu = await call("start_session");
    expect(app.world).toBeNull();
    expect(menu.text).toMatch(/^1\. 신병 \(23세\) · .*하급 전투원 · 레벨 0 — 1일차/m);
    expect(menu.text).toContain("2. 새 게임");

    const opened = await call("start_session", { slot: 1 });
    expect(opened.isError).toBe(false);
    expect(app.world!.id).toBe(first);
    expect((await call("load_world", { slot: 9 })).isError).toBe(true);

    await call("start_session", { new_world: true });
    expect(app.world!.id).not.toBe(first);
    const list = await call("list_worlds");
    expect(list.text).toContain("3. 새 게임");
  });
});

describe("MCP 캐릭터 생성", () => {
  it("새 게임은 먼저 생성 규칙을 주고, character와 함께 부르면 그대로 만든다. 규칙 위반은 오류", async () => {
    const { call, app } = await connect(REAL_CONTENT);
    const rules = await call("start_session", { new_world: true });
    expect(app.world).toBeNull();
    expect(rules.text).toContain("캐릭터 생성");
    expect(rules.text).toContain("여성(female)");
    const bad = await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: { strength: 2, agility: 2 }, portrait: null } });
    expect(bad.isError).toBe(true);
    expect(app.world).toBeNull();
    const ok = await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: { intellect: 2, charm: 1 }, portrait: null } });
    expect(ok.isError).toBe(false);
    const p = app.world!.state().characters[app.world!.state().playerId]!;
    expect(p).toMatchObject({ name: "윤하", gender: "female", stats: { intellect: 2, charm: 1, strength: 0 } });
    expect(ok.text).toContain("여성");
  });
});

describe("MCP 정보 필터", () => {
  it("모든 tool 결과에 비밀·세계의 진실·믿음의 정확도가 섞이지 않는다 (위반 0건)", async () => {
    const { call } = await connect(REAL_CONTENT, 0, () => 0); // 모든 확률 통과: 숨은 목격자가 생긴다
    const outputs: string[] = [];
    outputs.push((await call("start_session", { new_world: true })).text);
    outputs.push(
      (
        await call(
          "take_action",
          action({
            intent: "창고 뒤에서 통조림을 훔친다",
            deed: { summary: "통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "public", noisy: true, condition: "always" },
          }),
        )
      ).text,
    );
    for (const npcId of Object.keys(REAL_CONTENT.npcs)) {
      outputs.push((await call("npc_presence", { npc_id: npcId, action: "enter" })).text);
    }
    outputs.push((await call("get_scene")).text);
    for (const c of COMMANDS) outputs.push((await call("run_command", { input: `!${c.name}` })).text);
    outputs.push((await call("recall", { query: "정찰조" })).text);
    const all = outputs.join("\n");

    for (const npc of Object.values(REAL_CONTENT.npcs)) {
      if (npc.secret) expect(all, `${npc.id} 비밀`).not.toContain(npc.secret.content);
      for (const truth of npc.doesnt_know) expect(all, `${npc.id} 진실`).not.toContain(truth);
    }
    expect(all).not.toMatch(/accuracy|approximate|hidden/);
  });
});
