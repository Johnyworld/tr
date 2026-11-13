import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { describePlayerState } from "../engine/context.ts";
import { changeStanding } from "../engine/growth.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import type { HistoryPart } from "./background.ts";
import { buildCustomRole, checkCustomStart, type CustomStartInput } from "./customStart.ts";
import { occupationTitle } from "./occupation.ts";

/** 직분과 배경 부품 (기획서 12.6) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const cook: CustomStartInput = {
  faction: "faction_a",
  rank: "staff",
  occupation: "cook",
  title: "청솔형제단 숙수",
  location: "a_base",
  kit: "trader",
  skills: { persuade: 1 },
  age: 34,
  opening: "새벽 식당 천막, 솥에 물이 끓는다.",
  background: [],
};
const open = (input: CustomStartInput) => {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-occ-")), content, rngFactory: () => createSeededRng(5) });
  const role = buildCustomRole(content, input);
  return m.create("mcp", undefined, undefined, undefined, { role, background: input.background, history: input.history ?? [] });
};

describe("직분", () => {
  it("직분 훈련·도구가 더해지고, 전투원이 아니면 무리의 전투 임무를 빌리지 않는다", () => {
    const role = buildCustomRole(content, cook);
    expect(role.occupation).toBe("cook");
    expect(role.start_skills).toMatchObject({ persuade: 1, survival: 1 });
    expect(role.start_inventory).toContain("kitchen_knife");
    expect(role.missions).toEqual([]);
    const soldier = buildCustomRole(content, { ...cook, rank: "grunt", occupation: "soldier" });
    expect(soldier.missions.length).toBeGreaterThan(0);
  });

  it("직분에 맞지 않는 계급, 무리 안의 일인데 무소속이면 막는다", () => {
    expect(checkCustomStart(content, { ...cook, rank: "squad_leader" }).join()).toContain("요리사의 계급");
    expect(checkCustomStart(content, { ...cook, faction: null, rank: "loner", location: "old_town" }).join()).toContain("무소속으로 고를 수 없다");
    expect(checkCustomStart(content, { ...cook, faction: null, rank: "loner", location: "old_town", occupation: "trader" })).toEqual([]);
  });

  it("평판이 쌓이면 직분 사다리를 오르고, GM 상태에 직분이 보인다", () => {
    const w = open(cook);
    const me = () => w.state().characters[w.state().playerId]!;
    expect(occupationTitle(w.content, me())).toBe("요리사 · 숙수");
    expect(describePlayerState(w.state(), w.content)).toContain("직분: 요리사 · 숙수");
    const note = changeStanding(w.ctx(), w.state().playerId, 3, "test") ?? changeStanding(w.ctx(), w.state().playerId, 1, "test");
    expect(note).toContain("부엌 반장");
    expect(occupationTitle(w.content, me())).toBe("요리사 · 부엌 반장");
  });

  it("NPC도 직분이 있고, 배역 occupations로 같은 직분의 동료를 부른다", async () => {
    const { castCandidates } = await import("../story/storylets.ts");
    const w = open(cook);
    expect(w.state().characters.a_bokja!.occupation?.id).toBe("cook");
    const role = { commander: false, known: false, enter: true, optional: false, here: false, faction: "own", occupations: ["same"] } as never;
    expect(castCandidates(w.state(), w.content, role)).toEqual(["a_bokja"]);
  });
});

describe("배경 부품", () => {
  const history: HistoryPart[] = [
    { kind: "loss", who: "어머니와 마을 사람 열 명", by: "faction_c", where: "old_town" },
    { kind: "enemy", target: "c_gyeongsu", why: "마을에 불을 지른 약탈조장이다", knows_you: true },
    { kind: "kin_alive", template: "kin_young", label: "동생", zone: "riverside" },
    { kind: "seeking", template: "kin_elder", label: "사라진 아버지" },
  ];

  it("자기 무리를 통째로 원수로 두거나, 없는 인물을 고르면 막는다", () => {
    expect(checkCustomStart(content, { ...cook, history: [{ kind: "enemy", target: "faction_a", why: "x", knows_you: false }] }).join()).toContain("자기 무리");
    expect(checkCustomStart(content, { ...cook, history: [{ kind: "enemy", target: "nobody", why: "x", knows_you: false }] }).join()).toContain("알 수 없는");
    expect(checkCustomStart(content, { ...cook, history })).toEqual([]);
  });

  it("세계의 사실이 된다: 플래그, 기억, 원수의 이름과 적의, 기다리는 가족, 어딘가에 있는 찾는 사람", () => {
    const w = open({ ...cook, history });
    const s = w.state();
    const flags = s.flags[s.playerId] ?? [];
    expect(flags).toEqual(expect.arrayContaining(["bg_loss", "bg_loss_by_faction_c", "bg_enemy", "bg_enemy_person", "bg_hunted", "bg_kin_alive", "bg_seeking"]));
    expect(s.known[s.playerId]).toContain("c_gyeongsu");
    expect(s.relations.c_gyeongsu?.[s.playerId]?.trust).toBeLessThan(0);
    const kin = s.background.find((e) => e.part.kind === "kin_alive")!.characterId!;
    expect(s.bonds[kin]?.apart?.zone).toBe("riverside");
    expect(s.characters[kin]!.extra?.zone).toBe("riverside");
    const sought = s.background.find((e) => e.part.kind === "seeking")!.characterId!;
    expect(s.characters[sought]!.extra?.zone).not.toBe(s.playerZone);
    expect(s.scene.present).not.toContain(sought);
    expect(s.scene.present).not.toContain(kin);
    const gm = describePlayerState(s, w.content);
    expect(gm).toContain("지난 일 (세계의 사실");
    expect(gm).toContain("원수: 마경수");
    // 찾는 사람이 어디 있는지는 GM에게도 보이지 않는다 (원칙 4)
    expect(gm).not.toContain(w.content.locations[s.characters[sought]!.extra!.zone!]!.name + "에서 기다린다");
  });

  it("같은 사람이 가해자이자 원수여도 세계가 만들어진다 (플레이 테스트에서 찾은 버그)", () => {
    const w = open({ ...cook, history: [{ kind: "loss", who: "식구들", by: "c_gyeongsu", where: "old_town" }, { kind: "enemy", target: "c_gyeongsu", why: "불을 질렀다", knows_you: true }] });
    expect(w.state().known[w.state().playerId]).toContain("c_gyeongsu");
  });

  it("배경 배역: 원수·가족·찾는 사람을 이야기가 부른다", () => {
    const w = open({ ...cook, history });
    const s = w.state();
    const story = (cast: Record<string, unknown>) => ({
      id: "bgtest",
      title: "t",
      tags: [],
      repeatable: false,
      urgent: false,
      cooldown_days: 0,
      weight: 1,
      when: { flags_all: ["bg_enemy"] },
      cast,
      setup: "x",
      choices: [{ id: "a", label: "a", effects: [] }],
    });
    const c = (cast: Record<string, unknown>) => ({ ...w.content, storylets: { bgtest: story(cast) as never } });
    const role = (r: Record<string, unknown>) => ({ commander: false, known: false, enter: true, optional: false, here: false, ...r });
    expect(eligibleStorylets(s, c({ foe: role({ background: "enemy" }) }))).toHaveLength(1);
    expect(eligibleStorylets(s, c({ foe: role({ background: "sought", here: true }) }))).toHaveLength(0);
    expect(eligibleStorylets(s, c({ foe: role({ background: "enemy_member" }) }))).toHaveLength(1);
    // 빚진 무리, 도망친 무리의 사람은 그 배경이 있을 때만
    expect(eligibleStorylets(s, c({ foe: role({ background: "creditor" }) }))).toHaveLength(0);
    const w2 = open({ ...cook, history: [{ kind: "debt", faction: "faction_e", size: "small" }, { kind: "deserter", faction: "faction_c" }, { kind: "enemy", target: "faction_c", why: "x", knows_you: false }] });
    const c2 = (cast: Record<string, unknown>) => ({ ...w2.content, storylets: { bgtest: story(cast) as never } });
    expect(eligibleStorylets(w2.state(), c2({ foe: role({ background: "creditor" }) }))).toHaveLength(1);
    expect(eligibleStorylets(w2.state(), c2({ foe: role({ background: "deserted" }) }))).toHaveLength(1);
    expect(w2.state().characters[w2.state().playerId]!.debts.faction_e).toBe(5);
  });
});

describe("직분 자동 플레이", () => {
  for (const [occupation, faction, rank] of [
    ["cook", "faction_c", "grunt"],
    ["mechanic", "faction_e", "staff"],
    ["trader", null, "loner"],
  ] as const) {
    it(`${occupation}: 오류 없이 돌고, 직분 이야기가 열린다`, async () => {
      const { autoplay } = await import("../sim/autoplay.ts");
      const location = faction ? Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")!.id : "old_town";
      const w = open({ ...cook, faction, rank, occupation, location });
      const stats = autoplay(w, w.content, createSeededRng(9), 300);
      w.close();
      expect(stats.errors).toEqual([]);
      const tag = `occ_${occupation}`;
      expect(Object.keys(stats.storyletsFired).some((id) => content.storylets[id]?.tags.includes(tag))).toBe(true);
    }, 30_000);
  }
});
