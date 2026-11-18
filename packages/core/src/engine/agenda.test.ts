import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { agendaCue, agendaOf, nudgeAgenda, runAgendas } from "./agenda.ts";
import { applyEffect } from "./storyletTools.ts";
import type { StoryletEffect } from "../content/schemas.ts";

/** 인물의 자기 일 (12-168) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-agenda-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
const facts = (w: GameWorld) => (w.state().beliefs[w.state().playerId] ?? []).map((b) => b.fact);

describe("인물의 자기 일", () => {
  it("날마다 한 칸씩 차고, 반을 넘으면 GM 카드에 낌새가 보인다", () => {
    const w = make();
    const steps = agendaOf(content, w.state(), "a_dongwook")!.agenda.steps;
    expect(agendaCue(content, w.state(), "a_dongwook")).toBeNull();
    for (let d = 1; d <= Math.ceil(steps / 2); d++) runAgendas(w.ctx(), d);
    expect(agendaOf(content, w.state(), "a_dongwook")!.filled).toBe(Math.ceil(steps / 2));
    expect(agendaCue(content, w.state(), "a_dongwook")).toContain("요즘 이 인물은");
  });

  it("다 차면 끝 효과가 일어나고, 같은 무리 주인공은 소식을 듣고, 다음 일로 넘어간다", () => {
    const w = make();
    nudgeAgenda(w.ctx(), "a_dongwook", 99, false);
    expect(w.state().characters.a_dongwook!.rank).toBe("squad_leader");
    expect(facts(w).some((f) => f.includes("다른 분대를 맡게 됐다"))).toBe(true);
    expect(agendaOf(content, w.state(), "a_dongwook")).toBeNull(); // 다음 일이 없다
    nudgeAgenda(w.ctx(), "a_jiho", 99, false);
    expect(agendaOf(content, w.state(), "a_jiho")?.agenda.id).toBe("scout_team");
  });

  it("끝 효과로 죽을 수 있다 (부상 트랙의 끝 단계로)", () => {
    const w = make();
    nudgeAgenda(w.ctx(), "pd_ugyeong", 99, false);
    expect(w.state().characters.pd_ugyeong!.dead).toBe(false);
    nudgeAgenda(w.ctx(), "pd_ugyeong", 99, false);
    expect(w.state().characters.pd_ugyeong!.dead).toBe(true);
  });

  it("이야기 효과로 늦추거나 그만두게 할 수 있다", () => {
    const w = make();
    nudgeAgenda(w.ctx(), "a_dongwook", 5, false);
    applyEffect(w.ctx(), { agenda: { who: "x", delta: -3, stop: false } } as StoryletEffect, { x: "a_dongwook" }, {}, "테스트");
    expect(agendaOf(content, w.state(), "a_dongwook")!.filled).toBe(2);
    applyEffect(w.ctx(), { agenda: { who: "x", delta: 0, stop: true } } as StoryletEffect, { x: "a_dongwook" }, {}, "테스트");
    expect(agendaOf(content, w.state(), "a_dongwook")).toBeNull();
    expect(w.state().characters.a_dongwook!.rank).not.toBe("squad_leader"); // 끝 효과 없이
  });

  it("확률을 넘기지 못한 날은 차지 않는다", () => {
    const w = make(0.99);
    runAgendas(w.ctx(), 1);
    expect(agendaOf(content, w.state(), "a_dongwook")!.filled).toBe(0);
  });
});
