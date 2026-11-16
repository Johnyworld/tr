import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { runHelpless } from "./helpless.ts";

/** 의식불명 중 곁의 사람 (12-90): 코드가 정한다 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function setup(role: string, zone: string, people: string[]): GameWorld {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-helpless-")), content, rngFactory: () => createSeededRng(7) });
  const w = m.create("mcp", role, choice);
  for (const id of [...w.state().scene.present]) w.executeTool("npc_presence", { npc_id: id, action: "leave" });
  expect(w.runCheat(`~goto ${zone}`).ok).toBe(true);
  for (const id of people) expect(w.runCheat(`~summon ${id}`).ok).toBe(true);
  expect(w.runCheat("~harm me unconscious").ok).toBe(true);
  return w;
}
/** 확률을 고정해 한 번 돌린다 (0이면 확률 굴림이 모두 맞고, 0.99면 모두 빗나간다) */
const run = (w: GameWorld, roll: number) => runHelpless({ ...w.ctx(), rng: () => roll });
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;

describe("의식불명 중 곁의 사람", () => {
  it("같은 무리 사람이 곁에 있으면 자기 거점으로 옮겨 돌봐 준다 (정신이 든다). 한 번 쓰러질 때 한 번만 정한다", () => {
    const w = setup("role_b_guard", "subway_hub", ["b_myeongsuk"]);
    const out = run(w, 0.99);
    expect(me(w).conditions.harm).toBe("impaired");
    expect(w.state().playerZone).toBe("b_base");
    expect(out.some((d) => d.type === "belief" && d.note?.includes("의식이 없는 동안"))).toBe(true);
    expect(w.state().helplessAt).not.toBeNull();
    // 정신이 들었으니 다음 틱에 비운다
    run(w, 0.99);
    expect(w.state().helplessAt).toBeNull();
    w.close();
  });

  it("적 무리 사람이 곁에 있으면 끌고 가 가두거나, 확률로 죽인다", () => {
    const caught = setup("role_b_guard", "subway_hub", ["c_cheolgu"]);
    run(caught, 0.99);
    expect(me(caught).captive?.by).toBe("faction_c");
    expect(me(caught).dead).toBe(false);
    caught.close();

    const killed = setup("role_b_guard", "subway_hub", ["c_cheolgu"]);
    run(killed, 0);
    expect(me(killed).dead).toBe(true);
    killed.close();
  });

  it("떠돌이(무리 없음)는 붉은연합이 먹잇감으로 본다", () => {
    const w = setup("role_t_visitor", "subway_hub", ["c_cheolgu"]);
    run(w, 0.99);
    expect(me(w).captive?.by).toBe("faction_c");
    w.close();
  });

  it("홀로 위험한 곳에 쓰러져 있으면 감염체가 먼저 찾을 수 있다. 빗나가면 아무 일 없이 다시 굴리지 않는다", () => {
    const bitten = setup("role_b_guard", "subway_hub", []);
    run(bitten, 0);
    expect(me(bitten).dead).toBe(true);
    bitten.close();

    const quiet = setup("role_b_guard", "subway_hub", []);
    run(quiet, 0.99);
    expect(me(quiet).conditions.harm).toBe("unconscious");
    expect(quiet.state().helplessAt).not.toBeNull();
    run(quiet, 0);
    expect(me(quiet).dead).toBe(false);
    quiet.close();
  });

  it("take_action으로 시간이 흐르면 결과가 GM에게 문장으로 간다", () => {
    const w = setup("role_b_guard", "subway_hub", ["b_myeongsuk"]);
    const r = w.executeTool("take_action", { intent: "의식이 없다", check: null, activity: { kind: "wait", until: null }, deed: null, target: null, narration_summary: null, for_mission: false });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) expect(r.resultText).toContain("의식이 없는 동안 일어난 일");
    w.close();
  });

  it("무리 전투 중 쓰러지면 남은 전투를 한 번에 끝내고, 이겼으면 우리 무리가 돌보고 졌으면 적의 손에 떨어진다", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12 && seen.size < 2; seed++) {
      const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-helpless-")), content, rngFactory: () => createSeededRng(seed) });
      const w = m.create("mcp", "role_b_guard", choice);
      expect(w.runCheat("~battle").ok).toBe(true);
      expect(w.state().battle).not.toBeNull();
      expect(w.runCheat("~harm me unconscious").ok).toBe(true);
      const r = w.executeTool("take_action", { intent: "쓰러져 있다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      // 라운드를 하나씩 넘기지 않는다
      expect(w.state().battle).toBeNull();
      const text = r.ok ? r.resultText : "";
      expect(text).toContain("쓰러진 채였다");
      const p = me(w);
      if (text.includes("우리 편이 이겼다")) {
        seen.add("won");
        expect(p.conditions.harm).toBe("impaired");
      } else {
        seen.add("lost");
        expect(p.dead || p.captive?.by !== undefined).toBe(true);
      }
      expect(text).toContain("의식이 없는 동안 일어난 일");
      w.close();
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
