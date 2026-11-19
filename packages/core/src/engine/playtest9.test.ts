import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { formSquad } from "./promotion.ts";
import { describeSquadForGm } from "./command.ts";
import { describeFactionsForGm } from "./warTools.ts";
import { maskUnknownNames } from "./storyletTools.ts";
import { inCrisis } from "../story/storylets.ts";
import { visibleSymptoms } from "../scenario/scenario.ts";
import { createExtraCharacter } from "./extras.ts";
import { knowsName, playerCalls } from "../game/acquaintance.ts";
import { josa } from "../text.ts";

/** 긴 판 버그 (플레이 테스트 9, 12-194) */
const real = loadRealContent();
const content = { ...real, storylets: {} };
const make = (role: string, roll: () => number = () => 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt9-")), content, rngFactory: () => roll }).create("mcp", role);
const act = (w: GameWorld, extra: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

describe("플레이 테스트 9 버그", () => {
  it("B1·B8: 진급해서 꾸린 분대가 GM 상태에 나오고, 넘겨받은 분대원의 이름을 안다", () => {
    const w = make("role_a_grunt", () => 0.99);
    w.ctx().store.append({ type: "promoted", characterId: w.state().playerId, from: "grunt", to: "squad_leader" });
    formSquad(w.ctx());
    const squad = w.state().squad!;
    expect(squad.length).toBeGreaterThan(0);
    const text = describeSquadForGm(w.state(), content);
    expect(text).toContain("분대 (squad_order");
    for (const id of squad) {
      expect(text).toContain(id);
      expect(knowsName(w.state(), w.state().playerId, id)).toBe(true);
    }
  });

  it("B2: 추위의 첫 증상은 '추움', 질병·감염은 '몸살 기운'", () => {
    const w = make("role_a_grunt");
    const me = w.state().characters[w.state().playerId]!;
    const label = (track: string, level: string) => visibleSymptoms(real.scenario, { conditions: { ...me.conditions, [track]: level } }).map((x) => x.label);
    expect(label("cold", "cold")).toEqual(["추움"]);
    expect(label("disease", "chill")).toEqual(["몸살 기운"]);
    expect(label("infection", "chill")).toEqual(["몸살 기운"]);
  });

  it("B3: 감염의 몸살 기운에도 해열제를 쓸 수 있고, 치료사는 '다친 데가 없다'로 거절하지 않는다", () => {
    const w = make("role_a_grunt");
    expect(w.runCheat("~set infection chill").ok).toBe(true);
    expect(w.runCheat("~give fever_reducer").ok).toBe(true);
    const r = act(w, { use_item: "fever_reducer" });
    expect(r.ok && r.resultText).not.toContain("쓸 필요가 없다");
    expect(w.state().characters[w.state().playerId]!.inventory.fever_reducer ?? 0).toBe(0);
  });

  it("B4: 무소속도 GM 상태에 지금 구역 id와 인접 구역이 나온다", () => {
    const w = make("role_l_wanderer");
    const text = describeFactionsForGm(w.state(), content);
    expect(text).toContain(`(${w.state().playerZone}`);
    expect(text).toContain("인접 구역(move_to)");
  });

  it("B5: 갇힌 몸은 치명상이어도 위급(급한 이야기만)으로 보지 않는다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~set bleeding bleeding");
    expect(inCrisis(w.state(), content)).toBe(true);
    const s = w.state();
    const captive = { ...s, characters: { ...s.characters, [s.playerId]: { ...s.characters[s.playerId]!, captive: { by: "faction_c", zone: "c_base", since: s.time } as never } } };
    expect(inCrisis(captive, content)).toBe(false);
  });

  it("B9: 이름을 호칭으로 바꾸면 뒤의 조사도 호칭에 맞춘다", () => {
    const w = make("role_a_grunt");
    const npc = Object.values(real.npcs).find((n) => n.name && !knowsName(w.state(), w.state().playerId, n.id) && w.state().characters[n.id])!;
    const alias = playerCalls(w.state(), content, npc.id);
    const out = maskUnknownNames(w.state(), content, `${npc.name}은 웃었다. ${npc.name}가 왔다.`);
    expect(out).toBe(`${josa(alias, "은/는")} 웃었다. ${josa(alias, "이/가")} 왔다.`);
  });

  it("B11: 물가에서 목마르면 물병이 차 있어도 마신다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~set thirst thirsty");
    const before = w.state().characters[w.state().playerId]!.conditions.thirst;
    const r = act(w, { refill: true });
    expect(r.ok).toBe(true);
    expect(w.state().characters[w.state().playerId]!.conditions.thirst).not.toBe(before);
  });

  it("B12: 성별이 적힌 겉모습은 그 성별일 때만 고른다", () => {
    const t = real.extras.road_runner!;
    for (const gender of ["male", "female"]) {
      for (let i = 0; i < 10; i++) {
        const c = createExtraCharacter(real, t, { id: `ex_t${i}`, label: t.label, zone: null, time: 0, usedNames: new Set(), gender }, () => i / 10);
        expect(c.extra!.look.includes("여자")).toBe(gender === "female");
      }
    }
  });
});
