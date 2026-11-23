import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { sleepNerves, shakeNerves } from "./body.ts";
import { healFromSleep } from "./care/recovery.ts";

/** 설계 목록 C-3 몸·잠 (12-281): 푹 잔 것은 지난 하루 잔 시간의 합, 한 번 쓴 잠은 다시 세지 않는다, 멘탈붕괴는 푹 자면 한 단계. 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-281-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_l_wanderer", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("몸·잠 (12-281)", () => {
  it("나눠 잔 잠도 하루에 6시간이면 상처가 아물고, 길게 자도 한 단계뿐 (3-2)", () => {
    const w = make();
    const ctx = w.ctx();
    const me = w.state().playerId;
    const harm = content.scenario.harm_track;
    ctx.store.append({ type: "condition_changed", targetId: me, track: harm, from: "none", to: "serious", fatal: false, by: "enemy", cause: "테스트", day: 1, harmTrack: true });
    const step = (activity: "sleep" | "wait", h: number) => ctx.store.append({ type: "time_advanced", activity, from: w.state().time, to: w.state().time + h * 60 });
    step("wait", 2 * 24 + 1); // 중상은 이틀이 지나야 (12-266)
    const a = w.state().time;
    step("sleep", 4);
    step("wait", 3); // 한 시간 넘게 깨어 있었다: 예전에는 이어진 잠이 아니었다
    const b = w.state().time;
    step("sleep", 3);
    expect(healFromSleep(ctx, b, w.state().time).length).toBeGreaterThan(0);
    expect(w.state().characters[me]!.conditions[harm]).toBe("light");
    void a;
    // 이어서 12시간을 자도 더 아물지 않는다 (상처가 바뀐 뒤 이틀, 한 번 쓴 잠은 다시 세지 않는다)
    const c = w.state().time;
    step("sleep", 12);
    expect(healFromSleep(ctx, c, w.state().time)).toEqual([]);
  });

  it("멘탈붕괴는 굶주려도 푹 자면 한 단계 풀린다 (3-1)", () => {
    const w = make();
    const me = () => w.state().characters[w.state().playerId]!;
    shakeNerves(w.ctx(), 4, "test", false);
    expect(me().conditions.nerves).toBe("broken");
    me().conditions.hunger = "starving";
    w.ctx().store.append({ type: "time_advanced", activity: "sleep", from: w.state().time, to: w.state().time + 7 * 60 });
    expect(sleepNerves({ ...w.ctx(), rng: () => 0.99 }, 7 * 60)?.line).toContain("푹 잤다");
    expect(me().conditions.nerves).toBe("frayed");
  });
});
