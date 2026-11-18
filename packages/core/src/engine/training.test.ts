import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { companionSkillMod } from "../game/companions.ts";
import { carryCapacity } from "./gear.ts";
import { conditionsMet } from "../story/storylets.ts";

/** 개 기르기 (12-172) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll: number) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-dog-")), content, rngFactory: () => () => roll }).create("mcp", "role_l_wanderer");
const chk = { move: "survival", stat: "vitality", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" };
const train = (w: GameWorld, dog: string, trick: string) =>
  w.executeTool("take_action", { intent: "가르친다", check: chk, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, train: { companion: dog, trick } });

/** 떠돌이는 누렁이를 데리고 시작하기도 한다. 없으면 불러 함께 다니게 한다 */
function withDog(roll: number) {
  const w = make(roll);
  let dog = w.state().companions.find((id) => w.state().characters[id]?.extra?.template === "stray_dog");
  if (!dog) {
    expect(w.runCheat("~summon extra stray_dog").ok).toBe(true);
    dog = Object.values(w.state().characters).find((c) => c.extra?.template === "stray_dog" && !w.state().companions.includes(c.id))!.id;
    w.ctx().store.append({ type: "companion_joined", characterId: dog, kind: "animal" });
  }
  return { w, dog };
}
/** 며칠 지나게 한다. 굶주림으로 판정이 흔들리지 않게 몸은 되돌린다 */
const later = (w: GameWorld, days: number) => {
  for (let i = 0; i < days; i++) {
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(w.runCheat("~heal").ok).toBe(true);
  }
};

describe("개 기르기", () => {
  it("함께 지낸 날이 모자라면 가르치지 못하고, 차면 성공으로 배운다. 동행 보정이 붙는다", () => {
    const { w, dog } = withDog(0.99);
    expect(train(w, dog, "sniff").ok).toBe(false);
    later(w, 3);
    expect(w.sceneForGm()).toContain("가르칠 수 있는 재주");
    const before = companionSkillMod(w.state(), content, "scavenge");
    const r = train(w, dog, "sniff");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().tricks[dog]?.learned).toEqual(["sniff"]);
    expect(companionSkillMod(w.state(), content, "scavenge")).toBe(before + 1);
    expect(w.sceneForGm()).toContain("배운 재주: 냄새 맡기");
    expect(train(w, dog, "sniff").ok).toBe(false); // 이미 안다
  });

  it("하루 한 번, 대가 있는 성공은 반쯤 배우고 다음에 익힌다", () => {
    const { w, dog } = withDog(0.55); // 2d6 = 8 언저리: 대가 있는 성공
    later(w, 5);
    const r = train(w, dog, "bite");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const rec = w.state().tricks[dog]!;
    if (rec.half.includes("bite")) {
      expect(train(w, dog, "bite").ok).toBe(false); // 같은 날
      later(w, 1);
      train(w, dog, "bite");
      expect(w.state().tricks[dog]?.learned).toContain("bite");
    }
  });

  it("짐 나르기를 배우면 짐 무게 한도가 오르고, 재주 이야기가 열릴 수 있다", () => {
    const { w, dog } = withDog(0.99);
    const me = () => w.state().characters[w.state().playerId]!;
    const cap = carryCapacity(content, me(), w.state());
    const real = loadRealContent();
    const story = { ...real.storylets.dog_carries!, when: { companion_trick: "pack" } } as typeof real.storylets.dog_carries;
    later(w, 7);
    expect(conditionsMet(w.state(), real, story!, w.state().time)).toBe(false);
    train(w, dog, "pack");
    expect(carryCapacity(content, me(), w.state())).toBe(cap + 4);
    expect(conditionsMet(w.state(), real, story!, w.state().time)).toBe(true);
  });

  it("곁에 없는 동물이나 사람에게는 가르치지 않는다", () => {
    const w = make(0.99);
    expect(w.runCheat("~summon extra stray_dog").ok).toBe(true);
    const dog = Object.values(w.state().characters).find((c) => c.extra?.template === "stray_dog" && !w.state().companions.includes(c.id))!.id;
    later(w, 4);
    expect(train(w, dog, "sniff").ok).toBe(false);
  });
});
