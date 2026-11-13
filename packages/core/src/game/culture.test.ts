import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { describeCultureForGm, disciplineOf } from "./culture.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));

/** 그 시나리오로 시작해 상관을 불러 오늘의 임무 하나를 받고 버린다 */
function abandonFirstMission(roleId: string) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-culture-")), content, rngFactory: () => createSeededRng(3) });
  const w = m.create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
  const commander = w.content.roles[roleId]!.commander!;
  expect(w.executeTool("npc_presence", { npc_id: commander, action: "enter" }).ok).toBe(true);
  const template = w.state().offers!.templateIds[0]!;
  expect(w.executeTool("assign_mission", { template_id: template }).ok).toBe(true);
  const before = w.state().characters.player!;
  const out = w.executeTool("abandon_mission", { reason: "하기 싫다" });
  const after = w.state().characters.player!;
  w.close();
  return { out, merit: after.merit - before.merit, disobedience: after.disobedience - before.disobedience };
}

describe("무리의 문화와 규율", () => {
  it("무리마다 규율이 다르다: 붉은연합 군율, 청솔·하얀매 질서, 버들마을 느슨함, 나루상단 자유", () => {
    expect(disciplineOf(content, "faction_c").id).toBe("strict");
    expect(disciplineOf(content, "faction_a").id).toBe("orderly");
    expect(disciplineOf(content, "faction_d").id).toBe("orderly");
    expect(disciplineOf(content, "faction_b").id).toBe("loose");
    expect(disciplineOf(content, "faction_e").id).toBe("free");
    expect(disciplineOf(content, "").id).toBe("orderly"); // 무소속·규율 없음은 기본값
  });

  it("임무를 버리면: 군율은 불복종에 공적 -3, 자유로운 무리는 불복종으로 치지 않고 공적도 그대로", () => {
    const red = abandonFirstMission("role_c_raider");
    expect(red).toMatchObject({ merit: -3, disobedience: 1 });
    const trader = abandonFirstMission("role_e_porter");
    expect(trader).toMatchObject({ merit: 0, disobedience: 0 });
    expect(trader.out.ok && trader.out.resultText).toContain("일감");
    const village = abandonFirstMission("role_b_guard");
    expect(village).toMatchObject({ merit: -1, disobedience: 0 });
  });

  it("GM은 소속 무리의 문화를 보고, 그 무리 사람은 ?세력에서 규칙을 본다", async () => {
    expect(describeCultureForGm(content, "faction_c")).toContain("규율: 군율");
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-culture-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_b_guard");
    expect(w.sceneForGm()).toContain("버들마을의 문화 (규율: 느슨함)");
    expect(await w.runCommand("?세력")).toContain("우물물은 집집이 순서대로 긷는다");
    w.close();
  });
});
