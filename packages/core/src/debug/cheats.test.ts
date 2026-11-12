import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

function world() {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.growth = { first: 10, step: 5, xp: { success: 1, partial: 1, miss: 2, merit: 2 }, daily_check_cap: 6 };
  for (const f of Object.values(c.factions)) f.aggression = 0;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-cheat-")), content: c, rngFactory: () => createSeededRng(4) });
  return { m, w: m.create("web") };
}

describe("치트", () => {
  it("능력·스킬·트레잇·아이템·경험치를 바꾸고, 세이브에 치트 표시가 남는다", () => {
    const { m, w } = world();
    const p = () => w.state().characters.player!;
    expect(w.runCheat("~stat strength 3").ok).toBe(true);
    expect(w.runCheat("~skill shoot 2").ok).toBe(false); // 시나리오에 없는 스킬
    expect(w.runCheat("~skill fight 2").ok).toBe(true);
    expect(w.runCheat("~trait add coward").ok).toBe(true);
    expect(w.runCheat("~give bomb 2").ok).toBe(true);
    expect(w.runCheat("~xp 12").ok).toBe(true);
    expect(p()).toMatchObject({ stats: { strength: 3 }, skills: { fight: 2 }, traits: ["coward"], inventory: { bomb: 2 }, xp: 12, level: 1, skillPoints: 1 });
    expect(w.state().cheated).toBe(true);
    w.close();
    expect(m.listSlots()[0]!.cheated).toBe(true);
  });

  it("몸 상태를 정하고 낫게 하고, 내 캐릭터를 죽이면 연대기가 남는다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    expect(w.state().characters.player!.conditions.harm).toBe("serious");
    expect(w.runCheat("~heal").ok).toBe(true);
    expect(w.state().characters.player!.conditions.harm).toBe("none");
    expect(w.runCheat("~kill me").ok).toBe(true);
    expect(w.isPlayerDead()).toBe(true);
    expect(w.state().chronicle).toHaveLength(1);
  });

  it("인물 부르기·죽이기, 엑스트라, 관계, 시간, 이동, 세력", () => {
    const { w } = world();
    expect(w.runCheat("~summon 강분대").ok).toBe(true);
    expect(w.state().scene.present).toContain("npc_leader");
    expect(w.runCheat("~relation 강분대 trust 2").ok).toBe(true);
    expect(w.state().relations.npc_leader?.player?.trust).toBe(2);
    expect(w.runCheat("~kill 강분대").ok).toBe(true);
    expect(w.state().characters.npc_leader!.dead).toBe(true);
    expect(w.runCheat("~summon extra test_sentry 보초").ok).toBe(true);
    expect(w.state().characters.ex_1).toBeDefined();
    const t = w.state().time;
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(w.state().time).toBe(t + 24 * 60);
    expect(w.runCheat("~goto a_post").ok).toBe(true);
    expect(w.state().playerZone).toBe("a_post");
    expect(w.runCheat("~faction faction_a food 0").ok).toBe(true);
    expect(w.state().factions.faction_a!.resources.food).toBe(0);
    expect(w.runCheat("~faction faction_a morale -2").ok).toBe(true);
    expect(w.state().factions.faction_a!.morale).toBe(-2);
  });

  it("모르는 명령·잘못된 인자는 상태를 바꾸지 않고 치트 표시도 남기지 않는다. ~help는 목록", () => {
    const { w } = world();
    expect(w.runCheat("~fly").ok).toBe(false);
    expect(w.runCheat("~give nothing").ok).toBe(false);
    const help = w.runCheat("~help");
    expect(help.ok && help.text).toContain("~kill");
    expect(w.state().cheated).toBe(false);
  });
});
