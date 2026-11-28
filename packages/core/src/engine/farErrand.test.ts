import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { dayOf, FAR_TRIP_MINUTES, MINUTES_PER_DAY, missionDeadline } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { outsideMission } from "./missionTools.ts";
import { heldInventory } from "../rules/bags.ts";

/** 먼 일은 하루 더 (12-362, 튜토리얼: 약 구하러 왕복 6시간을 당일치기로 다녀와야 했다) */
const content = loadRealContent();

function assign(template: string) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-far-")), content, rngFactory: () => createSeededRng(3) });
  const w = m.create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
  const commander = content.roles.role_a_grunt!.commander!;
  expect(w.executeTool("npc_presence", { npc_id: commander, action: "enter" }).ok).toBe(true);
  w.ctx().store.append({ type: "missions_offered", day: dayOf(w.state().time), templateIds: [template] });
  const at = w.state().time;
  const r = w.executeTool("assign_mission", { template_id: template });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  const mission = Object.values(w.state().missions).find((x) => x.templateId === template)!;
  return { at, deadline: mission.deadline, w, text: r.ok ? r.resultText : "" };
}

const dayEnd = (at: number, days: number) => at - (at % MINUTES_PER_DAY) + days * MINUTES_PER_DAY + 20 * 60;

describe("먼 일은 하루 더 (12-362)", () => {
  it("급하지 않은 일은 오가는 길이 4시간 이상이면 그다음 날 20시까지, 아니면 다음 날 20시", () => {
    const start = MINUTES_PER_DAY + 18 * 60;
    expect(missionDeadline(start, 12, false, 120, FAR_TRIP_MINUTES - 1)).toBe(dayEnd(start, 1));
    expect(missionDeadline(start, 12, false, 120, FAR_TRIP_MINUTES)).toBe(dayEnd(start, 2));
  });

  it("급한 일은 먼 일이어도 하루를 더 주지 않는다", () => {
    const start = MINUTES_PER_DAY + 8 * 60;
    expect(missionDeadline(start, 4, true, 120, 600)).toBe(missionDeadline(start, 4, true, 120, 0));
  });

  it("청솔 거점에서 약 구하러 나가기는 약이 나는 가장 가까운 구시가가 두 칸이라 (왕복 4시간으로 센다) 모레 20시까지다", () => {
    const { at, deadline } = assign("occ_medic_pharmacy");
    expect(deadline).toBe(dayEnd(at, 2));
  });

  it("구해 올 것이 없는 담 안 일은 그대로 다음 날 20시까지다", () => {
    const { at, deadline } = assign("occ_guard_gate");
    expect(deadline).toBe(dayEnd(at, 1));
  });

  it("담 밖 일: 바깥·근처·적 땅·거점이 아닌 구역은 바깥, 우리 거점 안 일은 아니다 (12-363)", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-out-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
    const s = w.state();
    expect(outsideMission(s, content, "outside")).toBe(true);
    expect(outsideMission(s, content, "old_town")).toBe(true);
    expect(outsideMission(s, content, "a_base")).toBe(false);
    expect(outsideMission(s, content, null)).toBe(false);
  });

  it("바깥 일을 받으면 무리가 지니지 않은 채비만 챙겨 주고, 물은 무리 창고에서 빠진다 (12-365)", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-kit-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
    const me = w.state().playerId;
    // 먹을 것·물은 다 내려놓고, 손전등은 지닌 채로
    for (const [id, n] of Object.entries(w.state().characters[me]!.inventory)) {
      const it = content.items[id];
      if (n > 0 && (it?.kind === "food" || it?.resource)) w.ctx().store.append({ type: "item_consumed", holder: me, itemId: id, quantity: n });
    }
    if (!w.state().characters[me]!.inventory.flashlight) w.ctx().store.append({ type: "item_granted", to: me, itemId: "flashlight", quantity: 1 });
    const water = w.state().factions.faction_a!.resources.water!;
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: dayOf(w.state().time), templateIds: ["occ_medic_pharmacy"] });
    const r = w.executeTool("assign_mission", { template_id: "occ_medic_pharmacy" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resultText).toContain("채비");
    const inv = heldInventory(w.state(), me);
    expect(inv.water_bottle).toBe(1);
    expect(inv.dry_ration).toBe(1);
    expect(inv.flashlight).toBe(1);
    expect(w.state().factions.faction_a!.resources.water).toBe(water - 1);
  });

  it("담 안 일은 채비를 주지 않는다", () => {
    const { text } = assign("occ_guard_gate");
    expect(text).not.toContain("채비");
  });

  it("바깥 일을 보고하면 상관의 반응에 세계와 무리의 '바깥 일을 대하는 마음'이 붙는다 (12-364)", () => {
    const { w } = assign("occ_medic_pharmacy");
    const r = w.executeTool("report_mission", { final: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) {
      expect(r.resultText).toContain("꾸짖지 않는다");
      expect(r.resultText).toContain(content.scenario.outside_regard!);
      expect(r.resultText).toContain(content.factions.faction_a!.culture!.outside_regard!);
    }
  });
});
