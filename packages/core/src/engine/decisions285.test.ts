import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pacingBlocks } from "../rules/storySlot.ts";
import { moveOf } from "../scenario/scenario.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { argsHint } from "./tools.ts";

/** 설계 목록 GM 안내·표시 (12-285). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role: string, roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-285-")), content: { ...content, storylets: {} }, rngFactory: () => () => roll }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "팔뚝이 찢긴 채 이를 악물고 다시 휘두른다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("GM 안내·표시 (12-285)", () => {
  it("앞 이야기를 잇는 후속은 같은 장소·같은 날이어도 막지 않는다 (10-1)", () => {
    const w = make("role_t_visitor");
    const t = w.state().time;
    const s = { ...w.state(), storyletLog: { tv_gate: { lastFiredAt: t, count: 1 } } } as never;
    // 같은 날 같은 장소(checkpoint)에 앞 이야기가 열렸어도 (12시간 간격은 열림 조건이 따로 본다)
    expect(pacingBlocks(s, content, content.storylets.tv_gate_again!, t + 60)).toBe(false);
  });

  it("빈 장면의 talk는 한 줄로 알린다 (10-2)", () => {
    const w = make("role_l_wanderer");
    for (const id of w.state().scene.present) w.ctx().store.append({ type: "npc_left", npcId: id });
    for (const id of w.state().companions) w.ctx().store.append({ type: "companion_left", characterId: id, reason: "테스트" });
    const r = w.executeTool("take_action", act({ intent: "말을 건다", activity: { kind: "talk", until: null } }));
    expect(r.ok ? r.resultText : r.error).toContain("장면에 아무도 없다");
  });

  it("피해 까닭을 비우면 intent 원문 대신 짧은 까닭을 쓴다 (10-4)", () => {
    const w = make("role_a_grunt", 0.01);
    const move = "athletics";
    const r = w.executeTool("take_action", act({ check: { move, stat: moveOf(content.scenario, move)!.stats[0], difficulty: "hard", harm_on_failure: "light", harm_cause: "", harm_kind: "cut" } }));
    const text = r.ok ? r.resultText : r.error;
    expect(text).toContain("중에 다쳤다");
    expect(text).not.toContain("이를 악물고");
  });

  it("인자 안내는 빼도 되는 칸에만 ?, null을 받는 칸에는 | null (10-6)", () => {
    const hint = argsHint(z.strictObject({ a: z.string().nullable(), b: z.string().optional(), c: z.string().nullable().default(null) }));
    expect(hint).toContain("a: string | null");
    expect(hint).toContain("b?: string");
    expect(hint).toContain("c?: string | null");
  });

  it("찾는 가족의 카드에는 관계가 이름 뒤에 한 번만 나온다 (10-7, PT22)", () => {
    const w = make("role_t_visitor");
    const kin = w.state().family[0]!;
    const label = w.state().characters[kin]!.extra!.label;
    const line = w.sceneForGm().split("\n").find((l) => l.includes(`(${label})`)) ?? "";
    expect(line).toContain(`(${label})`);
    expect(line.split(label).length - 1).toBe(1);
  });
});
