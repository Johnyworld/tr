import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, createSeededRng, WorldManager, type Content } from "@trpg/core";
import { loadRealContent, TEST_CONTENT } from "@trpg/core/testing";
import { createMcpServer } from "./server.ts";

const REAL_CONTENT = loadRealContent();

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
    expect(menu.text).toMatch(/^1\. 신병 \(23세\) · .*분대원 · 레벨 1 — .+ · 1일차/m);
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
    expect(first.text).toContain("무너진 도시 가람");
    const scenario = await call("create_character", { answer: "post_apoc" });
    expect(scenario.text).toContain("어떤 시나리오로 시작할까요");
    expect(scenario.text).toContain("튜토리얼: 방문자");
    expect(scenario.text).toContain("🔒 비극의 고리 (잠김)");
    expect((await call("create_character", { back: true })).text).toContain("월드 고르기");
    await call("create_character", { answer: "무너진 도시 가람" });
    expect((await call("create_character", { answer: "비극의 고리" })).isError).toBe(true); // 잠겨 있다
    // 지금 상황은 캐릭터 만들기에서 묻지 않는다 (게임을 시작할 때 첫 장면 앞에서)
    const name = await call("create_character", { answer: "튜토리얼: 방문자" });
    expect(name.text).not.toContain("지금 상황");
    expect(name.text).toContain("과거 배경");
    expect((await call("create_character", { answer: "teacher" })).text).toContain("이름");
    expect((await call("create_character", { answer: "윤하" })).text).toContain("성별");
    expect((await call("create_character", { answer: "female" })).text).toContain("나이");
    expect((await call("create_character", { answer: "70" })).isError).toBe(true);
    expect((await call("create_character", { answer: "27세" })).text).toContain("고치기");
    const set = await call("create_character", { answer: "manual" });
    expect(set.text).toContain("근력");
    expect(set.text).toContain("가장 자신 있는 것");
    const bad = await call("create_character", { answer: "지능 / 매력" });
    expect(bad.isError).toBe(true);
    expect((await call("create_character", { answer: "지능 / 매력, 감각 / 체력" })).text).toContain("배경대로");
    await call("create_character", { answer: "past" });
    // 성격 축 (12-99): 한 번에 한 줄로
    expect((await call("create_character", { answer: "none" })).text).toContain("다혈질");
    const confirm = await call("create_character", { answer: "다혈질 2, 과묵함 1" });
    expect(confirm.text).toContain("확인");
    expect(confirm.text).toContain("매력 +1");
    expect(confirm.text).toContain("성격: 다혈질 2, 과묵함 1");
    // 캐릭터를 다 만들면 수위 → 서술 방식. 마지막을 고르면 세계가 열린다
    expect((await call("create_character", { answer: "start" })).text).toContain("수위");
    expect((await call("create_character", { answer: "off" })).text).toContain("서술 방식");
    expect(manager.listSlots()).toHaveLength(0); // 다 고르기 전에는 세이브가 없다
    const ok = await call("create_character", { answer: "script" });
    expect(ok.isError).toBe(false);
    // 게임을 시작하면 첫 장면 앞에서 지금 상황을 단락 그대로 보여 준다
    expect(ok.text).toContain("## 지금 상황");
    expect(ok.text).toContain("이 모든 일이 시작되고 나서 2년이 지났다.");
    expect(ok.text).toContain("인간은 패배했다.\n\n2년 동안");
    expect(ok.text).toContain("# GM 지침");
    expect(app.creating).toBe(false);
    const p = app.world!.state().characters[app.world!.state().playerId]!;
    expect(p).toMatchObject({ name: "윤하", gender: "female", age: 27, stats: { intellect: 2, charm: 1, strength: 0 }, skills: { leadership: 2, history: 1, persuade: 0 }, past: { id: "teacher" }, traits: [] });
    expect(app.world!.state().options).toEqual({ mature: false, dialogue: "script" }); // 새 게임에서 고른 서술 방식 (12-85)
    // 튜토리얼: 찾는 가족이 버들마을에 있다 (주인공은 어디 있는지 모른다)
    const st = app.world!.state();
    expect(st.scenarioRole).toBe("role_t_visitor");
    expect(st.family.length).toBeGreaterThanOrEqual(2);
    expect(st.family.every((id) => st.characters[id]!.extra?.zone === "b_base")).toBe(true);
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
  it("설정 창: 열린 게임의 설정을 읽고 바꾼다. JSON만 받고, 게임이 없거나 값이 틀리면 오류", async () => {
    const { handleOptions } = await import("./statusServer.ts");
    const { createServer } = await import("node:http");
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-options-")), content: TEST_CONTENT, rngFactory: () => createSeededRng(7) });
    let world: ReturnType<WorldManager["create"]> | null = null;
    const source = { get world() { return world; }, scenarioName: "테스트" };
    const server = createServer((req, res) => void handleOptions(source, req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/options`;
    const post = (body: string, type = "application/json") => fetch(base, { method: "POST", headers: { "content-type": type }, body });
    try {
      expect(await (await fetch(base)).json()).toEqual({ open: false });
      expect((await post(JSON.stringify({ dialogue: "script" }))).status).toBe(409);
      world = manager.create("mcp", Object.keys(TEST_CONTENT.roles)[0]!);
      expect(await (await fetch(base)).json()).toEqual({ open: true, options: { mature: false, dialogue: "novel" } });
      const ok = await post(JSON.stringify({ dialogue: "script" }));
      expect(await ok.json()).toEqual({ open: true, options: { mature: false, dialogue: "script" } });
      expect(world.state().options.dialogue).toBe("script");
      expect((await post(JSON.stringify({ dialogue: "poem" }))).status).toBe(400);
      expect((await post(JSON.stringify({}))).status).toBe(400);
      expect((await post("dialogue=novel", "application/x-www-form-urlencoded")).status).toBe(415);
      expect(world.state().options.dialogue).toBe("script");
    } finally {
      server.close();
      world?.close();
    }
  });

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

describe("시나리오 해금 알림 (상태 화면의 토스트)", () => {
  it("닫지 않은 알림은 어느 화면에서든 함께 가고, 시트가 멈춰 있으면 새 알림은 서술이 끝난 뒤에 뜬다. 닫으면 바로 사라진다", async () => {
    const { statusPayload, TurnGate } = await import("./statusServer.ts");
    const { app, call } = await connect(REAL_CONTENT);
    await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: null, portrait: null } });
    let pending = [{ pack: "post_apoc", roleId: "role_a_grunt", title: "비극의 고리" }];
    const source = {
      get world() {
        return app.world;
      },
      scenarioName: "x",
      unlockNotices: () => pending,
      dismissUnlockNotice: (_: string, roleId: string) => {
        pending = pending.filter((n) => n.roleId !== roleId);
        return true;
      },
    };
    expect(statusPayload(source)).toMatchObject({ open: true, unlockNotices: [{ title: "비극의 고리" }] });
    const gate = new TurnGate();
    gate.start(source, app.world!.id);
    // 멈춘 동안 새로 생긴 알림은 아직 보이지 않는다
    pending = [...pending, { pack: "post_apoc", roleId: "role_b_guard", title: "문을 지키는 사람" }];
    expect((statusPayload(source, gate) as { unlockNotices: unknown[] }).unlockNotices).toHaveLength(1);
    // 멈춘 동안에도 닫은 알림은 바로 사라진다
    source.dismissUnlockNotice("post_apoc", "role_a_grunt");
    expect(statusPayload(source, gate)).not.toHaveProperty("unlockNotices");
    gate.end(app.world!.id);
    expect(statusPayload(source, gate)).toMatchObject({ unlockNotices: [{ title: "문을 지키는 사람" }] });
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
    const strike = { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "몸싸움", harm_kind: "blunt", distance: "close" };
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
    const lethal = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "목이 졸려", harm_kind: "blunt" };
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
    // 난수가 늘 0이면 버팀(12-109)이 언제나 이겨 죽지 않는다: 이 테스트에서는 끈다
    const content = structuredClone(REAL_CONTENT);
    content.scenario.growth!.resilience = [];
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-heir-")), content, rngFactory: () => () => 0 });
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
    expect((await call("choose_next_character", { character_id: "new:faction_a:grunt" })).isError).toBe(true); // 살아 있다
    const lethal = { move: "fight", stat: "strength", difficulty: "very_hard", harm_on_failure: "heavy", harm_cause: "총상", harm_kind: "gunshot" };
    for (let i = 0; i < 4 && !app.world!.isPlayerDead(); i++) await call("take_action", action({ intent: "돌격", check: lethal }));
    expect(app.world!.isPlayerDead()).toBe(true);
    const worldId = app.world!.id;

    // 두 번째 주인공부터는 시나리오 없이 세계만 이어 간다: 조우한 무리의 자리를 고르면 바로 캐릭터 만들기부터
    const chronicle = await call("get_chronicle");
    expect(chronicle.text).toContain("new:faction_a:grunt");
    expect(chronicle.text).toContain("new:faction_a:officer");
    const first = await call("choose_next_character", { character_id: "new:faction_a:squad_leader" });
    expect(first.text).toContain("새 캐릭터");
    expect(first.text).toContain("다른 사람의 삶");
    expect(first.text).toContain("과거 배경");
    expect(first.text).not.toContain("월드 고르기");
    const source = { get world() { return app.world; }, scenarioName: "x", get creating() { return app.creating; } };
    expect(statusPayload(source)).toMatchObject({ creating: true });
    for (const a of ["police", "서진", "여성", "기본", "random", "past", "manual", ["허약 체질", "아름다운 외모"], "없음"]) {
      const r = await call("create_character", { answer: a });
      expect(r.isError, r.text).toBe(false);
    }
    const done = await call("create_character", { answer: "start" });
    expect(done.text).toContain("캐릭터를 만들었다");
    expect(app.world!.id).toBe(worldId);
    const p = app.world!.state().characters[app.world!.state().playerId]!;
    expect(p).toMatchObject({ name: "서진", gender: "female", traits: ["frail", "beautiful"], dead: false, rank: "squad_leader", factionId: "faction_a" });
    // 앞 주인공의 시나리오(비극의 고리)는 이어지지 않는다
    expect(app.world!.state().scenarioRole).toBe("");
    expect(app.world!.guide()).not.toContain("## 시나리오:");
    const facts = app.world!.state().beliefs[p.id]!.map((b) => b.fact).join(" / ");
    expect(facts).toContain("붕괴 전에 나는 경찰이었다");
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

describe("상태 화면에서 새 게임 고르기 (12-67)", () => {
  async function connectWithScreen(waitMs = 5000) {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-screen-")), content: REAL_CONTENT, rngFactory: () => createSeededRng(7) });
    const app = createMcpServer(manager, { statusUrl: () => "http://127.0.0.1:8790", creationWaitMs: waitMs });
    opened.push(app);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await app.server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join("\n"), isError: r.isError === true };
    };
    return { app, call };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("in_browser면 tool이 기다리고, 화면이 월드 → 시나리오 → 캐릭터를 고르면 세계를 열고 돌아간다", async () => {
    const { app, call } = await connectWithScreen();
    const waiting = call("start_session", { new_world: true, in_browser: true });
    await settle();
    expect(app.creation?.view).toMatchObject({ step: "world" });
    expect(app.submitCreation({ answer: "없는 월드" })).toMatchObject({ ok: false });
    for (const answer of ["post_apoc", "role_t_visitor", "police", "윤하", "female"]) expect(app.submitCreation({ answer }), answer).toEqual({ ok: true });
    // 화면에서 만들면 성별 다음에 그 성별의 얼굴을 화풍 섹션으로 고른다 (12-139)
    expect(app.creation!.view.step).toBe("portrait");
    expect(app.creation!.view.world?.id).toBe("post_apoc");
    expect(app.creation!.view.character!.portraits.map((x) => x.style)).toEqual(["D"]);
    expect(app.submitCreation({ answer: "../evil" })).toMatchObject({ ok: false });
    expect(app.submitCreation({ answer: "d_m1" })).toMatchObject({ ok: false });
    expect(app.submitCreation({ answer: "d_f1" })).toEqual({ ok: true });
    expect(app.creation!.view.character!.chosen.portrait).toBe("d_f1");
    for (const answer of ["31", "manual"]) expect(app.submitCreation({ answer }), answer).toEqual({ ok: true });
    const view = app.creation!.view;
    expect(view.step).toBe("ability_set");
    expect(view.character!.tiers!.map((t) => t.value)).toEqual([2, 1, -1]);
    expect(app.submitCreation({ answer: "intellect / charm, senses / strength" })).toEqual({ ok: true });
    expect(app.creation!.view.step).toBe("skills");
    expect(app.submitCreation({ answer: "manual" })).toEqual({ ok: true });
    // 4.2.1: 과거 배경(경찰)이 가르치지 않은 전문 기술에는 점수를 둘 수 없다
    expect(app.submitCreation({ answer: ["사격 +2", "응급처치"] })).toMatchObject({ ok: false });
    expect(app.submitCreation({ answer: ["사격 +2", "눈치 +1", "경계"] })).toEqual({ ok: true });
    expect(app.submitCreation({ answer: "manual" })).toEqual({ ok: true });
    expect(app.creation!.view.character!.traits.length).toBeGreaterThan(0);
    expect(app.submitCreation({ answer: [] })).toEqual({ ok: true });
    expect(app.submitCreation({ answer: [] })).toEqual({ ok: true });
    expect(app.creation!.view.step).toBe("confirm");
    expect(app.submitCreation({ answer: "start" })).toEqual({ ok: true });
    // 캐릭터 다음에 수위, 서술 방식
    expect(app.creation!.view.step).toBe("content");
    expect(app.submitCreation({ answer: "off" })).toEqual({ ok: true });
    expect(app.creation!.view.step).toBe("dialogue");
    expect(app.submitCreation({ answer: "novel" })).toEqual({ ok: true });
    const done = await waiting;
    expect(done.isError).toBe(false);
    expect(done.text).toContain("상태 화면에서 골랐다");
    expect(done.text).toContain("# GM 지침");
    expect(app.world!.state().characters[app.world!.state().playerId]).toMatchObject({ name: "윤하", age: 31, portrait: "d_f1", stats: { intellect: 2, charm: 1, senses: 1, strength: -1 }, skills: { shoot: 2, insight: 1, sense_danger: 0 } }); // 방문자는 무소속이라 계급 기본 훈련이 없다
    expect(app.creation).toBeNull();
  });

  it("기다리다 시간이 넘으면 안내하고, 그 뒤 화면에서 마치면 create_character(wait)가 결과를 준다", async () => {
    const { app, call } = await connectWithScreen(30);
    const first = await call("start_session", { new_world: true, in_browser: true });
    expect(first.text).toContain("다 했어");
    for (const answer of ["post_apoc", "role_t_visitor", "police", "서진", "male", "none", "기본", "random", "past", "none", "기본", "start", "off", "novel"]) expect(app.submitCreation({ answer }), answer).toEqual({ ok: true });
    expect(app.world).not.toBeNull();
    const later = await call("create_character", { wait: true });
    expect(later.text).toContain("상태 화면에서 골랐다");
  });

  it("화면에서 시작한 만들기는 끝까지 화면에서: GM이 wait 없이 답을 넘겨도 받지 않는다 (12-214)", async () => {
    const { app, call } = await connectWithScreen(30);
    await call("start_session", { new_world: true, in_browser: true });
    for (const a of ["post_apoc", "role_t_visitor"]) expect(app.submitCreation({ answer: a })).toEqual({ ok: true });
    const r = await call("create_character", { answer: "police" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("상태 화면에서 만드는 중");
    expect(app.creation).toMatchObject({ driver: "screen", view: { step: "past" } });
  });

  it("메인 메뉴: in_browser만 주면 화면에서 고를 때까지 기다리고, 새로운 게임은 만들기로 이어진다 (12-214)", async () => {
    const { app, call } = await connectWithScreen();
    const waiting = call("start_session", { in_browser: true });
    await settle();
    expect(app.creation).toBeNull();
    expect(app.gm).toEqual({ waiting: true });
    expect(app.menuAction({ action: "new" })).toEqual({ ok: true });
    expect(app.creation).toMatchObject({ driver: "screen", fromMenu: true, view: { step: "world" } });
    // 첫 단계에서 메인 메뉴로 돌아갈 수 있다
    expect(app.submitCreation({ menu: true })).toEqual({ ok: true });
    expect(app.creation).toBeNull();
    expect(app.menuAction({ action: "new" })).toEqual({ ok: true });
    for (const answer of ["post_apoc", "role_t_visitor", "police", "서진", "male", "none", "기본", "random", "past", "none", "기본", "start", "off", "novel"]) expect(app.submitCreation({ answer }), answer).toEqual({ ok: true });
    const done = await waiting;
    expect(done.text).toContain("상태 화면에서 골랐다");
    expect(app.world).not.toBeNull();
  });

  it("메인 메뉴: 이어서 하기에서 열면 기다리던 GM에게 가고, 삭제는 열려 있지 않은 세이브만 (12-214)", async () => {
    const { app, call } = await connectWithScreen();
    await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: null, portrait: null } });
    const id = app.world!.id;
    await call("end_session");
    expect(app.slots().map((s) => s.id)).toContain(id);
    const waiting = call("start_session", { in_browser: true });
    await settle();
    expect(app.menuAction({ action: "open", id })).toEqual({ ok: true });
    const opened = await waiting;
    expect(opened.text).toContain("이어서 하기에서 저장된 게임을 열었다");
    expect(opened.text).toContain("# GM 지침");
    // 게임 중에는 메뉴를 쓸 수 없다
    expect(app.menuAction({ action: "delete", id })).toMatchObject({ ok: false });
    expect(app.exitGame()).toEqual({ ok: true });
    expect(app.world).toBeNull();
    // GM에게는 따로 알리지 않는다: 다음 게임 tool이 "열린 세계가 없다"를 받는다
    const next = await call("get_scene");
    expect(next.isError).toBe(true);
    expect(next.text).toContain("상태 화면에서 게임을 끝냈을 수 있다");
    expect(app.menuAction({ action: "delete", id })).toEqual({ ok: true });
    expect(app.slots().map((s) => s.id)).not.toContain(id);
  });

  it("기다리는 GM이 없으면 메인 메뉴에서 게임을 열거나 시작할 수 없고, 삭제만 된다 (12-214)", async () => {
    const { app, call } = await connectWithScreen();
    await call("start_session", { new_world: true, character: { name: "윤하", gender: "female", abilities: null, portrait: null } });
    const id = app.world!.id;
    await call("end_session");
    expect(app.gm).toEqual({ waiting: false });
    expect(app.menuAction({ action: "open", id })).toMatchObject({ ok: false, error: expect.stringContaining("/play") });
    expect(app.menuAction({ action: "new" })).toMatchObject({ ok: false });
    expect(app.world).toBeNull();
    expect(app.menuAction({ action: "delete", id })).toEqual({ ok: true });
  });

  it("채팅에서 시작한 만들기는 끝까지 채팅에서: 화면은 따라 그리기만 하고 답을 받지 않는다 (12-214)", async () => {
    const { app, call } = await connectWithScreen();
    await call("start_session", { new_world: true });
    for (const answer of ["post_apoc", "role_t_visitor", "police"]) await call("create_character", { answer });
    expect(app.creation).toMatchObject({ driver: "chat", view: { step: "name" } });
    expect(app.submitCreation({ answer: "서진", version: app.creation!.version })).toMatchObject({ ok: false });
    expect(app.submitCreation({ back: true })).toMatchObject({ ok: false });
    await call("create_character", { answer: "서진" });
    await call("create_character", { answer: "male" });
    // 채팅에서는 얼굴 단계가 없다
    expect(app.creation!.view.step).not.toBe("portrait");
  });

  it("화면에서 만들 때 옛 판으로 보낸 답은 거절한다 (12-214)", async () => {
    const { app, call } = await connectWithScreen(30);
    await call("start_session", { new_world: true, in_browser: true });
    const version = app.creation!.version;
    expect(app.submitCreation({ answer: "post_apoc", version })).toEqual({ ok: true });
    expect(app.submitCreation({ answer: "role_t_visitor", version })).toMatchObject({ ok: false });
    expect(app.submitCreation({ answer: "role_t_visitor", version: app.creation!.version })).toEqual({ ok: true });
  });
});
