import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletEffect } from "../content/schemas.ts";
import { ownOffense } from "../rules/consequence.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { applyEffect } from "./storyletTools.ts";
import { createTakeActionSchema, takeAction } from "./action.ts";

/** 설계 목록 C-2 규율·회의 (12-280). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-280-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_c_raider", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

function theft(w: ReturnType<typeof make>) {
  const mate = Object.values(content.npcs).find((n) => n.faction === "faction_c" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && n.id !== content.roles.role_c_raider!.commander)!.id;
  const s = w.state();
  w.ctx().store.append({ type: "deed_recorded", deed: { id: `d_${s.nextDeedNo}`, actorId: s.playerId, summary: "창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, at: s.time, witnesses: [{ npcId: mate, hidden: false }], searched: false } });
  w.ctx().store.append({ type: "item_granted", to: s.playerId, itemId: "canned_food", quantity: 2 });
  w.ctx().store.append({ type: "deed_settled", deedId: `d_${s.nextDeedNo}`, endedAt: s.time + 90, items: { canned_food: 2 } });
  return `d_${s.nextDeedNo}`;
}

describe("규율·회의 (12-280)", () => {
  it("회의는 짓이 끝난 때부터 한 시간 뒤, 크게 다쳤으면 미룬다 (2-1)", () => {
    const w = make();
    theft(w);
    const t = w.state().time;
    expect(ownOffense(w.state(), content, t + 120)).toBeNull(); // 끝난 때(+90)부터 30분
    expect(ownOffense(w.state(), content, t + 150)).not.toBeNull();
    changeCondition(w.ctx(), w.state().playerId, content.scenario.harm_track, 2, "test", "다침");
    expect(ownOffense(w.state(), content, t + 150)).toBeNull();
  });

  it("벌을 받아들이면 훔친 것을 돌려놓는다 (2-4)", () => {
    const w = make();
    const before = w.state().characters[w.state().playerId]!.inventory.canned_food ?? 0;
    const id = theft(w);
    const r = applyEffect(w.ctx(), { return_stolen: true } as StoryletEffect, {}, {}, "테스트");
    expect(r.line).toContain("돌려놓았다");
    expect(w.state().characters[w.state().playerId]!.inventory.canned_food ?? 0).toBe(before);
    expect(w.state().deeds[id]!.returned).toBe(true);
    const accept = content.storylets.disc_c_council!.choices.find((c) => c.id === "accept")!;
    expect(accept.effects.some((e) => "return_stolen" in e)).toBe(true);
  });
});

describe("규율 회의는 긴 행동이 끝난 때부터 (12-299, PT27 졸병)", () => {
  it("두 시간 걸린 도둑질이면 그 행동 끝에 회의가 열리지 않고, 짓에는 끝난 때가 적힌다", () => {
    const w = make();
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_c" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && n.id !== content.roles.role_c_raider!.commander)!.id;
    w.ctx().store.append({ type: "npc_entered", npcId: mate });
    const start = w.state().time;
    const input = createTakeActionSchema(content.scenario).parse({
      intent: "창고에서 통조림을 몰래 챙긴다",
      activity: { kind: "work", hours: 2 },
      deed: { summary: "창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "public", noisy: false, condition: "always" },
    });
    const r = takeAction(input, w.ctx());
    expect(r.ok).toBe(true);
    const s = w.state();
    const deed = Object.values(s.deeds).find((d) => d.summary === "창고에서 통조림을 훔쳤다")!;
    expect(deed.endedAt).toBeGreaterThanOrEqual(start + 120);
    const active = s.activeStorylet ? content.storylets[s.activeStorylet.id] : undefined;
    expect(active?.when.own_offense ?? false).toBe(false);
    if (deed.witnesses.length) expect(ownOffense(s, content, deed.endedAt! + 60)).not.toBeNull();
  });
});
