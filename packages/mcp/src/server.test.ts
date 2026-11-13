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
    expect(menu.text).toMatch(/^1\. 신병 \(23세\) · .*하급 전투원 · 레벨 0 — .+ · 1일차/m);
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

describe("MCP 캐릭터 생성 (대화로 한 단계씩)", () => {
  it("새 게임은 월드 → 시나리오 → 캐릭터를 create_character로 하나씩 답해 마지막 확인에서 세계가 열린다", async () => {
    const { call, app, manager } = await connect(REAL_CONTENT);
    const first = await call("start_session", { new_world: true });
    expect(app.world).toBeNull();
    expect(app.creating).toBe(true);
    expect(first.text).toContain("월드 고르기");
    expect(first.text).toContain("무너진 도시, 가람");
    const scenario = await call("create_character", { answer: "post_apoc" });
    expect(scenario.text).toContain("시나리오 고르기");
    expect(scenario.text).toContain("열병"); // 월드 이야기
    expect(scenario.text).toContain("청솔형제단의 하급 전투원");
    expect((await call("create_character", { back: true })).text).toContain("월드 고르기");
    await call("create_character", { answer: "무너진 도시, 가람" });
    const name = await call("create_character", { answer: "청솔형제단의 하급 전투원" });
    expect(name.text).toContain("지금 상황");
    expect(name.text).toContain("간이침대");
    expect(name.text).toContain("이름");
    expect((await call("create_character", { answer: "윤하" })).text).toContain("성별");
    expect((await call("create_character", { answer: "female" })).text).toContain("하나씩 정하기");
    const strength = await call("create_character", { answer: "manual" });
    expect(strength.text).toContain("근력");
    expect(strength.text).toContain("남은 포인트 4");
    const bad = await call("create_character", { answer: "5" });
    expect(bad.isError).toBe(true);
    for (const v of ["0", "0", "0", "0", "0", "+1", "2"]) await call("create_character", { answer: v });
    const confirm = await call("create_character", { answer: "none" });
    expect(confirm.text).toContain("확인");
    expect(confirm.text).toContain("매력 +1");
    expect(manager.listSlots()).toHaveLength(0); // 확인 전에는 세이브가 없다
    const ok = await call("create_character", { answer: "start" });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("# GM 지침");
    expect(app.creating).toBe(false);
    const p = app.world!.state().characters[app.world!.state().playerId]!;
    expect(p).toMatchObject({ name: "윤하", gender: "female", stats: { intellect: 2, charm: 1, strength: 0 }, traits: [] });
  });

  it("만드는 중이 아니면 create_character는 오류. character를 주면 바로 만든다 (자동 진행용), 규칙 위반은 오류", async () => {
    const { call, app } = await connect(REAL_CONTENT);
    expect((await call("create_character", { answer: "윤하" })).isError).toBe(true);
    const bad = await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: { strength: 2, agility: 2 }, portrait: null } });
    expect(bad.isError).toBe(true);
    const ok = await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: { intellect: 2, charm: 1 }, portrait: null } });
    expect(ok.isError).toBe(false);
    expect(app.world).not.toBeNull();
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

describe("세션마다 다른 상태 화면 주소", () => {
  it("게임 목록에 이 세션의 상태 화면 주소가 나온다", async () => {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-url-")), content: TEST_CONTENT, rngFactory: () => createSeededRng(3) });
    const app = createMcpServer(manager, { statusUrl: () => "http://127.0.0.1:8792" });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const out = (await client.callTool({ name: "list_worlds", arguments: {} })) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain("이 세션의 상태 화면: http://127.0.0.1:8792");
  });
});

describe("엑스트라 (실제 콘텐츠)", () => {
  it("엽총 보초를 만들어 덮치고, 쓰러뜨리면 엽총을 줍는다. 이름을 물으면 이름이 생긴다", async () => {
    const { call, app } = await connect(REAL_CONTENT, 0, () => 0.99);
    await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: { strength: 2, agility: 1 }, portrait: null } });
    const spawned = await call("spawn_extra", { template: "c_sentry_shotgun", label: "엽총 든 보초" });
    expect(spawned.text).toContain("엽총(shotgun)");
    // 부엌칼로는 무거운 피해를 노릴 수 없다 (기획서 4.8). 가벼운 피해로 두 번
    const strike = { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "몸싸움" };
    const heavy = await call("take_action", action({ intent: "보초를 덮친다", target: "ex_1", check: { ...strike, target_harm: "heavy" } }));
    expect(heavy.isError).toBe(true);
    await call("take_action", action({ intent: "보초를 덮친다", target: "ex_1", check: { ...strike, target_harm: "light" } }));
    const hit = await call("take_action", action({ intent: "한 번 더 찌른다", target: "ex_1", check: { ...strike, target_harm: "light" } }));
    expect(hit.text).toContain("무력화");
    expect((await call("transfer_item", { from: "ex_1", to: "player", item_id: "shotgun", quantity: 1 })).isError).toBe(false);
    expect(app.world!.state().characters.player!.inventory.shotgun).toBe(1);
    const named = await call("learn_name", { target: "ex_1" });
    expect(named.isError).toBe(false);
    expect(app.world!.state().characters.ex_1!.name).not.toBe("엽총 든 보초");
  });
});

describe("주인공 사망: 서술 먼저, 상태 화면은 뒤에", () => {
  it("죽으면 GM에게 무슨 일이 있었는지부터 쓰라고 하고, 묘비명을 남길 때까지 상태 화면은 죽기 직전 모습", async () => {
    const { statusPayload } = await import("./statusServer.ts");
    const { call, app } = await connect(TEST_CONTENT, 0, () => 0); // 1+1 실패
    await call("start_session", { new_world: true });
    const source = { get world() { return app.world; }, scenarioName: "x", get frozenStatus() { return app.frozenStatus; } };
    const lethal = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "목이 졸려" };
    let out = { text: "" };
    for (let i = 0; i < 3 && !app.world!.isPlayerDead(); i++) out = await call("take_action", action({ intent: "몸싸움", check: lethal }));
    expect(app.world!.isPlayerDead()).toBe(true);
    expect(out.text).toContain("무슨 일이 있었는지 서술한다");
    expect(out.text).toContain("목이 졸려");
    expect((statusPayload(source) as { player: { dead: boolean } }).player.dead).toBe(false); // 아직 죽기 전 모습
    await call("write_epitaph", { text: "목이 졸려 죽었다." });
    expect((statusPayload(source) as { player: { dead: boolean } }).player.dead).toBe(true);
  });
});

describe("턴 문 (Claude Code 훅)", () => {
  it("세계 id가 맞으면 멈추고 풀고, 다르면 무시한다. 세션 시작 결과에 세계 id 표식이 있다", async () => {
    const { statusPayload, TurnGate } = await import("./statusServer.ts");
    const { call, app } = await connect();
    const start = await call("start_session", { new_world: true });
    const id = app.world!.id;
    expect(start.text).toContain(`[trpg-world:${id}]`);
    const source = { get world() { return app.world; }, scenarioName: "x" };
    const gate = new TurnGate();
    const time = () => (statusPayload(source, gate) as { player: { timeLabel: string } }).player.timeLabel;
    expect(gate.start(source, "other")).toBe(false);
    expect(gate.start(source, id)).toBe(true);
    const before = time();
    await call("take_action", action({ activity: { kind: "wait", until: null } }));
    expect(time()).toBe(before); // 서술이 끝날 때까지 그대로
    expect(gate.end("other")).toBe(false);
    expect(gate.end(id)).toBe(true);
    expect(time()).not.toBe(before);
  });
});

describe("사망 뒤 새 캐릭터 만들기", () => {
  it("new를 고르면 세계 소개 없이 한 단계씩 만들고, 확인하면 같은 세계에서 이어 간다", async () => {
    const { statusPayload } = await import("./statusServer.ts");
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-heir-")), content: REAL_CONTENT, rngFactory: () => () => 0 });
    const app = createMcpServer(manager, { statusUrl: () => "http://127.0.0.1:8790" });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join("\n"), isError: r.isError === true };
    };
    await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: {}, portrait: null } });
    expect((await call("choose_next_character", { character_id: "new" })).isError).toBe(true); // 살아 있다
    const lethal = { move: "fight", stat: "strength", difficulty: "very_hard", harm_on_failure: "heavy", harm_cause: "총상" };
    for (let i = 0; i < 4 && !app.world!.isPlayerDead(); i++) await call("take_action", action({ intent: "돌격", check: lethal }));
    expect(app.world!.isPlayerDead()).toBe(true);
    const worldId = app.world!.id;

    const first = await call("choose_next_character", { character_id: "new" });
    expect(first.text).toContain("다른 사람의 삶");
    expect(first.text).not.toContain("월드 고르기");
    expect(first.text).not.toContain("지금 상황");
    const source = { get world() { return app.world; }, scenarioName: "x", get creating() { return app.creating; } };
    expect(statusPayload(source)).toMatchObject({ creating: true });
    for (const a of ["서진", "여성", "random", "manual", ["허약 체질"], ["아름다운 외모"], "없음"]) {
      const r = await call("create_character", { answer: a });
      expect(r.isError, r.text).toBe(false);
    }
    const done = await call("create_character", { answer: "start" });
    expect(done.text).toContain("캐릭터를 만들었다");
    expect(app.world!.id).toBe(worldId);
    const p = app.world!.state().characters[app.world!.state().playerId]!;
    expect(p).toMatchObject({ name: "서진", gender: "female", traits: ["frail", "beautiful"], dead: false });
    expect(statusPayload(source)).toMatchObject({ open: true });
  });
});

describe("치트 도구 (개발 모드)", () => {
  it("debug일 때만 cheat 도구가 있고, ~ 입력을 실행한다", async () => {
    const plain = await connect();
    expect((await plain.client.listTools()).tools.map((t) => t.name)).not.toContain("cheat");
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-dbg-")), content: TEST_CONTENT, rngFactory: () => createSeededRng(3) });
    const app = createMcpServer(manager, { debug: true });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    await client.callTool({ name: "start_session", arguments: { new_world: true } });
    const out = (await client.callTool({ name: "cheat", arguments: { input: "~give bomb 1" } })) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain("폭탄");
    expect(app.world!.state().characters.player!.inventory.bomb).toBe(1);
  });
});

describe("월드가 여럿일 때 (MCP)", () => {
  it("세계를 열면 tool 입력 스키마가 그 월드의 것으로 바뀌고, 상태 화면 머리도 그 월드 이름", async () => {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-multi-")), content: [REAL_CONTENT, TEST_CONTENT], rngFactory: () => createSeededRng(3) });
    const w = manager.create("mcp", undefined, undefined, TEST_CONTENT.scenario.id);
    const id = w.id;
    w.close();
    const app = createMcpServer(manager);
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const schemaText = async () => JSON.stringify((await client.listTools()).tools.find((t) => t.name === "take_action")!.inputSchema);
    expect(await schemaText()).toContain("nerve"); // 기본 월드(실제 팩)
    expect(app.title).toBe("TRPG");
    await client.callTool({ name: "load_world", arguments: { world_id: id } });
    expect(await schemaText()).toContain("cool"); // 테스트 팩의 능력
    expect(await schemaText()).not.toContain("nerve");
    expect(app.title).toBe(TEST_CONTENT.scenario.name);
    const r = (await client.callTool({ name: "take_action", arguments: action({ check: { move: "endure", stat: "cool", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } }) })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content[0]!.text).not.toBe(true);
  });
});

describe("자유 시나리오 (MCP)", () => {
  it("직접 쓰기를 고르면 글 → custom_start로 옮기기 → 확인 → 캐릭터 만들기로 이어진다", async () => {
    const { call, app } = await connect(REAL_CONTENT);
    await call("start_session", { new_world: true });
    await call("create_character", { answer: "post_apoc" });
    expect((await call("create_character", { answer: "직접 쓰기" })).text).toContain("직접 쓰는 시나리오");
    expect((await call("create_character", { answer: "나는 청솔형제단의 분대장이다." })).text).toContain("옮기기");
    const input = {
      faction: "faction_a", rank: "squad_leader", title: "청솔형제단 분대장", location: "a_base", kit: "fighter",
      skills: { fight: 1, tactics: 1 }, age: 34, opening: "새벽, 당신은 분대원들을 깨운다.", background: ["붕괴 전에는 소방관이었다."],
    };
    const bad = await call("create_character", { custom_start: { ...input, rank: "leader" } });
    expect(bad.isError).toBe(true);
    expect((await call("create_character", { custom_start: input })).text).toContain("상관: 한도윤");
    expect((await call("create_character", { answer: "confirm" })).text).toContain("분대원들을 깨운다");
    for (const a of ["강민", "male", "random", "none"]) await call("create_character", { answer: a });
    const done = await call("create_character", { answer: "start" });
    expect(done.isError).toBe(false);
    expect(app.world!.state().characters.player).toMatchObject({ name: "강민", rank: "squad_leader" });
  });
});
