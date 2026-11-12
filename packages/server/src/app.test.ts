import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager, type Rng } from "@trpg/core";
import { TEST_CONTENT } from "@trpg/core/testing";
import type { LanguageModel } from "@trpg/gm";
import { createApp } from "./app.ts";
import { WebSession } from "./session.ts";

const sixes: Rng = () => 0.99;

/** 캐릭터 생성 규칙이 있는 테스트 콘텐츠 */
const CREATION_CONTENT = (() => {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.creation = {
    points: 4,
    cost: { "-1": -1, "0": 0, "1": 1, "2": 3 },
    max_low: 2,
    genders: [{ id: "male", label: "남성" }, { id: "female", label: "여성" }],
    traits: { max_positive: 3, max_negative: 3, max_personality: 2 },
  };
  return c;
})();

/** 첫 호출에서 판정을 요청하고, 두 번째 호출에서 서술을 끝내는 가짜 모델 */
const fakeModel: LanguageModel = async function* (request) {
  const last = request.messages.at(-1)!;
  if (last.content.some((b) => b.type === "tool_result")) {
    yield "문이 열렸다.";
    return { stopReason: "end", content: [{ type: "text", text: "문이 열렸다." }] };
  }
  yield "문을 민다.";
  return {
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "t1",
        name: "take_action",
        input: {
          intent: "문을 부순다",
          check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "어깨" },
          activity: null,
          deed: null,
          target: null,
          narration_summary: null, for_mission: false,
        },
      },
    ],
  };
};

function newSession(model: LanguageModel = fakeModel) {
  const manager = new WorldManager({
    savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")),
    content: TEST_CONTENT,
    rngFactory: () => sixes,
  });
  return { manager, session: new WebSession(manager, model, undefined, manager.create("web")) };
}

function postTurn(app: ReturnType<typeof createApp>, input: string) {
  return app.request("/api/game/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

describe("게임 API", () => {
  it("턴을 SSE로 스트리밍하고 기록을 세이브에 남긴다", async () => {
    const { session } = newSession();
    const app = createApp(session);
    const res = await postTurn(app, "문을 부순다");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('event: text\ndata: {"type":"text","text":"문을 민다."}');
    expect(body).toContain('"outcome":"success"');
    expect(body).toContain("event: player");
    expect(body).toContain('event: done\ndata: {"type":"done","stopReason":"end"}');

    const game = (await (await app.request("/api/game")).json()) as {
      transcript: { kind: string }[];
      player: { inventory: unknown[] };
      opening: string;
    };
    expect(game.transcript.map((e) => e.kind)).toEqual(["player", "gm", "tool", "gm"]);
    expect(JSON.stringify(game)).not.toContain("<상태>"); // 프롬프트 원문은 UI로 보내지 않는다
    expect(game.opening).toBe("테스트 시작 장면.");
    session.close();
  });

  it("빈 입력과 잘못된 요청은 400을 돌려준다", async () => {
    const { session } = newSession();
    const app = createApp(session);
    expect((await postTurn(app, "   ")).status).toBe(400);
    expect((await app.request("/api/game/turn", { method: "POST", body: "not json" })).status).toBe(400);
    session.close();
  });

  it("새 게임은 새 세계를 만들고, 이전 세계는 목록에 남는다", async () => {
    const { session, manager } = newSession();
    const app = createApp(session);
    await (await postTurn(app, "문을 부순다")).text();
    const before = session.world.id;
    const game = (await (await app.request("/api/worlds", { method: "POST" })).json()) as {
      transcript: unknown[];
      worldId: string;
    };
    expect(game.transcript).toEqual([]);
    expect(game.worldId).not.toBe(before);
    expect(manager.listWorlds().map((w) => w.id)).toContain(before);
    session.close();
  });
});

describe("시작 화면", () => {
  const post = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { method: "POST" });

  it("서버를 켜면 세계를 열지 않는다. 게임 API는 409, 슬롯 목록은 빈 채로", async () => {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")), content: TEST_CONTENT, rngFactory: () => sixes });
    const session = new WebSession(manager, fakeModel);
    const app = createApp(session);
    const game = await app.request("/api/game");
    expect(game.status).toBe(409);
    expect(((await game.json()) as { noWorld: boolean }).noWorld).toBe(true);
    expect((await postTurn(app, "문을 연다")).status).toBe(409);
    expect(await (await app.request("/api/worlds")).json()).toMatchObject({ slots: [], current: null });
  });

  it("새 게임 → 메인으로 → 슬롯에 주인공 정보가 보이고, 고르면 이어서 연다", async () => {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")), content: TEST_CONTENT, rngFactory: () => sixes });
    const session = new WebSession(manager, fakeModel);
    const app = createApp(session);
    const created = (await (await post(app, "/api/worlds")).json()) as { worldId: string };
    await (await postTurn(app, "문을 부순다")).text();
    expect(((await (await app.request("/api/worlds")).json()) as { slots: { current: boolean }[] }).slots[0]!.current).toBe(true);

    expect((await post(app, "/api/game/close")).status).toBe(200);
    expect(session.hasWorld).toBe(false);
    const { slots } = (await (await app.request("/api/worlds")).json()) as {
      slots: { id: string; current: boolean; lockedBy: string | null; hero: { name: string; rankLabel: string; level: number; generation: number } }[];
    };
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ id: created.worldId, current: false, lockedBy: null, hero: { name: "신병", level: 0, generation: 1 } });

    const opened = (await (await post(app, `/api/worlds/${created.worldId}/open`)).json()) as { worldId: string; transcript: unknown[] };
    expect(opened.worldId).toBe(created.worldId);
    expect(opened.transcript.length).toBeGreaterThan(0);
    expect((await post(app, "/api/worlds/nope/open")).status).toBe(404);

    // 열려 있는 게임은 지울 수 없고, 메인 화면으로 나간 뒤에는 지운다
    const del = (id: string) => app.request(`/api/worlds/${id}`, { method: "DELETE" });
    expect((await del(created.worldId)).status).toBe(409);
    await post(app, "/api/game/close");
    expect((await del(created.worldId)).status).toBe(200);
    expect(((await (await app.request("/api/worlds")).json()) as { slots: unknown[] }).slots).toEqual([]);
    expect((await del(created.worldId)).status).toBe(404);
    session.close();
  });
});

describe("WebSession", () => {
  it("소비자가 중간에 멈춰도 그 턴의 기록을 남기고 턴을 마친다", async () => {
    const slowModel: LanguageModel = async function* (_request, options) {
      yield "첫 문장.";
      await new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) return reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { stopReason: "end", content: [] };
    };
    const { session } = newSession(slowModel);
    for await (const event of session.playTurn("기다린다")) {
      if (event.type === "text") break; // 연결이 끊긴 것처럼 중간에 멈춘다
    }
    expect(session.busy).toBe(false);
    expect(session.world.transcriptView().filter((e) => e.kind !== "tool")).toEqual([
      { kind: "player", text: "기다린다" },
      { kind: "gm", text: "첫 문장." },
    ]);
    expect(session.world.state().turn).toBe(1); // 자동으로 잠깐의 행동이 처리됐다
    session.close();
  });
});

describe("정보 명령어 API", () => {
  it("명령어 결과를 텍스트로 돌려주고 상태를 바꾸지 않는다", async () => {
    const { session } = newSession();
    const app = createApp(session);
    const before = JSON.stringify(session.world.state());
    const res = await app.request("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "!상태" }),
    });
    expect(((await res.json()) as { output: string }).output).toContain("━━━ 신병");
    expect(JSON.stringify(session.world.state())).toBe(before);
    const list = (await (await app.request("/api/commands")).json()) as { name: string }[];
    expect(list.map((c) => c.name)).toContain("도움말");
    session.close();
  });
});

describe("사망과 다음 캐릭터 API", () => {
  /** 판정이 늘 1+1 → 선언한 위험(heavy)으로 죽는다 */
  function deadSession() {
    const manager = new WorldManager({
      savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")),
      content: TEST_CONTENT,
      rngFactory: () => () => 0,
    });
    const session = new WebSession(manager, fakeModel, undefined, manager.create("web"));
    const lethal = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "총상" };
    const base = { activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
    for (let i = 0; i < 3 && !session.world.isPlayerDead(); i++) {
      session.world.executeTool("take_action", { ...base, intent: "돌격", check: lethal });
    }
    expect(session.world.isPlayerDead()).toBe(true);
    return session;
  }

  it("죽으면 화면 정보에 연대기와 후보가 오고, 턴은 막힌다. 고르면 이어서 플레이한다", async () => {
    const session = deadSession();
    const app = createApp(session);
    const game = (await (await app.request("/api/game")).json()) as { succession: { chronicle: string; options: { id: string }[] } | null };
    expect(game.succession?.chronicle).toContain("사망: 총상");
    expect(game.succession?.options.map((o) => o.id)).toEqual(["new", "npc_leader"]);
    expect((await postTurn(app, "일어난다")).status).toBe(409);

    const bad = await app.request("/api/game/succession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: "npc_stranger" }),
    });
    expect(bad.status).toBe(409);
    const res = await app.request("/api/game/succession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: "new", name: "둘째" }),
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { succession: unknown; player: { name: string; dead: boolean } };
    expect(next.succession).toBeNull();
    expect(next.player).toMatchObject({ name: "둘째", dead: false });
  });
});

describe("사망 뒤 새 캐릭터 (생성 화면)", () => {
  it("character를 보내면 그 설정으로 이어 간다. 규칙에 맞지 않으면 409", async () => {
    const manager = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")), content: CREATION_CONTENT, rngFactory: () => () => 0 });
    const session = new WebSession(manager, fakeModel, undefined, manager.create("web"));
    const lethal = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "총상" };
    const base = { activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
    for (let i = 0; i < 3 && !session.world.isPlayerDead(); i++) session.world.executeTool("take_action", { ...base, intent: "돌격", check: lethal });
    const app = createApp(session);
    const post = (body: unknown) => app.request("/api/game/succession", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const character = { name: "서진", gender: "female", abilities: { strength: 2, agility: 1 }, portrait: "p2", traits: [] };
    expect((await post({ characterId: "new", character: { ...character, abilities: { strength: 2, agility: 2 } } })).status).toBe(409);
    const res = await post({ characterId: "new", character });
    expect(res.status).toBe(200);
    const p = session.world.state().characters[session.world.state().playerId]!;
    expect(p).toMatchObject({ name: "서진", gender: "female", portrait: "p2", stats: { strength: 2, agility: 1 }, dead: false });
    session.close();
  });
});
