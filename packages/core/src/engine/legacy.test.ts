import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { castCandidates, storyletVars } from "../story/storylets.ts";
import { mournedBy } from "./legacy.ts";

/** 유품과 이어지는 끈 (12-158) */
const content = { ...loadRealContent(), storylets: {} };
const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-legacy-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
type World = ReturnType<typeof make>;
const me = (w: World) => w.state().characters[w.state().playerId]!;

/** 짐을 맡기고 동료 하나와 가까워진 뒤 죽는다 */
function setup(affection: number) {
  const w = make();
  const first = me(w).id;
  const friend = (w.state().known[first] ?? []).find((id) => content.npcs[id] && !w.state().characters[id]?.dead)!;
  expect(friend).toBeTruthy();
  expect(w.runCheat("~give canned_food 2").ok).toBe(true);
  expect(w.executeTool("stash", { action: "put", items: [{ item_id: "canned_food", quantity: 2 }] }).ok).toBe(true);
  if (affection) expect(w.runCheat(`~relation ${friend} affection +${affection}`).ok).toBe(true);
  expect(w.runCheat("~kill me").ok).toBe(true);
  return { w, first, friend };
}

describe("유품과 이어지는 끈", () => {
  it("가까운 사람이 뒤를 이으면 앞사람의 사물함 짐을 물려받는다", () => {
    const { w, first, friend } = setup(4);
    const zone = Object.keys(w.state().stashes[first] ?? {})[0]!;
    const r = w.chooseNextCharacter(friend);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().stashes[first]).toBeUndefined();
    expect(w.state().stashes[friend]?.[zone]?.canned_food).toBe(2);
    if (r.ok) expect(r.text).toContain("몫이 됐다");
  });

  it("가깝지 않은 사람이 이으면 짐은 그대로 남는다", () => {
    const { w, first, friend } = setup(0);
    expect(w.chooseNextCharacter(friend).ok).toBe(true);
    expect(Object.keys(w.state().stashes[first] ?? {}).length).toBe(1);
    expect(w.state().stashes[friend]).toBeUndefined();
  });

  it("앞사람과 가까웠던 사람은 그를 기억하는 배역이 되고, {departed}가 그를 가리킨다", () => {
    const { w, first, friend } = setup(4);
    const fresh = w.successionOptions().find((o) => o.id.startsWith("new:"));
    expect(fresh).toBeTruthy();
    expect(w.chooseNextCharacter(fresh!.id).ok).toBe(true);
    const s = w.state();
    expect(mournedBy(s, content, friend)).toEqual([first]);
    const role = { mourner: true } as Parameters<typeof castCandidates>[2];
    expect(castCandidates(s, content, role)).toContain(friend);
    expect(storyletVars(s, content, { friend }).departed).toBeTruthy();
  });
});

describe("장례 (12-163)", () => {
  it("사흘 안에 죽은 우리 무리 사람이 있으면 장례 이야기가 열리고, 가까웠던 사람이 남은 사람이 된다", async () => {
    const full = loadRealContent();
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-funeral-")), content: full, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
    const { conditionsMet } = await import("../story/storylets.ts");
    const rites = full.storylets.fn_rites!;
    const s0 = w.state();
    const comrades = Object.values(s0.characters).filter((c) => c.id !== s0.playerId && full.npcs[c.id] && c.factionId === me(w).factionId && !c.dead);
    const [dead, friend] = [comrades[0]!.id, comrades[1]!.id];
    expect(w.runCheat("~time day").ok).toBe(true);
    expect(conditionsMet(w.state(), full, rites, w.state().time)).toBe(false);
    w.ctx().store.append({ type: "relation_changed", from: friend, to: dead, delta: { trust: 0, affection: 4, respect: 0 }, reason: "테스트" });
    expect(w.runCheat(`~kill ${dead}`).ok).toBe(true);
    // 유해는 도구 실행 전후로 남는다 (치트는 도구 밖이라 직접 남긴다)
    w.ctx().store.append({ type: "remains_left", remains: { of: dead, holder: `remains_${dead}`, zone: w.state().playerZone!, diedAt: w.state().time, buriedAt: null, marker: null } });
    const s = w.state();
    expect(conditionsMet(s, full, rites, s.time)).toBe(true);
    const role = { bereaved: true } as Parameters<typeof castCandidates>[2];
    expect(castCandidates(s, full, role)).toContain(friend);
    expect(storyletVars(s, full, {}).deceased).toBeTruthy();
    // 나흘이 지나면 닫힌다
    expect(w.runCheat("~time +4d").ok).toBe(true);
    expect(conditionsMet(w.state(), full, rites, w.state().time)).toBe(false);
  });
});
