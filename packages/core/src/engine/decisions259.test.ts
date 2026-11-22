import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStorylets } from "../content/loader.ts";
import { aliasOf, withKnownNames } from "../game/acquaintance.ts";
import { makeFamily } from "../game/startGroup.ts";
import { heldSeenZone } from "../rules/held.ts";
import { hearsay } from "../rules/news.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { carriedWeight, carryCapacity } from "./gear.ts";
import { stowStartingLoad } from "./stash.ts";

/** 플레이 테스트 15 파트 7 (12-259): 이야기 전제·콘텐츠 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string, roll = 0.5) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-259-")), content, rngFactory: () => () => roll }).create("mcp", roleId, choice);

describe("이야기 장소 (12-259)", () => {
  it("갇힌 사람이 배역인 이야기가 가두는 곳 아닌 장소를 말하면 content:check가 잡는다", () => {
    const s = content.storylets.cp_prisoner_breakout!;
    const bad = { ...content, storylets: { ...content.storylets, [s.id]: { ...s, setup: "새벽, 창고 쪽에서 쇠 긁는 소리가 난다." } } };
    expect(checkStorylets(content).filter((p) => p.includes("가두는 곳"))).toEqual([]);
    expect(checkStorylets(bad).some((p) => p.includes(s.id) && p.includes("보급 창고"))).toBe(true);
  });
});

describe("믿음 글 (12-259)", () => {
  it("남이 아는 조각 글은 '~고 들었다'로 옮긴다", () => {
    expect(hearsay("경비병 한 사람에게 돌아가는 탄이 다섯 발이 안 된다는 것")).toBe("경비병 한 사람에게 돌아가는 탄이 다섯 발이 안 된다고 들었다");
    expect(hearsay("창고 열쇠는 간부만 지닌다.")).toBe("창고 열쇠는 간부만 지닌다고 들었다");
    expect(hearsay("다음 배급 조정 계획")).toBe("들은 말: 다음 배급 조정 계획");
  });

  it("갇힌 사람을 장면에서 보면 어디 붙잡혀 있는지 기억한다", () => {
    const w = world("role_a_grunt");
    const id = "a_gicheol_scout";
    const zone = w.state().characters[id]!.captive!.zone;
    w.runCheat(`~goto ${zone}`);
    const r = w.executeTool("npc_presence", { npc_id: id, action: "enter" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(heldSeenZone(w.state(), id)).toBe(zone);
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.source === "seen" && b.fact.includes("붙잡혀 있다"))).toBe(true);
  });

  it("이름을 알게 되면 믿음 속 호칭을 지금 아는 이름으로 (조사도 맞춘다)", () => {
    const w = world("role_t_visitor");
    const id = Object.keys(content.npcs).find((n) => w.state().characters[n] && !(w.state().known[w.state().playerId] ?? []).includes(n))!;
    const alias = aliasOf(w.state(), content, id);
    const fact = `${alias}은 당분간 지켜보겠다고 했다`;
    expect(withKnownNames(w.state(), content, fact)).toBe(fact);
    w.ctx().store.append({ type: "name_learned", characterId: w.state().playerId, targetId: id });
    const name = w.state().characters[id]!.name;
    expect(withKnownNames(w.state(), content, fact).startsWith(name)).toBe(true);
    expect(withKnownNames(w.state(), content, fact)).not.toContain(alias);
  });
});

describe("시작 장소 (12-259)", () => {
  it("시작 장면 글이 말하는 장소, 또는 역할의 start_place에서 시작한다", () => {
    expect(world("role_a_squad_leader").state().playerPlace).toBe("storehouse");
    expect(world("role_a_grunt").state().playerPlace).toBe("barracks");
    expect(world("role_y_islander").state().playerPlace).toBe("dock");
  });
});

describe("시작 짐·가족 성 (12-259)", () => {
  it("짐이 한도를 넘으면 무거운 것부터 사물함에 넣는다", () => {
    const w = world("role_y_islander");
    w.runCheat("~give old_rifle 3");
    const me = () => w.state().characters[w.state().playerId]!;
    expect(carriedWeight(content, me())).toBeGreaterThan(carryCapacity(content, me(), w.state()));
    const stowed = stowStartingLoad(w.ctx());
    expect(stowed.length).toBeGreaterThan(0);
    expect(carriedWeight(content, me())).toBeLessThanOrEqual(carryCapacity(content, me(), w.state()));
    expect(Object.keys(w.state().stashes[w.state().playerId]?.yeoul_isle ?? {}).length).toBeGreaterThan(0);
  });

  it("이름에 성이 없어도 형제자매·자식은 아버지 성을 따른다", () => {
    for (const seed of [0.11, 0.37, 0.62, 0.88]) {
      let x = seed;
      const rng = () => (x = (x * 9301 + 0.49297) % 1);
      const fam = makeFamily(content, { age: 25, gender: "male" }, 4, rng, null);
      const father = fam.find((m) => m.relation === "parent" && m.gender === "male");
      for (const m of fam.filter((m) => m.relation === "sibling" || m.relation === "child")) if (father) expect(m.name[0]).toBe(father.name[0]);
      const sibs = fam.filter((m) => m.relation === "sibling");
      if (sibs.length > 1) expect(new Set(sibs.map((m) => m.name[0])).size).toBe(1);
    }
  });
});

describe("얼굴을 보고 하는 선택지 (12-259)", () => {
  it("편지를 건네는 선택지는 받을 사람에게 가서 건넨다. 근처에 없으면 고를 수 없다", () => {
    const w = world("role_a_grunt");
    w.runCheat("~storylet sister_letter");
    const at = whereIs(w.state(), content, "a_jiho");
    const r = w.executeTool("resolve_storylet", { choice_id: "deliver" });
    if (at && at.zone === w.state().playerZone) {
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(w.state().scene.present).toContain("a_jiho");
      if (at.place) expect(w.state().playerPlace).toBe(at.place);
    } else {
      expect(r.ok).toBe(false);
    }
  });
});
