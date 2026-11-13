import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { clashForces } from "../sim/war.ts";
import { WorldManager } from "../world/manager.ts";
import { describePlayerState } from "./context.ts";
import { runDailyNerves, shakeNerves } from "./body.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 12-48: 마음, 구역 보강, 엿듣기 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const open = (role = "role_a_grunt", rng = () => 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-48-")), content, rngFactory: () => rng }).create("mcp", role);

describe("마음", () => {
  it("흔들리면 단계가 오르고, 우리 땅에서 하루를 보내면 가라앉는다", () => {
    const w = open("role_a_grunt", () => 0.99);
    const me = () => w.state().characters[w.state().playerId]!;
    expect(me().conditions.nerves).toBe("steady");
    shakeNerves(w.ctx(), 2, "test");
    expect(me().conditions.nerves).toBe("frayed");
    // 냉정으로 버티지 못하면(0.99) 오르고, 가라앉는 굴림은 낮아야 성공
    const calm = { ...w.ctx(), rng: () => 0.01 };
    runDailyNerves(calm);
    expect(me().conditions.nerves).toBe("shaken");
  });
});

describe("구역 보강", () => {
  it("목수 이야기의 fortify는 우리 땅만 보강하고, 지키는 병력이 늘고, GM 상태에 보인다", () => {
    const w = open("role_a_grunt");
    const zone = w.state().playerZone!;
    const forces = () => clashForces(w.state(), { kind: "raid", attacker: "faction_c", defender: "faction_a", zone }, content).defenders;
    const before = forces();
    w.ctx().store.append({ type: "zone_fortified", zone, delta: 2 });
    expect(w.state().zones[zone]!.fort).toBe(2);
    expect(forces()).toBeGreaterThan(before);
    expect(describePlayerState(w.state(), w.content)).toContain("단단히 보강함");
    w.ctx().store.append({ type: "zone_fortified", zone, delta: 5 });
    expect(w.state().zones[zone]!.fort).toBe(3);
  });
});

describe("엿듣기", () => {
  it("다른 무리가 준비하는 일을 진짜 클락에서 골라 믿음으로 남긴다", () => {
    const w = open("role_a_grunt");
    const s = w.content.storylets.occ_mech_radio_night!;
    const story = { ...s, choices: [{ id: "x", label: "x", effects: [{ overhear: { faction: "other", source: "seen" as const } }] }] };
    const c = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, [s.id]: story } } };
    fireStorylet(c, story as never, {});
    const out = executeTool("resolve_storylet", { choice_id: "x" }, c);
    expect(out.ok && out.resultText).toMatch(/엿들은 것: .+이\(가\) 준비하는 일/);
    const last = w.state().beliefs[w.state().playerId]!.at(-1)!;
    expect(last.topic).toBe("war");
    expect(last.fact).not.toContain("청솔형제단");
  });
});
