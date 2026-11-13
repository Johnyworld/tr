import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { buildCustomRole } from "../game/customStart.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";

/**
 * 플레이테스트에서 가 보지 못한 길 (실제 콘텐츠로):
 * 무소속이 무리에 들어가기, 뛰어난 사람의 스카우트, 동행·빚을 지닌 채 죽은 뒤의 계승
 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-paths-")), content, rngFactory: () => createSeededRng(5) });
const choice = { name: "도경", gender: "male" as const, abilities: null, portrait: null, traits: [] };

function loner() {
  const role = buildCustomRole(content, {
    faction: null,
    rank: "loner",
    title: "구시가의 떠돌이 수리공",
    location: "old_town",
    kit: "wanderer",
    skills: { scavenge: 1 },
    age: 33,
    opening: "아침, 무너진 상가 골목.",
    background: [],
  });
  return manager().create("mcp", undefined, choice, undefined, { role, background: [] });
}

function cheat(w: ReturnType<typeof loner>, input: string) {
  const r = w.runCheat(input);
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
}

describe("무소속이 무리에 들어간다", () => {
  it("붉은연합 조에 들어가면 상관·임무·배급이 생기고, 그 무리의 문화가 장면에 나온다", () => {
    const w = loner();
    expect(w.state().characters.player!.factionId).toBe("");
    cheat(w, "~storylet wl_red_toll");
    const r = w.executeTool("resolve_storylet", { choice_id: "join_red" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const player = w.state().characters.player!;
    expect(player.factionId).toBe("faction_c");
    const role = w.content.roles[w.state().roleId]!;
    expect(role.commander).toBeTruthy();
    expect(w.sceneForGm()).toContain("붉은연합의 문화 (규율: 군율)");
    // 상관(이야기에 나온 약탈조장)이 장면에 있다. 다음 행동부터 그날의 임무를 받을 수 있다
    expect(w.state().scene.present).toContain(role.commander);
    expect(w.executeTool("take_action", act("조장 옆에 선다")).ok).toBe(true);
    const offer = w.state().offers?.templateIds[0];
    expect(offer).toBeTruthy();
    expect(w.executeTool("assign_mission", { template_id: offer! }).ok).toBe(true);
    w.close();
  });

  it("들어간 뒤 죽으면 새 캐릭터도 그 무리 사람으로 이어 가고, 같은 무리 동료로 이어 갈 수도 있다", () => {
    const w = loner();
    cheat(w, "~storylet wl_red_toll");
    w.executeTool("resolve_storylet", { choice_id: "join_red" });
    cheat(w, "~kill me");
    const r = w.chooseNextCharacter("new", "후임");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const heir = w.state().characters[w.state().playerId]!;
    expect(heir.factionId).toBe("faction_c");
    w.close();
  });
});

describe("다른 무리의 스카우트", () => {
  it("버들마을 경비병이 청솔형제단으로 옮기면 분대장이 되고, 옛 상관의 신뢰를 잃는다", () => {
    const w = manager().create("mcp", "role_b_guard", choice);
    const oldCommander = w.content.roles.role_b_guard!.commander!;
    const trustBefore = w.state().relations[oldCommander]?.player?.trust ?? 0;
    cheat(w, "~storylet ws_pine_scout");
    const r = w.executeTool("resolve_storylet", { choice_id: "move" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const player = w.state().characters.player!;
    expect(player).toMatchObject({ factionId: "faction_a", rank: "squad_leader" });
    expect(w.state().relations[oldCommander]?.player?.trust ?? 0).toBeLessThan(trustBefore);
    expect(Object.values(w.state().deeds).some((d) => d.actorId === "player" && d.tags.includes("betrayal"))).toBe(true);
    // 옮긴 뒤에도 며칠을 멈추지 않고 지낸다
    for (let i = 0; i < 3; i++) {
      const s = w.executeTool("take_action", act("잔다", { activity: { kind: "sleep", until: "morning" } }));
      expect(s.ok, s.ok ? "" : s.error).toBe(true);
    }
    w.close();
  });
});

describe("동행과 빚을 지닌 채 죽은 뒤", () => {
  it("동행은 죽은 사람을 따라다녔지 다음 캐릭터를 따라오지 않고, 빚은 다음 캐릭터에게 넘어가지 않는다", () => {
    const w = manager().create("mcp", "role_e_porter", choice);
    expect(w.state().characters.player!.debts.faction_e).toBe(12);
    w.executeTool("spawn_extra", { template: "stray_dog", label: "누렁이" });
    const dog = w.state().scene.present.find((id) => w.state().characters[id]?.extra?.template === "stray_dog")!;
    w.ctx().store.append({ type: "companion_joined", characterId: dog });
    expect(w.state().companions).toContain(dog);
    cheat(w, "~kill me");
    const options = w.chronicleText();
    expect(options).toBeTruthy();
    const heirId = Object.values(w.content.npcs).find((n) => n.playable && n.faction === "faction_e" && w.state().known.player?.includes(n.id))?.id;
    const r = w.chooseNextCharacter(heirId ?? "new", null);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().companions).toEqual([]);
    const heir = w.state().characters[w.state().playerId]!;
    expect(heir.debts.faction_e ?? 0).toBeLessThan(12);
    expect(w.sceneForGm()).not.toContain("동행 (");
    w.close();
  });

  it("새 캐릭터는 시작 역할의 빚을 새로 진다 (그 자리에 오는 사람의 사정)", () => {
    const w = manager().create("mcp", "role_e_porter", choice);
    cheat(w, "~kill me");
    expect(w.chooseNextCharacter("new", "새 짐꾼").ok).toBe(true);
    expect(w.state().characters[w.state().playerId]!.debts.faction_e).toBe(12);
    w.close();
  });

  it("동행으로 다니던 사람이 다음 캐릭터가 되면, 자기 자신을 동행으로 두지 않는다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    w.ctx().store.append({ type: "companion_joined", characterId: "a_jiho" });
    cheat(w, "~kill me");
    expect(w.chooseNextCharacter("a_jiho", null).ok).toBe(true);
    expect(w.state().companions).not.toContain("a_jiho");
    w.close();
  });
});
