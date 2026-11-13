import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { companionSkillMod } from "./companions.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

function withDog() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-comp-")), content, rngFactory: () => createSeededRng(8) });
  const w = m.create("mcp", "role_a_grunt");
  const r = w.executeTool("spawn_extra", { template: "stray_dog", label: "누렁이" });
  expect(r.ok).toBe(true);
  const dog = w.state().scene.present.find((id) => w.state().characters[id]?.extra?.template === "stray_dog")!;
  w.ctx().store.append({ type: "companion_joined", characterId: dog });
  return { w, dog };
}

describe("동행 (기획서 7.8)", () => {
  it("동물은 호칭이 이름이고, 구역을 옮겨도 따라오며, 함께 있으면 경계에 보정이 붙는다", async () => {
    const { w, dog } = withDog();
    expect(w.state().characters[dog]!.name).toBe("누렁이");
    w.executeTool("take_action", act("동쪽 초소로 간다", { move_to: "a_east_post" }));
    expect(w.state().scene.present).toContain(dog);
    expect(companionSkillMod(w.state(), w.content, "sense_danger")).toBe(1);
    expect(companionSkillMod(w.state(), w.content, "shoot")).toBe(0);
    expect(w.sceneForGm()).toContain("동행 (구역을 옮겨도 따라온다");
    expect(await w.runCommand("?상태")).toContain("동행  누렁이");
    w.close();
  });

  it("헤어지면 더 따라오지 않고, 죽은 동행도 따라오지 않는다", () => {
    const { w, dog } = withDog();
    expect(w.executeTool("companion_leave", { target: dog }).ok).toBe(true);
    w.executeTool("take_action", act("동쪽 초소로 간다", { move_to: "a_east_post" }));
    expect(w.state().scene.present).not.toContain(dog);
    const again = withDog();
    again.w.ctx().store.append({ type: "condition_changed", targetId: again.dog, track: "harm", from: "none", to: "dead", fatal: true, by: "test", cause: "t", day: 1, harmTrack: true });
    again.w.executeTool("take_action", act("동쪽 초소로 간다", { move_to: "a_east_post" }));
    expect(again.w.state().scene.present).not.toContain(again.dog);
    expect(companionSkillMod(again.w.state(), again.w.content, "sense_danger")).toBe(0);
    w.close();
    again.w.close();
  });
});
