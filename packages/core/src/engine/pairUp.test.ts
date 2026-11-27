import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { neighbors } from "../sim/war.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { runCompanions } from "./companionTools.ts";

/** 임무 없이 거점을 나설 때 짝을 붙일지 묻는다 (2인 1조, 12-351) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const ROLE = "role_a_grunt";

function world() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pair-")), content, rngFactory: () => createSeededRng(5) });
  return m.create("mcp", ROLE, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "나선다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

/** 같은 무리 동료가 모두 다른 일(동행)로 곁에 묶여 있어 여유 인원이 없게 한다 */
function occupyMates(w: ReturnType<typeof world>) {
  const s = w.state();
  const me = s.characters[s.playerId]!;
  for (const c of Object.values(s.characters)) {
    if (content.npcs[c.id] && c.id !== me.id && c.factionId === me.factionId) w.ctx().store.append({ type: "companion_joined", characterId: c.id, kind: "purpose" });
  }
}

/** 거점에서 바깥 구역으로 나선다 */
function leave(w: ReturnType<typeof world>) {
  const here = w.state().playerZone!;
  const out = neighbors(content, here).find((z) => content.locations[z]?.kind === "zone")!;
  return w.executeTool("take_action", act({ move_to: out }));
}

const textOf = (r: unknown) => JSON.stringify(r);

describe("2인 1조: 임무 없이 거점을 나설 때", () => {
  it("여유 인원이 없으면 없다고 알리고 혼자 나선다", () => {
    const w = world();
    occupyMates(w);
    const r = leave(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(textOf(r)).toContain("짝 제안 불가");
    expect(textOf(r)).toContain("여유 인원이 없어");
    expect(Object.values(w.state().bonds).filter((b) => b.kind === "buddy")).toEqual([]);
  });

  it("여유 인원이 있으면 제안하고, 받으면 거점에 돌아올 때까지 함께 다닌다", () => {
    const w = world();
    const r = leave(w);
    expect(r.ok).toBe(true);
    const offered = /pair_up \{target: \\?"([^"\\]+)/.exec(textOf(r))?.[1];
    expect(offered, textOf(r)).toBeDefined();
    expect(w.state().bonds[offered!]).toBeUndefined(); // 묻기 전에는 붙지 않는다

    const home = w.state().characters[w.state().playerId]!.factionId;
    const yes = w.executeTool("pair_up", { target: offered!, accept: true });
    expect(yes.ok, yes.ok ? "" : yes.error).toBe(true);
    expect(w.state().bonds[offered!]).toMatchObject({ kind: "buddy" });
    expect(w.state().companions).toContain(offered);
    expect(home).toBeTruthy();

    // 거점 밖에서는 계속 함께 다닌다
    runCompanions(w.ctx());
    expect(w.state().companions).toContain(offered);

    // 거점으로 돌아오면 자기 자리로 돌아간다
    const baseZone = w.state().bonds[offered!]!.until!.zone!;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseZone });
    runCompanions(w.ctx());
    expect(w.state().companions).not.toContain(offered);
    expect(w.state().bonds[offered!]).toBeUndefined();
  });

  it("거절하면 혼자 가고, 아무 불이익도 없다", () => {
    const w = world();
    const r = leave(w);
    const offered = /pair_up \{target: \\?"([^"\\]+)/.exec(textOf(r))![1]!;
    const before = w.state().characters[w.state().playerId]!;
    const no = w.executeTool("pair_up", { target: offered, accept: false });
    expect(no.ok).toBe(true);
    expect(w.state().bonds[offered]).toBeUndefined();
    const after = w.state().characters[w.state().playerId]!;
    expect(after.merit).toBe(before.merit);
    expect(after.disobedience).toBe(before.disobedience);
  });

  it("제안에 없던 사람은 붙일 수 없다", () => {
    const w = world();
    leave(w);
    const r = w.executeTool("pair_up", { target: "nobody", accept: true });
    expect(r.ok).toBe(false);
  });

  it("임무를 받았으면 묻지 않는다", () => {
    const w = world();
    const commander = w.content.roles[ROLE]!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["wall_repair"] });
    expect(w.executeTool("assign_mission", { template_id: "wall_repair" }).ok).toBe(true);
    expect(textOf(leave(w))).not.toContain("짝 제안");
  });

  it("거점 밖에서 다른 구역으로 옮길 때는 다시 묻지 않는다", () => {
    const w = world();
    leave(w);
    const here = w.state().playerZone!;
    const next = neighbors(content, here).find((z) => content.locations[z]?.kind === "zone" && z !== here);
    if (!next) return;
    expect(textOf(w.executeTool("take_action", act({ move_to: next })))).not.toContain("짝 제안");
  });

  it("짝을 붙이는 임무인데 여유 인원이 없으면 임무 배정 결과가 그렇게 알린다", () => {
    const w = world();
    occupyMates(w);
    const commander = w.content.roles[ROLE]!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["front_recon"] });
    const r = w.executeTool("assign_mission", { template_id: "front_recon" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(textOf(r)).toContain("여유 인원이 없어 혼자 나선다");
  });
});
