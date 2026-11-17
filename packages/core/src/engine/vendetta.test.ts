import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { castCandidates, storyletVars } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 원한과 복수 (12-135): 주인공이 죽인 사람의 가족·친구가 누가 죽였는지 알면 복수를 다짐한다 */
const content = loadRealContent();

function open(rng: number) {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-vd-")), content, rngFactory: () => () => rng }).create("mcp", "role_a_grunt");
  const s = () => w.state();
  // 태호와 지호를 형제로 잇는다
  s().dynamicTies.push({ a: "a_taeho", b: "a_jiho", kind: "sibling", secret: null });
  s().scene.present = s().scene.present.filter((id) => id !== "a_jiho");
  const kill = () => changeCondition(w.ctx(), "a_taeho", content.scenario.harm_track, 99, "attack", "주인공의 칼");
  return { w, s, kill };
}

describe("원한과 복수", () => {
  it("다른 목격자가 있었으면 그 자리에 없던 형제도 누가 죽였는지 알고 복수를 다짐한다", () => {
    const { s, kill } = open(0.99);
    s().scene.present = ["a_taeho", "a_chaewon"];
    kill();
    expect(s().vendettas).toContainEqual(expect.objectContaining({ avenger: "a_jiho", victim: "a_taeho" }));
    expect(s().relations.a_jiho?.[s().playerId]?.trust).toBeLessThan(0);
  });

  it("아무도 보지 않았으면 흔적으로 알게 될 때만 (30%)", () => {
    const hidden = open(0.99);
    hidden.s().scene.present = ["a_taeho"];
    hidden.kill();
    expect(hidden.s().vendettas).toHaveLength(0);
    const traced = open(0);
    traced.s().scene.present = ["a_taeho"];
    traced.kill();
    expect(traced.s().vendettas.map((v) => v.avenger)).toContain("a_jiho");
  });

  it("주인공이 죽인 게 아니면 복수는 없다", () => {
    const { w, s } = open(0);
    s().scene.present = ["a_taeho", "a_chaewon"];
    changeCondition(w.ctx(), "a_taeho", content.scenario.harm_track, 99, "cheat", "다른 일");
    expect(s().vendettas).toHaveLength(0);
  });

  it("복수 배역은 다짐한 사람만 채우고, {victim}은 죽은 사람이며, settle_vendetta로 풀린다", () => {
    const { w, s, kill } = open(0);
    s().scene.present = ["a_taeho", "a_chaewon"];
    kill();
    const story = content.storylets.vd_confront!;
    const inside = content.storylets.vdi_glare!;
    // 지호는 주인공과 같은 무리: 같은 지붕 아래의 원수 이야기에만 나온다
    expect(castCandidates(s(), content, inside.cast.avenger!)).toContain("a_jiho");
    expect(castCandidates(s(), content, story.cast.avenger!)).not.toContain("a_jiho");
    expect(storyletVars(s(), content, { avenger: "a_jiho" }).victim).toBeTruthy();
    fireStorylet(w.ctx(), story, { avenger: "a_jiho" });
    // 판정이 있는 선택지는 같은 턴에 판정을 먼저 한다. '대가'는 결과와 상관없이 원한이 풀린다
    executeTool("take_action", { intent: "맞는다", check: { move: "endure", stat: "vitality", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false }, w.ctx());
    const out = executeTool("resolve_storylet", { choice_id: "pay" }, w.ctx());
    expect(out.ok ? "" : out.error).toBe("");
    expect(s().vendettas.map((v) => v.avenger)).not.toContain("a_jiho");
    expect(castCandidates(s(), content, inside.cast.avenger!)).not.toContain("a_jiho");
  });

  describe("복수할 사람이 없으면 엑스트라 가족·친구를 만든다", () => {
    const spawnScout = (w: ReturnType<typeof open>["w"]) => {
      executeTool("spawn_extra", { template: "a_scout", label: "수색대원" }, w.ctx());
      return Object.values(w.state().characters).filter((c) => c.extra?.template === "a_scout" && !c.dead && !c.profile).at(-1)!.id;
    };
    const avengersOf = (s: ReturnType<typeof open>["s"], victim: string) => s().vendettas.filter((v) => v.victim === victim).map((v) => v.avenger);

    it("이름 없는 사람을 죽이면 확률로 그 사람의 가족·친구가 생겨 복수를 다짐한다. 장면에도 들어오지 않고 만난 것으로도 치지 않는다", () => {
      const { w, s } = open(0);
      const scout = spawnScout(w);
      changeCondition(w.ctx(), scout, content.scenario.harm_track, 99, "attack", "주인공의 칼");
      const [avenger] = avengersOf(s, scout);
      expect(avenger).toBeTruthy();
      const c = s().characters[avenger!]!;
      expect(c.profile).toBeTruthy(); // 바로 자란다
      expect(s().dynamicTies.some((t) => t.a === avenger && t.b === scout)).toBe(true);
      expect(s().scene.present).not.toContain(avenger);
      expect(s().known[s().playerId] ?? []).not.toContain(avenger);
    });

    it("확률에 걸리지 않으면 아무도 생기지 않는다", () => {
      const { w, s } = open(0.99);
      const scout = spawnScout(w);
      changeCondition(w.ctx(), scout, content.scenario.harm_track, 99, "attack", "주인공의 칼");
      expect(avengersOf(s, scout)).toHaveLength(0);
    });

    it("이름 있는 인물이라도 가족·친구가 없으면 엑스트라 가족이 생긴다", () => {
      const { w, s } = open(0);
      const lonely = Object.values(content.npcs).find((n) => !n.ties?.length && n.faction && !s().dynamicTies.some((t) => t.a === n.id || t.b === n.id) && !Object.values(content.npcs).some((m) => m.ties?.some((t) => t.to === n.id)))!.id;
      changeCondition(w.ctx(), lonely, content.scenario.harm_track, 99, "attack", "주인공의 칼");
      const [avenger] = avengersOf(s, lonely);
      expect(avenger).toBeTruthy();
      expect(s().characters[avenger!]!.extra).toBeTruthy();
    });

    it("복수를 다짐한 사람이 셋이면 더 만들지 않는다", () => {
      const { w, s } = open(0);
      for (let i = 0; i < 4; i++) changeCondition(w.ctx(), spawnScout(w), content.scenario.harm_track, 99, "attack", "주인공의 칼");
      expect(s().vendettas.length).toBe(3);
    });
  });

  it("다른 무리의 복수자는 바깥 이야기에, 떠돌이 주인공에게는 누구나 바깥 이야기에", () => {
    const { s } = open(0);
    s().vendettas.push({ avenger: "a_jiho", victim: "a_taeho", since: 0 });
    const outside = content.storylets.vd_asking_around!.cast.avenger!;
    const inside = content.storylets.vdi_glare!.cast.avenger!;
    s().characters.a_jiho!.factionId = "faction_c";
    expect(castCandidates(s(), content, outside)).toContain("a_jiho");
    expect(castCandidates(s(), content, inside)).not.toContain("a_jiho");
    s().characters[s().playerId]!.factionId = "";
    s().characters.a_jiho!.factionId = "";
    expect(castCandidates(s(), content, outside)).toContain("a_jiho");
  });
});
