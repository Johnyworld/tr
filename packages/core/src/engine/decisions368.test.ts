import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { currentPlace } from "../rules/place.ts";
import { passLine } from "../rules/admission.ts";
import { neighbors } from "../sim/war.ts";
import { describePlayerState } from "./context.ts";

/** 12-368 함께 걷던 사람 (유소진 판: 두 번 함께 걸은 하늘을 with를 빠뜨려 구시가에 두고 떠났다) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-368-")), content, rngFactory: () => createSeededRng(5) });
  return m.create("mcp", "role_a_grunt", choice);
}
const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("함께 걷던 사람 (12-368)", () => {
  it("바로 앞 이동에 함께 온 사람은 with나 leave로 정해야 옮긴다", () => {
    const w = world();
    const mate = "a_jiho";
    const r0 = w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    expect(r0.ok, r0.ok ? "" : r0.error).toBe(true);
    const here = currentPlace(w.state(), content)!;
    const next = here.near[0]!;
    const r1 = w.executeTool("take_action", act({ place_to: next, with: [mate] }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    expect(w.state().walkingWith).toEqual([mate]);

    // with를 빠뜨리면 거절 (시간은 흐르지 않는다)
    const time = w.state().time;
    const r2 = w.executeTool("take_action", act({ place_to: here.id }));
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.error).toContain("leave");
    expect(w.state().time).toBe(time);
    expect(w.state().scene.present).toContain(mate);

    // 두고 가기로 하면 옮기고, 그 사람은 남는다
    const r3 = w.executeTool("take_action", act({ place_to: here.id, leave: [mate] }));
    expect(r3.ok, r3.ok ? "" : r3.error).toBe(true);
    expect(w.state().scene.present).not.toContain(mate);
    expect(w.state().walkingWith).toEqual([]);

    // 이미 두고 온 사람은 다시 묻지 않는다
    const r4 = w.executeTool("take_action", act({ place_to: next }));
    expect(r4.ok, r4.ok ? "" : r4.error).toBe(true);
  });

  it("함께 걷던 사람이 스스로 자리를 뜨면 묻지 않는다", () => {
    const w = world();
    const mate = "a_jiho";
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const here = currentPlace(w.state(), content)!;
    const next = here.near[0]!;
    expect(w.executeTool("take_action", act({ place_to: next, with: [mate] })).ok).toBe(true);
    expect(w.executeTool("npc_presence", { npc_id: mate, action: "leave" }).ok).toBe(true);
    const r = w.executeTool("take_action", act({ place_to: here.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("우리 거점에서는 묻지 않고 드나든다는 줄이 상태에 나온다 (출입 허락을 지어내지 않게)", () => {
    const w = world();
    expect(passLine(w.state(), content)).toContain("묻지 않고 드나든다");
    expect(describePlayerState(w.state(), content)).toContain("묻지 않고 드나든다");
    const away = neighbors(content, w.state().playerZone!).find((z) => content.locations[z]?.kind !== "base")!;
    const r = w.executeTool("take_action", act({ move_to: away }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (w.state().playerZone === away) expect(passLine(w.state(), content)).toBeNull();
  });

  it("임무를 보고하면 임무로 함께 걷던 사람은 더 따라다니지 않는다 (12-369)", () => {
    const w = world();
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const tid = w.state().offers!.templateIds[0]!;
    expect(w.executeTool("assign_mission", { template_id: tid }).ok).toBe(true);
    const mate = "a_jiho";
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const here = currentPlace(w.state(), content)!;
    const r1 = w.executeTool("take_action", act({ place_to: here.near[0]!, with: [mate, commander] }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    const r2 = w.executeTool("report_mission", { final: true });
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    expect(r2.ok && r2.resultText).toContain("이제 따라다니지 않는다");
    expect(w.state().walkingWith).toEqual([]);
    // 다음 이동은 묻지 않는다 (with에 넣지 않으면 그 자리가 제자리가 아닌 한 남는다)
    const r3 = w.executeTool("take_action", act({ place_to: here.id }));
    expect(r3.ok, r3.ok ? "" : r3.error).toBe(true);
  });

  it("짝 없는 임무 중에 장면의 같은 무리 사람을 짝으로 청하면 동행이 되고, 보고하면 돌아간다 (12-370)", () => {
    const w = world();
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const tid = w.state().offers!.templateIds.find((id) => !content.missions[id]?.buddy)!;
    expect(w.executeTool("assign_mission", { template_id: tid }).ok).toBe(true);
    expect(Object.values(w.state().bonds).some((b) => b.kind === "buddy")).toBe(false);
    const me = w.state().characters[w.state().playerId]!;
    // 계급이 달라도 청할 수 있다 (길잡이)
    const mate = Object.values(w.state().characters).find((c) => content.npcs[c.id] && c.factionId === me.factionId && c.id !== commander && c.id !== me.id && (w.state().known[me.id] ?? []).includes(c.id) && !c.dead)!.id;
    // 장면에 없으면 거절
    expect(w.executeTool("pair_up", { target: mate, accept: true }).ok).toBe(false);
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    // 임무를 준 사람은 짝이 아니다
    expect(w.executeTool("pair_up", { target: commander, accept: true }).ok).toBe(false);
    const r = w.executeTool("pair_up", { target: mate, accept: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().companions).toContain(mate);
    const rep = w.executeTool("report_mission", { final: true });
    expect(rep.ok, rep.ok ? "" : rep.error).toBe(true);
    expect(w.state().companions).not.toContain(mate);
  });
});
