import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { conditionsMet } from "../story/storylets.ts";
import { loadRealContent, atEntry } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 무리 안의 갈등 (12-134): 사기가 가라앉으면 탈영·도둑·주먹다짐·반란 모의가 열린다 */
const content = loadRealContent();
const open = () => atEntry(new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-cf-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt"));
const morning = (t: number) => t - (t % 1440) + 8 * 60;

describe("무리 안의 갈등", () => {
  it("탈영은 사기가 -2 이하일 때만 열리고, 보내 주면 무리의 사람 수가 넷 준다", () => {
    const w = open();
    const s = content.storylets.cf_deserters!;
    const f = () => w.state().factions[w.state().characters[w.state().playerId]!.factionId]!;
    f().morale = 0;
    expect(conditionsMet(w.state(), content, s, morning(w.state().time))).toBe(false);
    f().morale = -2;
    expect(conditionsMet(w.state(), content, s, morning(w.state().time))).toBe(true);
    const pop = f().population;
    fireStorylet(w.ctx(), s, {});
    expect(executeTool("resolve_storylet", { choice_id: "let_go" }, w.ctx()).ok).toBe(true);
    expect(f().population).toBe(pop - 4);
  });

  it("반란 모의: 간부가 아니면 끌어들이는 이야기, 간부면 막는 이야기", () => {
    const w = open();
    const me = w.state().characters[w.state().playerId]!;
    w.state().factions[me.factionId]!.morale = -3;
    const night = (t: number) => t - (t % 1440) + 20 * 60;
    expect(conditionsMet(w.state(), content, content.storylets.cf_mutiny_whisper!, night(w.state().time))).toBe(true);
    expect(conditionsMet(w.state(), content, content.storylets.cf_mutiny_council!, night(w.state().time))).toBe(false);
  });

  it("창고 앞의 밤은 반복된다: 모의에 두 번 껴도 두 번째 밤이 온다", () => {
    const s = content.storylets.cf_mutiny_night!;
    expect(s.repeatable).toBe(true);
    expect(s.cooldown_days).toBe(0);
    expect(content.storylets.rf_ears_among!.repeatable).toBe(true);
  });
});
