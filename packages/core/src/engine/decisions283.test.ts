import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletEffect } from "../content/schemas.ts";
import { knowsPlace, peopleAt, unknownDoors, whereIs } from "../rules/place.ts";
import { moveOf } from "../scenario/scenario.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { applyEffect } from "./storyletTools.ts";

/** 설계 목록 C-1 잠입 2단계 (12-283): 단편 정보, 몰래 붙잡아 묻기, 그 뒤 처리. 실제 콘텐츠로 본다 */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-283-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
type W = ReturnType<typeof make>;
const inf = (w: W, action: string, extra: Record<string, unknown> = {}) => w.executeTool("infiltrate", { action, goal: null, place: null, target: null, ...extra });
const doorOf = (w: W, id: string) => `문${unknownDoors(w.state(), content).findIndex((p) => p.id === id) + 1}`;
const captiveOf = (w: W) => Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c" && c.captive.zone === "c_warehouse")!.id;
const move = content.scenario.captivity!.interrogate_moves[0]!;
const ask = (w: W, target: string, action: string, extra: Record<string, unknown> = {}) =>
  w.executeTool("handle_prisoner", { target, action, approach: action === "interrogate" ? move : null, stat: action === "interrogate" ? moveOf(content.scenario, move)!.stats[0] : null, against_setting: null, ...extra });

/** 마당에서 잠입을 시작해, 혼자 있는 사람이 있는 담 안 장소로 숨어든다 (시간을 넘겨 가며 찾는다) */
function sneakToLoner(w: W): string {
  w.runCheat("~goto c_warehouse");
  w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "yard" });
  for (let i = 0; i < 12; i++) {
    const s = w.state();
    const spot = unknownDoors(s, content).find((p) => peopleAt(s, content, "c_warehouse", p.id).filter((id) => !s.characters[id]?.captive).length === 1);
    if (spot) {
      expect(inf(w, "start", { goal: "steal" }).ok).toBe(true);
      inf(w, "advance", { place: doorOf(w, spot.id) });
      expect(w.state().playerPlace).toBe(spot.id);
      const t = w.state();
      return [...t.scene.present, ...peopleAt(t, content, "c_warehouse", spot.id)].find((id) => !t.characters[id]?.captive && !t.companions.includes(id))!;
    }
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + 120 });
  }
  throw new Error("혼자 있는 사람을 찾지 못했다");
}

describe("잠입 2단계 (12-283)", () => {
  it("상관에게 들은 소식은 갇힌 곳의 어림 단편을 붙인다 (이름·id 없이)", () => {
    const w = make();
    const captive = captiveOf(w);
    const r = applyEffect(w.ctx(), { locate: { who: "lost", source: "report" } } as StoryletEffect, { lost: captive }, {}, "테스트");
    expect(r.line).toContain("갇힌 곳은");
    expect(r.line).toContain("건물 안");
    expect(r.line).not.toContain("stockade");
    expect(r.line).not.toContain("수용소");
    expect(knowsPlace(w.state(), content, "c_warehouse", "stockade")).toBe(false);
  });

  it("혼자 있는 사람을 몰래 붙잡아 묻으면 갇힌 곳을 정확히 알고, 죽이면 코드가 죽음을 정하고 무거운 행적이 남는다", () => {
    const w = make();
    const who = sneakToLoner(w);
    const grabbed = inf(w, "grab", { target: who });
    expect(grabbed.ok ? grabbed.resultText : grabbed.error).toContain("붙잡아");
    expect(w.state().companions).toContain(who);
    const said = ask(w, who, "interrogate");
    expect(said.ok && said.resultText).toContain("털어놓은 것");
    const jail = whereIs(w.state(), content, captiveOf(w))!.place!;
    expect(knowsPlace(w.state(), content, "c_warehouse", jail)).toBe(true);
    const deeds = Object.keys(w.state().deeds).length;
    expect(ask(w, who, "kill").ok).toBe(true);
    expect(w.state().characters[who]!.dead).toBe(true);
    expect(Object.keys(w.state().deeds).length).toBe(deeds + 1);
  });

  it("기절시켜 두면 얼굴을 본 사람으로 남고, 잠입 중에 놓아주면 곧장 알린다", () => {
    const w = make();
    const who = sneakToLoner(w);
    inf(w, "grab", { target: who });
    expect(ask(w, who, "knock_out").ok).toBe(true);
    expect(w.state().companions).not.toContain(who);
    const deed = Object.values(w.state().deeds).at(-1)!;
    expect(deed.witnesses.some((x) => x.npcId === who)).toBe(true);
    expect(w.state().infiltration?.alarm).toBe(0);

    const v = make();
    const other = sneakToLoner(v);
    inf(v, "grab", { target: other });
    const before = v.state().infiltration!.alarm;
    ask(v, other, "release");
    expect(v.state().infiltration?.alarm ?? 3).toBeGreaterThanOrEqual(before + 2);
  });

  it("곁에 셋 이상이 더 있는 자리에서는 몰래 붙잡지 못한다 (PT21: 둘까지는 어렵게)", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "yard" });
    inf(w, "start", { goal: "steal" });
    const s = w.state();
    const there = peopleAt(s, content, "c_warehouse", "yard").filter((id) => !s.characters[id]?.captive);
    if (there.length > 3) expect(inf(w, "grab", { target: there[0] }).ok).toBe(false);
    expect(inf(w, "grab", { target: "nobody" }).ok).toBe(false);
  });
});
