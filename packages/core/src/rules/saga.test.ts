import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSagas } from "../content/loader.ts";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { formatChronicle } from "../engine/succession.ts";
import { choiceAvailable, eligibleStorylets } from "../story/storylets.ts";
import { currentResolve } from "../engine/resolve.ts";
import { loadRealContent } from "../testing.ts";
import { buildPlayerView } from "../views/player.ts";
import { WorldManager } from "../world/manager.ts";
import { activeSaga, describeSaga, sagaConditionMet, sagaLead, sagaMarketFactor, sagaSpineDue, sagaState } from "./saga.ts";
import { isMust } from "./storySlot.ts";
import { MINUTES_PER_DAY } from "./time.ts";

/**
 * 공통 규칙 24 큰 이야기 (docs/saga-plan.md): 문이 열리고, 시작 사건이 첫 막으로 넘기고, 기한을 넘기면 세계 쪽 사건이 넘기고,
 * 마지막 막의 기한이면 결말로 끝난다. 퀘스트 줄·GM 상태·연대기·상인 배율
 */
const real = loadRealContent();
const schemas = createContentSchemas(real.scenario);
const NPC = Object.keys(real.npcs).sort()[0]!;

const saga = schemas.saga.parse({
  id: "test_saga",
  title: "시험의 배",
  summary: "시험용 큰 이야기.",
  opens: { day_gte: 3, roles_none: ["role_t_visitor"] },
  cast: { guide: NPC },
  mark: { at: "a2", fallback: "guide" },
  acts: [
    { id: "a1", title: "첫 막", line: "첫 실마리", gm: "첫 막 지침", days: 10, next: "a2", lapse: { effects: [{ set_flag: "ts_lapsed1" }], news: "세계가 먼저 움직였다고 한다" } },
    { id: "a2", title: "둘째 막", line: "둘째 실마리", gm: "둘째 막 지침", days: 3, lapse: { effects: [], news: "배는 떠났다고 한다", ending: "lost" } },
  ],
  endings: [
    { id: "saved", title: "배를 막았다", chronicle: "배를 막았다", market: { serum: 0 } },
    { id: "lost", title: "R을 넘겼다", chronicle: "R을 넘겼다", lapsed_chronicle: "배는 떠났다", effects: [{ set_flag: "ts_lost" }] },
  ],
  notes: [{ flag: "ts_clue", text: "밤에 장터에 배가 닿는다고 한다", zone: "e_market" }],
});
const story = (o: Record<string, unknown>) => schemas.storylet.parse({ tags: ["saga"], setup: "시험 장면.", ...o });
const start = story({
  id: "ts_start",
  title: "시험의 시작",
  essential: true,
  when: { saga: { id: "test_saga", acts: ["open"] } },
  choices: [
    { id: "go", label: "따라간다", effects: [{ saga_advance: { id: "test_saga", to: "a1" } }, { saga_note: { text: "남쪽으로 갔다고 한다", zone: "south_fields" } }] },
    { id: "ignore", label: "모른 척한다", effects: [{ saga_advance: { id: "test_saga", to: "a1", rush: true } }] },
  ],
});
const spine = story({ id: "ts_spine", title: "등뼈", when: { saga: { id: "test_saga", acts: ["a1"], spine: true } }, choices: [{ id: "next", label: "넘긴다", effects: [{ saga_advance: { id: "test_saga", to: "a2" } }] }, { id: "stay", label: "머문다", effects: [] }] });
const heir = story({ id: "ts_heir", title: "다시 잇기", essential: true, when: { saga: { id: "test_saga", successor: true } }, choices: [{ id: "hear", label: "듣는다", effects: [] }] });

const vow = story({ id: "ts_vow", title: "지키겠다는 말", essential: true, when: { saga: { id: "test_saga", acts: ["a1"] }, indoor: "any" }, choices: [{ id: "tell", label: "말해 준다", effects: [] }, { id: "vow", label: "지키겠다고 한다", effects: [{ resolve: { kind: "survive", n: 10, text: "살아남는다" } }] }] });

const content: Content = { ...real, sagas: { test_saga: saga }, storylets: { ...real.storylets, ts_start: start, ts_spine: spine, ts_heir: heir, ts_vow: vow } };
const make = (roleId = "role_a_grunt") =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-saga-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

/** 문이 열린 뒤 시작 사건을 고른다 */
function started(choice = "go") {
  const w = make();
  w.runCheat("~time +3d");
  expect(sagaState(w.state(), "test_saga")).not.toBeNull();
  if (w.state().activeStorylet?.id !== "ts_start") expect(w.runCheat("~storylet ts_start").ok).toBe(true);
  const r = w.executeTool("resolve_storylet", { choice_id: choice });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return w;
}

describe("큰 이야기 (공통 규칙 24)", { timeout: 30_000 }, () => {
  it("문은 날짜가 차야 열리고, 튜토리얼에서는 열리지 않는다", () => {
    const w = make();
    w.runCheat("~time +1d");
    expect(sagaState(w.state(), "test_saga")).toBeNull();
    w.runCheat("~time +2d");
    expect(sagaState(w.state(), "test_saga")?.act).toBe("open");
    const t = make("role_t_visitor");
    t.runCheat("~time +4d");
    expect(sagaState(t.state(), "test_saga")).toBeNull();
  });

  it("문이 열리면 시작 사건이 꼭 열리는 이야기로 후보에 있고, 고르면 첫 막과 실마리", () => {
    const w = make();
    w.runCheat("~time +3d");
    const s = w.state();
    expect(s.activeStorylet?.id === "ts_start" || eligibleStorylets(s, content).some((x) => x.id === "ts_start")).toBe(true);
    const after = started();
    const g = sagaState(after.state(), "test_saga")!;
    expect(g.act).toBe("a1");
    expect(g.days).toBe(10);
    expect(g.note).toBe("남쪽으로 갔다고 한다");
    expect(g.engaged).toContain(after.state().playerId);
    // 퀘스트 줄: 종류 구분 없이 같은 목록, 설명은 막, 실마리와 구역
    const todo = buildPlayerView(after.state(), content).todos?.find((t) => t.key === "saga_test_saga");
    expect(todo?.title).toBe("시험의 배");
    expect(todo?.note).toContain("→ 남쪽 텃밭");
    expect(todo?.dueLabel).toContain("남음");
    // GM 상태: 막 지침, 실마리, 지난 장면
    const gm = describeSaga(after.state(), content).join("\n");
    expect(gm).toContain("첫 막 지침");
    expect(gm).toContain("「시험의 시작」: 따라간다");
  });

  it("모른 척하면 첫 막 기한이 절반", () => {
    expect(sagaState(started("ignore").state(), "test_saga")!.days).toBe(5);
  });

  it("기한을 넘기면 세계 쪽 사건이 일어나 다음 막으로 (소식, 넘긴 막)", () => {
    const w = started();
    w.runCheat("~time +11d");
    const s = w.state();
    const g = sagaState(s, "test_saga")!;
    expect(g.act).toBe("a2");
    expect(g.lapsed).toEqual(["a1"]);
    expect(s.flags[s.playerId]).toContain("ts_lapsed1");
    expect((s.beliefs[s.playerId] ?? []).some((b) => b.fact.includes("세계가 먼저 움직였다"))).toBe(true);
    expect(g.note).toBe("둘째 실마리");
  });

  it("마지막 막의 기한이면 결말로 끝난다: 결말 효과, 연대기는 시계로 끝난 글, 퀘스트에서 빠진다", () => {
    const w = started();
    w.runCheat("~time +11d");
    w.runCheat("~time +4d");
    const s = w.state();
    const g = sagaState(s, "test_saga")!;
    expect(g.act).toBe("ended");
    expect(g.ending).toBe("lost");
    expect(g.endedByLapse).toBe(true);
    expect(s.flags[s.playerId]).toContain("ts_lost");
    expect(activeSaga(s, content)).toBeNull();
    expect(formatChronicle(s, content)[0]).toBe("큰 이야기: 시험의 배 — 배는 떠났다");
    expect(buildPlayerView(s, content).todos?.some((t) => t.key === "saga_test_saga")).toBe(false);
  });

  it("곁의 R은 정한 막이 시작될 때 고른다 (가까운 사람, 없으면 fallback)", () => {
    const w = started();
    expect(sagaState(w.state(), "test_saga")!.marked).toBeNull();
    expect(w.runCheat("~saga test_saga a2").ok).toBe(true);
    const marked = sagaState(w.state(), "test_saga")!.marked;
    expect(marked).not.toBeNull();
    expect(w.state().characters[marked!]?.dead).toBe(false);
  });

  it("결말의 상인 배율", () => {
    const w = started();
    expect(w.runCheat("~saga test_saga end saved").ok).toBe(true);
    expect(sagaMarketFactor(w.state(), content, "serum")).toBe(0);
    expect(sagaMarketFactor(w.state(), content, "bandage")).toBe(1);
  });

  it("등뼈 이야기는 기한 이틀 안이면 꼭 등급", () => {
    const w = started();
    const s = w.state();
    const g = sagaState(s, "test_saga")!;
    expect(sagaSpineDue(s, spine, s.time)).toBe(false);
    const late = g.actStartedAt + 9 * MINUTES_PER_DAY;
    expect(sagaSpineDue(s, spine, late)).toBe(true);
    expect(isMust(s, spine, late)).toBe(true);
  });

  it("플래그 실마리 표: 플래그가 생기면 실마리가 바뀐다", () => {
    const w = started();
    w.ctx().store.append({ type: "flag_set", characterId: w.state().playerId, flag: "ts_clue" });
    w.runCheat("~time +1h");
    const g = sagaState(w.state(), "test_saga")!;
    expect(g.note).toBe("밤에 장터에 배가 닿는다고 한다");
    expect(g.noteZone).toBe("e_market");
  });

  it("실마리 표의 실마리는 다른 실마리에 덮여도 따라가는 실마리로 남고, 그 플래그를 조건으로 삼는 이야기는 큰 이야기 몫이다 (PT43)", () => {
    const w = started();
    w.ctx().store.append({ type: "flag_set", characterId: w.state().playerId, flag: "ts_clue" });
    w.runCheat("~time +1h");
    w.ctx().store.append({ type: "saga_noted", sagaId: "test_saga", text: "다른 말을 들었다", zone: null });
    const lines = describeSaga(w.state(), content);
    expect(lines.some((l) => l.includes("아직 따라가는 실마리: 밤에 장터에 배가 닿는다고 한다 → "))).toBe(true);
    const lead = schemas.storylet.parse({ id: "ts_lead", title: "밤배", tags: ["world"], setup: "밤배.", when: { flags_any: ["ts_clue"] }, choices: [{ id: "a", label: "본다", effects: [] }, { id: "b", label: "간다", effects: [] }] });
    const other = schemas.storylet.parse({ id: "ts_other", title: "딴 일", tags: ["world"], setup: "딴 일.", when: { flags_any: ["ts_other"] }, choices: [{ id: "a", label: "본다", effects: [] }, { id: "b", label: "간다", effects: [] }] });
    expect(sagaLead(w.state(), content, lead)).toBe(true);
    expect(sagaLead(w.state(), content, other)).toBe(false);
  });

  it("다짐이 있어도 큰 이야기의 이야기는 열리고, 다짐을 건네는 선택지만 빠진다 (PT44)", () => {
    const w = started();
    expect(currentResolve(w.state())).not.toBeNull();
    expect(eligibleStorylets(w.state(), content).some((s) => s.id === "ts_vow")).toBe(true);
    expect(choiceAvailable(w.state(), vow.choices[0]!)).toBe(true);
    expect(choiceAvailable(w.state(), vow.choices[1]!)).toBe(false);
  });

  it("계승자 이야기는 앞 주인공이 발을 들였고 지금 주인공은 아직일 때만", () => {
    const w = started();
    const s = w.state();
    expect(eligibleStorylets(s, content).some((x) => x.id === "ts_heir")).toBe(false);
    const other = Object.keys(s.characters).find((id) => id !== s.playerId && !s.characters[id]!.dead)!;
    const heirState = { ...s, playerId: other };
    expect(sagaConditionMet(s, content, { id: "test_saga", successor: true })).toBe(false);
    expect(sagaConditionMet(heirState, content, { id: "test_saga", successor: true })).toBe(true);
  });

  it("content:check: 시작 사건과 막마다의 길을 본다", () => {
    expect(checkSagas(content).join("\n")).toContain("a1: 다음 막 a2으로 넘기는 이야기가 1편이다");
    const noStart: Content = { ...content, storylets: { ...content.storylets, ts_start: { ...start, essential: false } } };
    expect(checkSagas(noStart).join("\n")).toContain("ts_start: 큰 이야기 test_saga의 시작 사건이다");
  });
});
