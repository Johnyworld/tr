import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { buildCustomRole } from "../game/customStart.ts";
import { tiesOf } from "../game/ties.ts";
import { createSeededRng } from "../rng.ts";
import { castCandidates } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { onPersonDeath } from "./people.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const manager = (seed = 7) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-people-")), content, rngFactory: () => createSeededRng(seed) });

function spawn(w: ReturnType<ReturnType<typeof manager>["create"]>, template: string, label: string): string {
  const r = w.executeTool("spawn_extra", { template, label });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return w.state().scene.present.at(-1)!;
}

describe("인물 사이의 관계 (기획서 7.10)", () => {
  it("정해진 관계는 양쪽에서 보인다: 오지호와 붙잡힌 형 오정빈, 적대 무리에 갈라진 권무열·권예진 남매", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    const s = w.state();
    expect(tiesOf(s, w.content, "a_jiho").find((t) => t.other === "a_jeongbin")?.kind).toBe("sibling");
    expect(tiesOf(s, w.content, "a_jeongbin").find((t) => t.other === "a_jiho")?.kind).toBe("sibling");
    expect(tiesOf(s, w.content, "a_yejin").find((t) => t.other === "c_muyeol")?.secret).toBeTruthy();
    w.close();
  });

  it("세계를 만들 때 판마다 다른 관계가 생긴다. 정해진 관계가 있는 사람은 건드리지 않고, 무리가 다르면 숨은 관계다", () => {
    const a = manager(1).create("mcp", "role_a_grunt", choice);
    const b = manager(2).create("mcp", "role_a_grunt", choice);
    const ties = a.state().dynamicTies;
    expect(ties.length).toBeGreaterThan(0);
    expect(ties.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(ties)).not.toBe(JSON.stringify(b.state().dynamicTies));
    for (const t of ties) {
      expect(["a_jiho", "a_jeongbin", "c_muyeol", "a_yejin"]).not.toContain(t.a);
      const cross = a.content.npcs[t.a]!.faction !== a.content.npcs[t.b]!.faction;
      expect(!!t.secret).toBe(cross);
    }
    a.close();
    b.close();
  });

  it("숨은 관계는 신뢰가 쌓여야 GM에게 보이고, 털어놓으면 주인공이 안다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    w.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    expect(w.sceneForGm()).not.toContain("숨은 관계");
    expect(w.executeTool("reveal_tie", { npc_id: "a_jiho", other: "a_jeongbin" }).ok).toBe(false);
    w.ctx().store.append({ type: "relation_changed", from: "a_jiho", to: "player", delta: { trust: 3, affection: 0, respect: 0 }, reason: "test" });
    expect(w.sceneForGm()).toContain("털어놓을 수 있는 숨은 관계");
    const r = w.executeTool("reveal_tie", { npc_id: "a_jiho", other: "a_jeongbin" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const scene = w.sceneForGm();
    expect(scene).toContain("관계: 오정빈(a_jeongbin)의 형제자매");
    expect(scene).toContain("붙잡혀 있다");
    expect((w.state().beliefs.player ?? []).some((b) => b.fact.includes("오정빈"))).toBe(true);
    w.close();
  });

  it("이름 있는 인물이 죽으면 가족이 듣고, 주인공이 눈앞에서 죽였다면 미워한다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    w.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    onPersonDeath(w.ctx(), "a_jeongbin", "attack");
    expect((w.state().beliefs.a_jiho ?? []).some((b) => b.fact.includes("죽었다"))).toBe(true);
    expect(w.state().relations.a_jiho?.player?.trust).toBe(-3);
    w.close();
  });

  it("배역 tie: 앞 배역과 이어진 사람, cross면 무리가 다른 사람만", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    const role = { tie: { of: "a", cross: true }, commander: false, known: false, enter: true } as never;
    expect(castCandidates(w.state(), w.content, role, { a: "a_yejin" })).toEqual(["c_muyeol"]);
    // 오지호의 가족: 같은 무리의 형(오정빈)은 빠지고, 무리 밖의 어머니(두옥분)만
    expect(castCandidates(w.state(), w.content, role, { a: "a_jiho" })).toEqual(["lone_youngja"]);
    w.close();
  });
});

describe("자라는 인물 (기획서 7.10)", () => {
  it("깊이 엮인 이름 없는 인물은 틀의 재료로 프로필이 생기고, 이야기 배역 후보가 된다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    const id = spawn(w, "refugee", "떠돌이 피난민");
    expect(w.state().characters[id]!.profile).toBeNull();
    w.ctx().store.append({ type: "relation_changed", from: id, to: "player", delta: { trust: 2, affection: 2, respect: 0 }, reason: "test" });
    const r = w.executeTool("take_action", act("이야기를 나눈다"));
    expect(r.ok && r.resultText).toContain("그냥 스쳐 가는 사람이 아니다");
    const p = w.state().characters[id]!.profile!;
    expect(content.extras.refugee!.profile!.wants).toContain(p.want);
    const scene = w.sceneForGm();
    expect(scene).toContain("자란 인물");
    expect(scene).toContain(`원하는 것: ${p.want}`);
    expect(castCandidates(w.state(), w.content, { commander: false, known: false, enter: true } as never)).toContain(id);
    w.close();
  });

  it("GM이 이야기에 붙잡을 수 있다. 동물은 자라지 않는다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    const id = spawn(w, "b_guard", "버들마을 경비병");
    expect(w.executeTool("promote_extra", { target: id }).ok).toBe(true);
    expect(w.state().characters[id]!.profile).toBeTruthy();
    expect(w.executeTool("promote_extra", { target: id }).ok).toBe(false);
    const dog = spawn(w, "stray_dog", "누렁이");
    expect(w.executeTool("promote_extra", { target: dog }).ok).toBe(false);
    w.close();
  });

  it("연고로 시작한 가족은 처음부터 자란 인물이다", () => {
    const role = buildCustomRole(content, { faction: null, rank: "loner", title: "떠돌이", location: "old_town", kit: "wanderer", skills: { scavenge: 1 }, age: 30, opening: "o", background: [], kin: { template: "kin_elder", label: "아버지" } });
    const w = manager().create("mcp", undefined, choice, undefined, { role, background: [] });
    const [kin] = w.state().companions;
    expect(w.state().characters[kin!]!.profile).toBeTruthy();
    w.close();
  });
});

describe("상황에 맞는 등장", () => {
  it("엑스트라 틀 목록은 지금 여기서 마주칠 만한 것만: 우리 거점에는 떠돌이가 없고, 연고 틀은 나오지 않는다", () => {
    const w = manager().create("mcp", "role_a_grunt", choice);
    const atBase = w.sceneForGm();
    expect(atBase).not.toContain("drifter_young");
    expect(atBase).not.toContain("kin_young");
    w.executeTool("take_action", act("구시가로 간다", { move_to: "old_town" }));
    const outside = w.sceneForGm();
    expect(outside).toContain("drifter_young");
    expect(outside).not.toContain("kin_young");
    expect(outside).not.toContain("c_sentry_rifle");
    w.close();
  });
});
