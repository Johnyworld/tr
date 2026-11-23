import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { peopleHere, placesIn, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { watchers } from "./opposition.ts";
import { recordDeed } from "./reputationTools.ts";

/** 구역·장소 설계 ② 장소의 사람 (12-271): 같은 장소 목격 두 배, 적 땅 장소에 들어서면 알아봄, 숨을 때 장소의 눈. 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (roll: number) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-271-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

/** 이 구역에서 지금 사람이 가장 많은 장소 */
const busiest = (w: ReturnType<typeof make>) => {
  const s = w.state();
  return placesIn(s, content, s.playerZone)
    .filter((p) => !p.jail)
    .map((p) => ({ id: p.id, n: peopleHere({ ...s, playerPlace: p.id }, content).length }))
    .sort((a, b) => b.n - a.n)[0]!;
};

describe("장소의 사람 (12-271)", () => {
  it("같은 장소에 있을 사람은 장소를 모르는 '구역 어딘가'의 사람보다 숨은 목격자로 더 잘 본다", () => {
    let same = [0, 0];
    let somewhere = [0, 0];
    for (const roll of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
      const w = make(roll);
      w.executeTool("take_action", act({ place_to: busiest(w).id }));
      const s = w.state();
      const here = new Set(peopleHere(s, content));
      const loose = Object.keys(content.npcs).filter((id) => !s.scene.present.includes(id) && whereIs(s, content, id)?.zone === s.playerZone && whereIs(s, content, id)?.place === null);
      const { deed } = recordDeed(w.ctx(), { summary: "선반에서 통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "semi_private", noisy: false });
      const saw = new Set(deed!.witnesses.filter((x) => x.hidden).map((x) => x.npcId));
      same = [same[0]! + [...here].filter((id) => saw.has(id)).length, same[1]! + here.size];
      somewhere = [somewhere[0]! + loose.filter((id) => saw.has(id)).length, somewhere[1]! + loose.length];
    }
    expect(same[1]).toBeGreaterThan(0);
    expect(somewhere[1]).toBeGreaterThan(0);
    expect(same[0]! / same[1]!).toBeGreaterThan(somewhere[0]! / somewhere[1]!);
  });

  it("적 땅의 장소에 들어서면 그곳의 땅 주인 무리 사람이 알아보고 경보가 울린다", () => {
    const w = make(0.01);
    w.runCheat("~goto c_warehouse");
    const spot = busiest(w);
    const owners = peopleHere({ ...w.state(), playerPlace: spot.id }, content).filter((id) => w.state().characters[id]?.factionId === "faction_c");
    expect(owners.length).toBeGreaterThan(0);
    const r = w.executeTool("take_action", act({ place_to: spot.id }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.resultText).toContain("알아보았다");
    expect(Object.values(w.state().deeds).some((d) => /들어|침입|몰래/.test(d.summary)) || (r.ok && /경보/.test(r.resultText))).toBe(true);
  });

  it("잘 숨으면(굴림이 높으면) 알아보지 못한다", () => {
    const w = make(0.99);
    w.runCheat("~goto c_warehouse");
    const r = w.executeTool("take_action", act({ place_to: busiest(w).id }));
    expect(r.ok && r.resultText).not.toContain("알아보았다");
  });

  it("숨을 때의 지켜보는 눈은 같은 장소에 있을 사람까지, 속일 때는 장면의 사람만", () => {
    const w = make(0.5);
    const spot = busiest(w);
    w.executeTool("take_action", act({ place_to: spot.id }));
    const s = w.state();
    expect(watchers(s, content, undefined, true).length).toBeGreaterThan(watchers(s, content).length);
  });
});

describe("막 들어선 자리의 숨은 목격자 (12-272)", () => {
  it("다른 장소로 정해진 사람은 막 들어선 자리의 일을 보지 못한다", () => {
    const w = make(0.0001);
    w.executeTool("take_action", act({ place_to: "entry" }));
    const s = w.state();
    expect(s.playerPlace).toBeNull();
    const placed = Object.keys(content.npcs).filter((id) => { const at = whereIs(s, content, id); return at?.zone === s.playerZone && !!at.place && !s.scene.present.includes(id); });
    expect(placed.length).toBeGreaterThan(0);
    const { deed } = recordDeed(w.ctx(), { summary: "정문 앞에서 통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "public", noisy: true });
    expect(deed!.witnesses.filter((x) => x.hidden).some((x) => placed.includes(x.npcId))).toBe(false);
  });
});
