import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { MINUTES_PER_DAY, SEGMENT_START_HOUR } from "../rules/time.ts";
import { opposeModifier } from "./opposition.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 상대와 상황 (12-104) */
const content = loadRealContent();

function setup(hour = 12) {
  const roll = { value: 0.5 };
  const quiet = { ...content, storylets: {} };
  const store = new InMemoryGameStore([createWorldEvent(quiet, "role_l_wanderer", "world_opp", () => 0.5)]);
  const ctx = { store, rng: () => roll.value, content: quiet };
  const s = store.getState();
  s.time = Math.floor(s.time / MINUTES_PER_DAY) * MINUTES_PER_DAY + hour * 60;
  s.weather = null;
  // 구역을 미리 정해 둔다 (첫 도구에서 시작 장소로 옮기면 장면에 세운 사람이 그 자리에 남는다, 12-259)
  s.playerZone = content.roles.role_l_wanderer!.start_location!;
  s.companions = [];
  s.scene.present = [];
  const me = s.characters[s.playerId]!;
  me.traits = [];
  /** 장면에 사람을 세운다 (다른 인물을 빌려 능력·스킬만 정한다) */
  const others = Object.keys(s.characters).filter((id) => id !== s.playerId);
  const place = (n: number, skills: Record<string, number> = {}, stats: Record<string, number> = {}) =>
    others.slice(0, n).map((id) => {
      const c = s.characters[id]!;
      c.dead = false;
      c.skills = { ...c.skills, ...skills };
      c.stats = { ...Object.fromEntries(Object.keys(c.stats).map((k) => [k, 0])), ...stats };
      s.scene.present.push(id);
      return id;
    });
  return { store, ctx, roll, me, place };
}

const act = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  intent: "행동", activity: null, deed: null, target: null, narration_summary: null, for_mission: false,
  check: { stat: "agility", difficulty: "normal", harm_on_failure: "none", harm_cause: "", ...check },
  ...extra,
});
const lineOf = (out: ReturnType<typeof executeTool>) => (out.ok && out.display.type === "check" ? out.display.line ?? "" : "");

describe("상대와 상황", () => {
  it("상대 점수가 높으면 어렵고 낮으면 쉽다", () => {
    expect([-1, 0, 1, 2, 3, 4].map(opposeModifier)).toEqual([1, -0, -0, -1, -1, -2]);
  });

  it("솜씨 좋은 상대와 맞붙으면 판정 줄에 상대의 실력이 보인다", () => {
    const { ctx, place } = setup();
    const [foe] = place(1, { fight: 2 }, { strength: 2 });
    const line = lineOf(executeTool("take_action", act({ move: "fight", stat: "strength", opponent: foe }), ctx));
    expect(line).toMatch(/-2\(상대가 근접전에 능함: [^)]+\)/);
  });

  it("지켜보는 눈이 많으면 숨기 어렵고, 밤이면 숨기 쉽다", () => {
    const day = setup(SEGMENT_START_HOUR.day + 1);
    day.place(3);
    expect(lineOf(executeTool("take_action", act({ move: "stealth" }), day.ctx))).toContain("-1(지켜보는 눈)");
    const night = setup(SEGMENT_START_HOUR.night + 1);
    expect(lineOf(executeTool("take_action", act({ move: "stealth" }), night.ctx))).toContain("+1(어둠)");
  });

  it("장면에 없는 상대는 고를 수 없다", () => {
    const { ctx, store } = setup();
    const absent = Object.keys(store.getState().characters).find((id) => id !== store.getState().playerId)!;
    const out = executeTool("take_action", act({ move: "fight", opponent: absent }), ctx);
    expect(out.ok).toBe(false);
  });

  it("다칠 때 솜씨 좋은 상대는 한 단계 더, 서툰 상대는 한 단계 덜 (적어도 한 단계)", () => {
    const harmOf = (skills: Record<string, number>, stats: Record<string, number>) => {
      const { ctx, roll, store, place } = setup();
      const [foe] = place(1, skills, stats);
      roll.value = 0; // 주사위 1+1: 실패
      const out = executeTool("take_action", act({ move: "endure", stat: "vitality", harm_on_failure: "light", harm_cause: "몽둥이", harm_kind: "blunt", opponent: foe }), ctx);
      return { text: out.ok ? out.resultText : (out as { error: string }).error, harm: store.getState().characters[store.getState().playerId]!.conditions.harm };
    };
    const strong = harmOf({ fight: 2 }, { strength: 2 });
    expect(strong.text).toContain("상대의 몫");
    expect(strong.harm).toBe("serious"); // 가벼운 위험 1단계 + 1
    const weak = harmOf({ fight: -1 }, {});
    expect(weak.harm).toBe("light"); // 1 - 1 이지만 적어도 1단계
  });

  it("무거운 무기를 지닌 상대는 한 단계 더 아프게 한다. 실력과 합쳐 -1 ~ +1 (12-121)", () => {
    const harmOf = (skills: Record<string, number>, inventory: Record<string, number>) => {
      const { ctx, roll, store, place } = setup();
      const [foe] = place(1, skills, {});
      const c = store.getState().characters[foe!]!;
      c.inventory = inventory;
      c.equipped = { ...c.equipped, weapon: null };
      roll.value = 0;
      const out = executeTool("take_action", act({ move: "endure", stat: "vitality", harm_on_failure: "light", harm_cause: "총", harm_kind: "blunt", opponent: foe }), ctx);
      return { text: out.ok ? out.resultText : (out as { error: string }).error, harm: store.getState().characters[store.getState().playerId]!.conditions.harm };
    };
    // 보통 실력 + 엽총(탄약 있음) → 한 단계 더
    const armed = harmOf({ fight: 1, shoot: 1 }, { shotgun: 1, shells: 2 });
    expect(armed.harm).toBe("serious");
    expect(armed.text).toContain("엽총");
    // 탄약 없는 엽총은 무겁지 않다
    expect(harmOf({ fight: 1, shoot: 1 }, { shotgun: 1 }).harm).toBe("light");
    // 서툰 상대(-1) + 무기(+1) = 그대로
    expect(harmOf({ fight: -1, shoot: -1 }, { shotgun: 1, shells: 2 }).harm).toBe("light");
  });

  it("숨을 때 상대가 멀면 쉽고 맞붙으면 어렵다 (12-121)", () => {
    const { ctx, place } = setup(13);
    const [foe] = place(1);
    expect(lineOf(executeTool("take_action", act({ move: "stealth", stat: "agility", opponent: foe, distance: "far" }), ctx))).toContain("+1(먼 거리)");
    expect(lineOf(executeTool("take_action", act({ move: "stealth", stat: "agility", opponent: foe, distance: "close" }), ctx))).toContain("-1(맞붙은 거리)");
    expect(lineOf(executeTool("take_action", act({ move: "stealth", stat: "agility", opponent: foe, distance: "near" }), ctx))).not.toContain("거리)");
  });
});
