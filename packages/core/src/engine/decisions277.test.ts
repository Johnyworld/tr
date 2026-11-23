import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helperFor } from "../rules/company.ts";
import { reduceHarm } from "../rules/damage.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { oppositionParts } from "./opposition.ts";

/** 설계 목록 C-4 판정·도움·전투 (12-277). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (roleId = "role_a_squad_leader") =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-277-")), content, rngFactory: () => () => 0.99 }).create("mcp", roleId, { name: "도윤", gender: "male", abilities: null, portrait: null, traits: [] } as never);
const spawn = (w: ReturnType<typeof make>, template: string, label: string) => {
  const r = w.executeTool("spawn_extra", { template, label });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return w.state().scene.present.at(-1)!;
};

describe("판정·도움·전투 (12-277)", () => {
  it("수에 밀림은 함께 싸우는 내 편 수만큼 덜어 낸다 (4-1)", () => {
    const w = make();
    const foes = [spawn(w, "infected_hungry", "감염체 하나"), spawn(w, "infected_hungry", "감염체 둘"), spawn(w, "infected_hungry", "감염체 셋")];
    const alone = oppositionParts(content, w.state(), "fight", foes[0]!, null, []);
    expect(alone.some((p) => p.label.startsWith("감염체") && p.value < 0)).toBe(true);
    // 분대원 넷을 장면에 들여 함께 싸우면 벌점이 없다
    const squad = (content.roles.role_a_squad_leader!.squad ?? []).slice(0, 4);
    for (const id of squad) if (!w.state().scene.present.includes(id)) w.executeTool("npc_presence", { npc_id: id, action: "enter" });
    const together = oppositionParts(content, w.state(), "fight", foes[0]!, null, squad);
    expect(together.some((p) => p.label.startsWith("감염체") && p.value < 0)).toBe(false);
  });

  it("돕는 사람은 그 일을 함께하는 사람만, 몰래 하는 일은 시킨 사람만 (4-1)", () => {
    const w = make();
    const squad = content.roles.role_a_squad_leader!.squad ?? [];
    const one = squad[0]!;
    w.executeTool("npc_presence", { npc_id: one, action: "enter" });
    // 장면에 있기만 하고 with도 동행도 아니면 돕지 않는다
    expect(helperFor(w.state(), content, "fight", [])).toBeNull();
    expect(helperFor(w.state(), content, "fight", [one])?.id).toBe(one);
  });

  it("막아서기는 몫을 밝힌다 (4-2)", () => {
    const w = make();
    const squad = content.roles.role_a_squad_leader!.squad ?? [];
    w.executeTool("npc_presence", { npc_id: squad[0]!, action: "enter" });
    w.executeTool("companion_follow", { target: squad[0]! });
    const r = reduceHarm(w.ctx(), { who: w.state().playerId, raw: 4, attack: false, shareable: true, cause: "test", track: "harm", hurt: () => null });
    const line = r.lines.find((l) => l.includes("막아서다"));
    expect(line, r.lines.join(" | ")).toBeDefined();
    expect(line).toMatch(/원래 \d단계였는데 당신은 \d단계만/);
  });
});
