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
