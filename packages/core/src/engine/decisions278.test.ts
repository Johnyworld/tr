import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 설계 목록 C-7 관계·마음·소문 (12-278). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (roll: number) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-278-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_squad_leader", { name: "도윤", gender: "male", abilities: null, portrait: null, traits: [] } as never);
const trust = (w: ReturnType<typeof make>, id: string) => w.state().relations[id]?.[w.state().playerId]?.trust ?? 0;

/** 분대원 하나에게 일을 맡기고 끝날 때까지 기다린다 */
function order(w: ReturnType<typeof make>, task: string, zone: string | null) {
  const id = content.roles.role_a_squad_leader!.squad![0]!;
  const before = trust(w, id);
  const r = w.executeTool("squad_order", { members: [id], task, zone });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  // 기다림이 이야기로 끊길 수 있어 일이 끝날 때까지 되풀이한다
  for (let i = 0; i < 12 && w.state().squadOrders?.[id]; i++) {
    w.state().activeStorylet = null;
    w.executeTool("take_action", { intent: "기다린다", check: null, activity: { kind: "wait", hours: 8 }, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true });
  }
  expect(w.state().squadOrders?.[id]).toBeUndefined();
  return trust(w, id) - before;
}

describe("관계·마음·소문 (12-278)", () => {
  it("위험하지 않은 분대 일이 빗나가도 믿음은 그대로 (7-4)", () => {
    expect(order(make(0), "guard", null)).toBe(0);
  });

  it("위험한 일에 보내 다치면 믿음이 준다, 해내면 오른다 (7-4)", () => {
    expect(order(make(0), "scout", "c_warehouse")).toBe(-1);
    // 적이 없는 곳의 정찰은 빗나가도 다치지 않는다 (PT31)
    expect(order(make(0), "scout", "old_town")).toBe(0);
    expect(order(make(0.99), "scout", "old_town")).toBeGreaterThanOrEqual(1);
  });
});
