import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { HashEmbedder } from "./embedder.ts";
import type { IndexChunk } from "./index.ts";
import { MemoryStore, memoryItemsOf } from "./memory.ts";

const NO_ACTION = { check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };

/** 임베딩 호출 횟수를 세는 임베더 */
class CountingEmbedder extends HashEmbedder {
  calls = 0;
  texts = 0;
  override async embed(texts: readonly string[]) {
    this.calls += 1;
    this.texts += texts.length;
    return super.embed(texts);
  }
}

const memo = (id: string, text: string, knownBy: string[]): IndexChunk => ({
  id,
  sourceId: "memory/deed",
  title: "행적",
  section: "",
  visibility: "known_by",
  kind: "deed",
  knownBy,
  createdAt: 0,
  text,
});

const viewer = (characterId: string) => ({ characterId, factionId: "faction_a", flags: new Set<string>() });

describe("MemoryStore", () => {
  it("아는 사람(knownBy)에게만 검색된다", async () => {
    const store = MemoryStore.open(":memory:", new HashEmbedder(128));
    await store.sync([memo("deed:d_1", "창고에서 통조림을 몰래 챙겼다", ["player"]), memo("deed:d_2", "초소에서 담배를 피웠다", ["npc_x"])]);
    const mine = await store.search("통조림 창고 담배 초소", viewer("player"), { topK: 10 });
    expect(mine.hits.map((h) => h.id)).toEqual(["deed:d_1"]);
    const other = await store.search("통조림 창고 담배 초소", viewer("npc_x"), { topK: 10 });
    expect(other.hits.map((h) => h.id)).toEqual(["deed:d_2"]);
    // characterId가 없는 검색자(lore 전용)는 기억을 하나도 못 본다
    const nobody = await store.search("통조림 담배", { factionId: "faction_a", flags: new Set() }, { topK: 10 });
    expect(nobody.hits).toEqual([]);
    // 검색 기록에도 남의 기억이 들어가지 않는다
    expect(JSON.stringify(mine.trace)).not.toContain("d_2");
  });

  it("남의 기억이 많아도 볼 수 있는 기억이 후보에서 밀려나지 않는다", async () => {
    const store = MemoryStore.open(":memory:", new HashEmbedder(128));
    // 검색어와 똑같은 남의 기억이 후보 수(20)보다 훨씬 많고, 내 기억은 덜 닮았다
    const others = Array.from({ length: 60 }, (_, i) => memo(`deed:o_${i}`, `창고에서 통조림을 몰래 챙겼다 ${i}`, [`npc_${i}`]));
    await store.sync([...others, memo("deed:mine", "창고 근처에서 담배를 피웠다", ["player"])]);
    const result = await store.search("창고에서 통조림을 몰래 챙겼다", viewer("player"));
    expect(result.hits.map((h) => h.id)).toEqual(["deed:mine"]);
  });

  it("소문이 퍼져 아는 사람이 늘면 다시 임베딩하지 않고 메타데이터만 바꾼다", async () => {
    const embedder = new CountingEmbedder(128);
    const store = MemoryStore.open(":memory:", embedder);
    await store.sync([memo("deed:d_1", "창고에서 통조림을 몰래 챙겼다", ["player"])]);
    const before = embedder.texts;
    expect((await store.search("통조림", viewer("npc_leader"))).hits).toEqual([]);

    await store.sync([memo("deed:d_1", "창고에서 통조림을 몰래 챙겼다", ["npc_leader", "player"])]);
    const hits = (await store.search("통조림", viewer("npc_leader"))).hits;
    expect(hits.map((h) => h.id)).toEqual(["deed:d_1"]);
    // 검색어 임베딩 1회만 늘었다 (문서는 다시 임베딩하지 않음)
    expect(embedder.texts - before).toBe(2);
  });

  it("같은 문장의 기억은 한 번만 나온다", async () => {
    const store = MemoryStore.open(":memory:", new HashEmbedder(128));
    await store.sync([memo("summary:1", "[2일차 04:00 · 지난 일] 새벽에 눈을 떴다.", ["player"]), memo("summary:2", "[2일차 05:00 · 지난 일] 새벽에 눈을 떴다.", ["player"])]);
    expect((await store.search("새벽에 눈을 떴다", viewer("player"), { topK: 10 })).hits).toHaveLength(1);
  });

  it("세이브에서 사라진 기억은 색인에서도 지운다", async () => {
    const store = MemoryStore.open(":memory:", new HashEmbedder(128));
    await store.sync([memo("deed:d_1", "하나", ["player"]), memo("deed:d_2", "둘", ["player"])]);
    await store.sync([memo("deed:d_1", "하나", ["player"])]);
    expect(store.count()).toBe(1);
  });
});

describe("세계와 memory", () => {
  function manager() {
    const savesDir = mkdtempSync(join(tmpdir(), "trpg-memory-"));
    const embedder = new CountingEmbedder(128);
    return { m: new WorldManager({ savesDir, content: TEST_CONTENT, rngFactory: () => createSeededRng(3), memoryEmbedder: embedder }), savesDir, embedder };
  }

  it("요약·행적·믿음이 저장되면 기억으로 쌓이고, 검색 기록이 남는다", async () => {
    const { m, savesDir } = manager();
    const world = m.create("mcp");
    world.executeTool("take_action", {
      ...NO_ACTION,
      intent: "창고를 뒤진다",
      narration_summary: "보급 창고 뒤편에서 녹슨 통조림 상자를 발견했다.",
      deed: { summary: "보급 창고에서 통조림을 몰래 챙겼다", tags: ["theft"], severity: 1, privacy: "private", noisy: false, condition: "always" },
    });
    world.recordSummary("scene", "새벽, 보급 창고에서 몰래 식량을 챙겼다.");

    const result = await world.searchMemory("통조림 창고", "recall", { topK: 10 });
    const kinds = result.hits.map((h) => h.kind);
    expect(kinds).toContain("deed");
    // 행적 문장에는 누가 했는지가 들어간다 (이름으로 물어도 찾게)
    const player = world.state().characters[world.state().playerId]!;
    expect(result.hits.find((h) => h.kind === "deed")?.text).toContain(`${player.name}: 보급 창고에서 통조림을 몰래 챙겼다`);
    expect(kinds).toContain("scene_summary");
    expect(world.retrievals(5)[0]).toMatchObject({ collection: "memory", purpose: "recall" });
    // memory 색인은 세이브 옆 파생 파일이고, 세계 목록에는 나오지 않는다
    expect(existsSync(join(savesDir, "worlds", `${world.id}.memory.db`))).toBe(true);
    world.close();
    expect(m.listWorlds().map((w) => w.id)).toEqual([world.id]);
    expect(readdirSync(join(savesDir, "worlds")).filter((f) => f.endsWith(".db"))).toHaveLength(2);
  });

  it("!일지 검색어는 memory를 의미 검색하고, 읽기 전용이다", async () => {
    const { m } = manager();
    const world = m.create("mcp");
    world.executeTool("take_action", { ...NO_ACTION, intent: "걷는다", narration_summary: "식당에서 묽은 죽을 받았다." });
    const before = JSON.stringify(world.state());
    const out = await world.runCommand("!일지 식당 죽");
    expect(out).toContain("식당에서 묽은 죽을 받았다.");
    expect(JSON.stringify(world.state())).toBe(before);
    world.close();
  });

  it("다시 열면 바뀐 것만 임베딩한다", async () => {
    const { m, embedder } = manager();
    const world = m.create("mcp");
    world.recordSummary("scene", "막사에서 분대장을 만났다.");
    await world.searchMemory("분대장", "recall");
    const id = world.id;
    world.close();
    await new Promise((r) => setTimeout(r, 10));

    const before = embedder.texts;
    const reopened = m.open(id, "web");
    await reopened.searchMemory("분대장", "recall");
    expect(embedder.texts - before).toBe(1); // 검색어만
    reopened.close();
  });
});

describe("memoryItemsOf", () => {
  it("다른 캐릭터의 요약과 믿음은 그 캐릭터만 안다 (캐릭터가 바뀌면 이전 기억은 안 보인다)", async () => {
    const { m } = { m: new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-memory-")), content: TEST_CONTENT }) };
    const world = m.create("mcp");
    const items = memoryItemsOf(world.state(), TEST_CONTENT, [
      { turn: 1, time: 0, kind: "scene", text: "옛 캐릭터의 기억", mode: "mcp", characterId: "old_hero" },
      { turn: 2, time: 0, kind: "scene", text: "지금 캐릭터의 기억", mode: "mcp", characterId: world.state().playerId },
    ]);
    expect(items.slice(0, 2).map((i) => i.knownBy)).toEqual([["old_hero"], [world.state().playerId]]);
    // 믿음은 그것을 믿는 캐릭터만 안다 (NPC의 믿음은 플레이어에게 보이지 않는다)
    for (const item of items.filter((i) => i.kind === "belief")) expect(item.knownBy).toHaveLength(1);

    const store = MemoryStore.open(":memory:", new HashEmbedder(128));
    await store.sync(items);
    const hits = (await store.search("캐릭터의 기억", viewer(world.state().playerId), { topK: 10 })).hits;
    expect(hits.some((h) => h.text.includes("지금 캐릭터의 기억"))).toBe(true);
    expect(hits.some((h) => h.text.includes("옛 캐릭터의 기억"))).toBe(false);
    for (const h of hits) expect(items.find((i) => i.id === h.id)?.knownBy).toContain(world.state().playerId);
    world.close();
  });

  it("행적은 행동한 사람의 이름을 아는 사람과 모르는 사람의 청크로 나뉜다 (이름이 새지 않게)", () => {
    const { m } = { m: new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-memory-")), content: TEST_CONTENT }) };
    const world = m.create("mcp");
    world.executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" });
    world.executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" });
    world.executeTool("take_action", {
      ...NO_ACTION,
      intent: "물을 나눈다",
      deed: { summary: "목마른 사람에게 물을 나눠 줬다", tags: ["mercy"], severity: 2, privacy: "public", noisy: false, condition: "always" },
    });
    const state = world.state();
    const player = state.characters[state.playerId]!;
    const deeds = memoryItemsOf(state, TEST_CONTENT, []).filter((i) => i.kind === "deed");
    const named = deeds.find((d) => d.id.endsWith(":named"))!;
    const unnamed = deeds.find((d) => d.id.endsWith(":unnamed"))!;
    // 같은 무리 분대장은 이름을 알고, 처음 만난 상인은 모른다
    expect(named.knownBy).toEqual(expect.arrayContaining(["npc_leader", state.playerId]));
    expect(named.text).toContain(`${player.name}: 목마른 사람에게 물을 나눠 줬다`);
    expect(unnamed.knownBy).toEqual(["npc_stranger"]);
    expect(unnamed.text).not.toContain(player.name);
    expect(unnamed.text).toContain("우리 무리 하급 전투원: 목마른 사람에게 물을 나눠 줬다");
    world.close();
  });
});
