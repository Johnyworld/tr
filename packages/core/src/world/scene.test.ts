import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { SCENE_FULL_EVERY } from "./world.ts";
import { WorldManager } from "./manager.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

describe("장면 정보 아끼기 (기획서 11.6 토큰)", () => {
  it("행동 뒤에는 바뀐 덩어리만, 날짜가 바뀌거나 여러 턴이 지나면 전체를 다시 (구역을 옮겨도 바뀐 덩어리만, 12-62)", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scene-")), content, rngFactory: () => createSeededRng(1) });
    const w = m.create("mcp", "role_a_officer");
    const full = w.sceneForGm();
    w.executeTool("take_action", act("주위를 본다"));
    const update = w.sceneUpdate();
    expect(update.length).toBeLessThan(full.length / 2);
    expect(update).toContain("시각:");
    expect(update).toContain("그대로라 다시 싣지 않음");
    expect(update).toContain("get_scene");
    // 구역을 옮겨도 바뀐 덩어리만 (12-62): 새 구역은 실리고 믿음 같은 그대로인 덩어리는 이름만
    w.executeTool("take_action", act("동쪽 초소로 간다", { move_to: "a_east_post" }));
    const moved = w.sceneUpdate();
    expect(moved).toContain("현재 구역: 동쪽 초소");
    expect(moved).toContain("그대로라 다시 싣지 않음");
    // 처음 전체를 보낸 뒤 SCENE_FULL_EVERY턴째에 전체를 다시
    for (let i = 2; i < SCENE_FULL_EVERY - 1; i++) {
      w.executeTool("take_action", act("주위를 본다"));
      expect(w.sceneUpdate()).toContain("그대로라 다시 싣지 않음");
    }
    w.executeTool("take_action", act("주위를 본다"));
    expect(w.sceneUpdate()).not.toContain("그대로라 다시 싣지 않음");
    w.close();
  });

  it("아는 인물은 가까운 사람만 자세히, 나머지는 한 줄. 믿음은 최근 것 위주로 줄이고 나머지는 recall", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scene-")), content, rngFactory: () => createSeededRng(1) });
    const w = m.create("mcp", "role_a_officer");
    const scene = w.sceneForGm();
    expect(scene).toContain("최선희"); // 상관은 자세히
    // 아직 별일 없는 다른 무리 사람은 이름만 모은다 (12-61)
    expect(scene).toMatch(/그 밖에 아는 사람 \(아직 별일 없는 사이\): [^\n]*표승민\(b_seungmin\)/);
    // 관계가 생기면 한 줄로 올라온다
    w.ctx().store.append({ type: "relation_changed", from: "b_seungmin", to: "player", delta: { trust: 1, affection: 0, respect: 0 }, reason: "test" });
    expect(w.sceneForGm()).toMatch(/표승민 \(b_seungmin\) · 간부 · 남성: [^\n]{0,45}\n/);
    for (let i = 0; i < 20; i++) w.ctx().store.append({ type: "belief_added", characterId: "player", belief: { id: `b_x${i}`, fact: `시험 믿음 ${i}`, source: "rumor", accuracy: "approximate", learnedAt: 0 } });
    const beliefs = w.sceneForGm().split("당신이 알고 있다고 믿는 것")[1]!;
    expect(beliefs).toContain("시험 믿음 19");
    expect(beliefs).not.toContain("시험 믿음 5\n");
    expect(beliefs).toMatch(/더 오래된 것 \d+개. 필요하면 recall/);
    w.close();
  });
});
