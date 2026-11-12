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
    expect(menu.text).toMatch(/^0\. 새 게임\n1\. /m); // 새 게임이 맨 위

    const opened = await call("start_session", { slot: 1 });
    expect(opened.isError).toBe(false);
    expect(app.world!.id).toBe(first);
    expect((await call("load_world", { slot: 9 })).isError).toBe(true);

    await call("start_session", { new_world: true });
    expect(app.world!.id).not.toBe(first);
    const list = await call("list_worlds");
    expect(list.text).toContain("0. 새 게임");
    expect(list.text).toMatch(/^2\. /m);
    await call("end_session");
    expect((await call("start_session", { slot: 0 })).text).not.toContain("1. "); // 0번: 새 게임 (이 콘텐츠는 생성 규칙이 없어 바로 연다)
    expect(app.world).not.toBeNull();
  });
});

describe("MCP 세이브 삭제", () => {
  it("목록을 보고 있을 때만, 확인을 받은 뒤에만 지운다", async () => {
    const { call, app, manager } = await connect();
    await call("start_session", { new_world: true });
    const id = app.world!.id;
    expect((await call("delete_world", { slot: 1, confirmed: true })).isError).toBe(true); // 게임 중
    await call("end_session");
    await call("start_session", { new_world: true });
    await call("end_session"); // 목록이 열려 있다 (2개)
    const ask = await call("delete_world", { slot: 2 });
    expect(ask.text).toContain("아직 지우지 않았다");
    expect(manager.listSlots()).toHaveLength(2);
    const done = await call("delete_world", { slot: 2, confirmed: true });
    expect(done.isError).toBe(false);
    expect(manager.listSlots()).toHaveLength(1);
    expect(done.text).toContain("0. 새 게임");
    expect((await call("delete_world", { slot: 5, confirmed: true })).isError).toBe(true);
    void id;
  });

  it("목록을 본 적이 없으면 지우지 않는다", async () => {
    const { call, manager } = await connect();
    manager.create("mcp").close();
    const res = await call("delete_world", { slot: 1, confirmed: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("list_worlds");
    expect(manager.listSlots()).toHaveLength(1);
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

describe("상태 화면", () => {
  it("열린 게임이 없으면 open: false, 열면 시트. 세션 시작 안내에 주소가 나온다", async () => {
    const { statusPayload } = await import("./statusServer.ts");
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-status-")), content: TEST_CONTENT, rngFactory: () => createSeededRng(7) });
    const app = createMcpServer(manager, { statusUrl: () => "http://127.0.0.1:8790" });
    opened.push(app);
    const source = { get world() { return app.world; }, scenarioName: "테스트" };
    expect(statusPayload(source)).toEqual({ open: false, scenarioName: "테스트" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const start = (await client.callTool({ name: "start_session", arguments: { new_world: true } })) as { content: { text: string }[] };
    expect(start.content[0]!.text).toContain("상태 화면: http://127.0.0.1:8790");
    await client.callTool({ name: "take_action", arguments: action({ check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } }) });
    const status = statusPayload(source) as { open: boolean; player: { name: string; timeLabel: string } };
    expect(status.open).toBe(true);
    expect(status.player.name).toBe("신병");
    expect(Object.keys(status)).toEqual(["open", "scenarioName", "worldId", "player"]); // 시트만 (서술은 채팅에)
  });
});

describe("브라우저에서 캐릭터 생성", () => {
  async function setup(waitMs = 5000, statusUrl: string | null = "http://127.0.0.1:8790") {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bcreate-")), content: REAL_CONTENT, rngFactory: () => createSeededRng(3) });
    const app = createMcpServer(manager, { statusUrl: () => statusUrl, creationWaitMs: waitMs });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const call = async (args: Record<string, unknown>) =>
      ((await client.callTool({ name: "start_session", arguments: args })) as { content: { text: string }[] }).content[0]!.text;
    return { app, call };
  }
  const choice = { name: "한서진", gender: "female", abilities: { senses: 2, agility: 1 }, portrait: "p3", traits: [] };

  it("시작을 누를 때까지 기다렸다가 그 세계로 이어 간다", async () => {
    const { app, call } = await setup();
    const waiting = call({ create_in_browser: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(app.browserCreation.pending).toBe(true);
    const { statusPayload } = await import("./statusServer.ts");
    expect(statusPayload({ world: app.world, scenarioName: "x", creation: app.browserCreation })).toMatchObject({ creating: true });
    expect(app.browserCreation.submit(choice)).toEqual({ ok: true });
    const out = await waiting;
    expect(out).toContain("브라우저에서 캐릭터를 만들었다");
    expect(out).toContain("# GM 지침");
    expect(app.world!.state().characters.player).toMatchObject({ name: "한서진", portrait: "p3" });
    expect(app.browserCreation.pending).toBe(false);
  });

  it("규칙에 맞지 않으면 만들지 않고 계속 기다린다. 시간이 넘으면 '다 했어'로 이어 간다", async () => {
    const { app, call } = await setup(100);
    const waiting = call({ create_in_browser: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(app.browserCreation.submit({ ...choice, abilities: { senses: 2, agility: 2 } }).ok).toBe(false);
    expect(await waiting).toContain("다 했어");
    expect(app.browserCreation.pending).toBe(true);
    expect(app.browserCreation.submit(choice).ok).toBe(true); // 시간이 넘은 뒤 만들었다
    expect(await call({ create_in_browser: true })).toContain("# GM 지침");
  });

  it("생성을 열지 않았으면 브라우저에서 만들 수 없고, 상태 화면이 없으면 채팅으로 만든다", async () => {
    const { app } = await setup();
    expect(app.browserCreation.submit(choice).ok).toBe(false);
    const none = await setup(5000, null);
    expect(await none.call({ create_in_browser: true })).toContain("채팅으로 만든다");
  });
});

describe("브라우저 생성 직후 시트 미루기", () => {
  it("만든 직후엔 '만들었다' 안내, GM이 open_sheet를 부르거나 다른 tool을 부르면 시트", async () => {
    const { statusPayload } = await import("./statusServer.ts");
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-hold-")), content: REAL_CONTENT, rngFactory: () => createSeededRng(3) });
    const app = createMcpServer(manager, { statusUrl: () => "http://127.0.0.1:8790" });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const source = { get world() { return app.world; }, scenarioName: "x", creation: app.browserCreation, get sheetHeld() { return app.sheetHeld; } };
    const waiting = client.callTool({ name: "start_session", arguments: { create_in_browser: true } }) as Promise<{ content: { text: string }[] }>;
    await new Promise((r) => setTimeout(r, 30));
    app.browserCreation.submit({ name: "서진", gender: "female", abilities: { senses: 2, agility: 1 }, portrait: "p2", traits: [] });
    expect((await waiting).content[0]!.text).toContain("open_sheet");
    expect(statusPayload(source)).toMatchObject({ open: false, created: true, name: "서진" });
    await client.callTool({ name: "open_sheet", arguments: {} });
    expect(statusPayload(source)).toMatchObject({ open: true });
  });
});
