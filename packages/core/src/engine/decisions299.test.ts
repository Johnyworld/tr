import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { whereIs } from "../rules/place.ts";
import { REGARD_KINDS } from "../rules/regard.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { checkBareGivenNames } from "../content/loader.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { makeOffer } from "./requests.ts";
import { learn } from "./reputationTools.ts";
import { applyEffect, maskUnknownNames } from "./storyletTools.ts";

/** PT27 뒤 고친 것 (12-299). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const quiet = { ...content, storylets: {} };
const make = (role: string, roll = 0.5, c = quiet) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-299-")), content: c, rngFactory: () => () => roll }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("PT27 뒤 고친 것 (12-299)", () => {
  it("성을 뺀 이름은 실행 중에 가리지 않고(보통 낱말이 같다) 콘텐츠 검사가 잡는다 (12-300, PT28)", () => {
    const w = make("role_c_raider");
    expect(maskUnknownNames(w.state(), content, "발 끄는 소리가 난다. 아이 하나가 운다")).toBe("발 끄는 소리가 난다. 아이 하나가 운다");
    expect(checkBareGivenNames(content)).toEqual([]);
    const bad = structuredClone(content);
    bad.storylets.tr_inn_whisper!.ai_direction = "미란은 더 조심한다";
    expect(checkBareGivenNames(bad).some((p) => p.includes("tr_inn_whisper") && p.includes("미란"))).toBe(true);
  });

  it("임무 완수로 오를 몫이 하루 상한에 막히면 GM 한 줄을 돌려준다", () => {
    const w = make("role_a_grunt");
    const me = w.state().playerId;
    const boss = content.roles.role_a_grunt!.commander!;
    const deed = (n: number) => {
      const d = { id: `d_x${n}`, actorId: me, summary: "임무 완수: 시험", tags: ["diligence" as const], severity: 1, at: w.state().time, witnesses: [], searched: false };
      w.ctx().store.append({ type: "deed_recorded", deed: d });
      return d;
    };
    expect(learn(w.ctx(), deed(1), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toBeNull();
    expect(learn(w.ctx(), deed(2), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toContain("오늘은 더 마음이 움직이지 않는다");
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: w.state().time + MINUTES_PER_DAY });
    const before = (w.state().relations[boss]?.[me] ?? NEUTRAL_RELATION).trust;
    expect(learn(w.ctx(), deed(3), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toBeNull();
    expect((w.state().relations[boss]?.[me] ?? NEUTRAL_RELATION).trust).toBe(before + 1);
  });

  it("이름을 묻는 선택지는 그 사람의 이름을 알게 한다 (계단 밑의 귓속말)", () => {
    const ask = content.storylets.tr_inn_whisper!.choices.find((c) => c.id === "ask_name")!;
    expect(ask.effects.some((e) => "reveal_name" in e && e.reveal_name.who === "victim")).toBe(true);
    const w = make("role_c_raider");
    const victim = Object.values(content.npcs).find((n) => n.name === "곽연옥")!.id;
    applyEffect(w.ctx(), { reveal_name: { who: "victim" } }, { victim }, {}, "테스트");
    expect(w.state().known[w.state().playerId] ?? []).toContain(victim);
  });

  it("섬: 흔한 물건을 조금 지니고 있어도 찾아오기 의뢰가 나오고, 지닌 것보다 많이 맡긴다", () => {
    let offered = 0;
    for (const roll of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const w = make("role_y_islander", roll);
      const s = w.state();
      for (const item of ["canned_food", "dried_fish", "water_bottle"]) if (content.items[item]) w.ctx().store.append({ type: "item_granted", to: s.playerId, itemId: item, quantity: 1 });
      const islanders = Object.values(content.npcs).filter((n) => whereIs(w.state(), content, n.id)?.zone === s.playerZone && n.id !== s.playerId).map((n) => n.id);
      for (const id of islanders) {
        const offer = makeOffer(w.state(), content, id, () => roll);
        if (!offer?.item) continue;
        offered++;
        const held = w.state().characters[s.playerId]!.inventory[offer.item.id] ?? 0;
        expect(offer.item.quantity).toBeGreaterThan(held);
      }
    }
    expect(offered).toBeGreaterThan(0);
  });
});

describe("PT28 뒤 고친 것 (12-301)", () => {
  it("지혈 스킬로 피 흘리는 사람을 판정하면 treatment가 없어도 그 판정대로 피를 멎게 한다", () => {
    const w = make("role_d_medic", 0.99);
    const s = w.state();
    const mate = Object.values(content.npcs).find((n) => n.faction === s.characters[s.playerId]!.factionId && !n.healer && whereIs(s, content, n.id)?.zone === s.playerZone)!.id;
    if (!s.scene.present.includes(mate)) w.ctx().store.append({ type: "npc_entered", npcId: mate });
    changeCondition(w.ctx(), mate, "bleeding", 1, "test", "테스트");
    expect(w.state().characters[mate]!.conditions.bleeding).not.toBe("none");
    const move = content.scenario.wounds!.staunch_move;
    const r = w.executeTool("take_action", { intent: "지혈한다", check: { move, stat: content.scenario.moves.find((m) => m.id === move)!.stats[0], difficulty: "normal", harm_on_failure: "none" }, activity: null, deed: null, target: mate, narration_summary: null, for_mission: false, ignore_story: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().characters[mate]!.conditions.bleeding).toBe("none");
  });

  it("쓰러진 주인공 곁의 우리 편이 감염체보다 많으면 그 감염체를 처리하고 돌본다", () => {
    const w = make("role_a_squad_leader");
    const s = w.state();
    const me = s.playerId;
    const template = Object.keys(content.extras).find((id) => content.extras[id]!.kind === "infected")!;
    const spawned = w.executeTool("spawn_extra", { template, label: "담 틈의 감염체" });
    expect(spawned.ok, spawned.ok ? "" : spawned.error).toBe(true);
    const infected = w.state().scene.present.find((id) => w.state().characters[id]?.extra?.template === template)!;
    for (const id of ["a_yejin", "a_haneul"]) if (!w.state().scene.present.includes(id)) w.ctx().store.append({ type: "npc_entered", npcId: id });
    changeCondition(w.ctx(), me, "harm", 5, "test", "테스트");
    const r = w.executeTool("take_action", { intent: "누워 있다", check: null, activity: { kind: "wait", until: null, hours: 1 }, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().characters[infected]!.dead).toBe(true);
    expect(r.ok && r.resultText).toContain("처리했다");
  });
});
