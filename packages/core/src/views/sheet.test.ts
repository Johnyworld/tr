import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { itemIcon } from "../content/icons.ts";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { timeLeftLabel } from "./player.ts";

/** 상태 화면 시트 (12-64): 내구도, 장비를 뺀 소지품, 아이콘, 기한, 경험치 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sheet-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");

describe("상태 화면 시트", () => {
  it("기한까지 남은 때를 말로", () => {
    expect(timeLeftLabel(0)).toBe("기한 지남");
    expect(timeLeftLabel(30)).toBe("1시간 안");
    expect(timeLeftLabel(5 * 60 + 10)).toBe("6시간");
    expect(timeLeftLabel(24 * 60)).toBe("하루");
    expect(timeLeftLabel(36 * 60)).toBe("하루 반");
    expect(timeLeftLabel(3 * 24 * 60)).toBe("사흘");
  });

  it("장비는 남은 내구도와 아이콘으로, 걸친 것은 소지품에서 빠진다", () => {
    const w = open();
    w.runCheat("~give pistol");
    w.runCheat("~give canned_food 3");
    expect(w.executeTool("equip", { item_id: "pistol", slot: null }).ok).toBe(true);
    const v = w.playerView();
    expect(v.gear?.weapon).toMatchObject({ name: "권총", icon: "gun", durability: { left: 6, max: 6 } });
    expect(v.inventory.find((i) => i.id === "pistol")).toBeUndefined();
    expect(v.inventory.find((i) => i.id === "canned_food")).toMatchObject({ quantity: 3, icon: "food" });
    expect(v.statRange).toEqual({ min: -1, max: 2 });
    expect(v.conditions.find((c) => c.id === "infection")).toMatchObject({ levelLabel: "이상 없음", icon: "virus", step: 0 });
    expect(v.growth).toMatchObject({ prev: 0 });
    w.close();
  });

  it("시계: 시간대, 계절, 날씨 아이콘과 추위 (12-66)", () => {
    const v = open().playerView();
    expect(v.clock.segment).toBe("dawn");
    expect(v.clock.time).toBe("05:30 (새벽)");
    expect(v.clock).toMatchObject({ hhmm: "05:30", minute: 330, segmentLabel: "새벽", date: "2032. 11. 8." });
    expect(v.clock.season).toBeTruthy();
    const w = v.clock.weather;
    if (w) {
      const kind = content.scenario.weather!.kinds.find((k) => k.label === w.label)!;
      expect(w.icon).toBe(kind.icon);
      expect(w.chill).toBe(content.scenario.body?.cold?.weather[kind.id] ?? 0);
    }
  });

  it("관계: 게임 안에서 마주쳐 태도를 본 사람만, 죽은 사람은 표시", () => {
    const w = open();
    const s0 = w.state();
    const ids = () => w.playerView().relations.map((r) => r.id);
    expect(new Set(ids())).toEqual(new Set(Object.keys(s0.perceived)));
    // 시작부터 이름을 아는 사람(상관·분대)도 마주치기 전에는 없다
    const acquaintance = (s0.known.player ?? []).find((id) => !s0.perceived[id] && !s0.characters[id]!.dead)!;
    expect(acquaintance).toBeTruthy();
    expect(ids()).not.toContain(acquaintance);
    expect(w.executeTool("npc_presence", { npc_id: acquaintance, action: "enter" }).ok).toBe(true);
    expect(ids()).toContain(acquaintance);
    const name = w.state().characters[acquaintance]!.name;
    expect(w.runCheat(`~harm ${name} dead`).ok).toBe(true);
    expect(w.playerView().relations.find((r) => r.id === acquaintance)?.dead).toBe(true);
    // 죽은 사람은 관계와 같이 있는 인물 모두 맨 아래
    expect(w.playerView().relations.at(-1)?.id).toBe(acquaintance);
    expect(w.playerView().present.at(-1)?.id).toBe(acquaintance);
  });

  it("같이 있는 인물: 동행은 까닭과 함께 맨 위, 동행·분대 목록에도 증상", () => {
    const w = open();
    const s0 = w.state();
    const [a, b] = (s0.known.player ?? []).filter((id) => !s0.characters[id]!.dead);
    for (const id of [a!, b!]) expect(w.executeTool("npc_presence", { npc_id: id, action: "enter" }).ok).toBe(true);
    w.ctx().store.append({ type: "companion_joined", characterId: b!, kind: "purpose" });
    const v = w.playerView();
    expect(v.present[0]).toMatchObject({ id: b, bond: "같은 목적" });
    expect(v.present.find((p) => p.id === a)?.bond).toBeNull();
    expect(v.companions.find((c) => c.id === b)?.states).toEqual([]);
    w.close();
  });

  it("일지 탭: ?일지와 같은 현재 캐릭터의 요약을 최근 것부터", () => {
    const w = open();
    expect(w.playerView().journal).toEqual([]);
    w.recordSummary("turn", "막사에서 눈을 떴다.");
    w.recordSummary("scene", "아침 장면을 매듭지었다.");
    const j = w.playerView().journal;
    expect(j.map((x) => [x.scene, x.text])).toEqual([
      [true, "아침 장면을 매듭지었다."],
      [false, "막사에서 눈을 떴다."],
    ]);
    expect(j[0]!.timeLabel).toContain("1일차");
    w.close();
  });

  it("아이콘은 데이터의 icon이 먼저, 없으면 성질로", () => {
    expect(itemIcon(content.items.water_bottle)).toBe("water");
    expect(itemIcon(content.items.kitchen_knife)).toBe("blade");
    expect(itemIcon(content.items.leather_jacket)).toBe("vest");
    expect(itemIcon(content.items.moto_helmet)).toBe("helmet");
    expect(itemIcon(undefined)).toBe("box");
  });
});
