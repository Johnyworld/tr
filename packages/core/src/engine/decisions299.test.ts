import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { whereIs } from "../rules/place.ts";
import { REGARD_KINDS } from "../rules/regard.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { makeOffer } from "./requests.ts";
import { learn } from "./reputationTools.ts";
import { applyEffect, maskUnknownNames } from "./storyletTools.ts";

/** PT27 뒤 고친 것 (12-299). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const quiet = { ...content, storylets: {} };
const make = (role: string, roll = 0.5, c = quiet) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-299-")), content: c, rngFactory: () => () => roll }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("PT27 뒤 고친 것 (12-299)", () => {
  it("성을 뺀 이름만 쓴 모르는 사람도 호칭으로 가린다", () => {
    const w = make("role_c_raider");
    const s = w.state();
    expect(content.npcs.rs_inn_worker?.name ?? "홍미란").toBe("홍미란");
    const out = maskUnknownNames(s, content, "붉은연합 사람이라면 미란은 더 조심한다. 그 애 이름? 연옥이. 미란이 웃었다");
    expect(out).not.toMatch(/미란|연옥/);
    expect(out).toContain("더 조심한다");
  });

  it("임무 완수로 오를 몫이 하루 상한에 막히면 GM 한 줄을 돌려준다", () => {
    const w = make("role_a_grunt");
    const me = w.state().playerId;
    const boss = content.roles.role_a_grunt!.commander!;
    const deed = (n: number) => {
      const d = { id: `d_x${n}`, actorId: me, summary: "임무 완수: 시험", tags: ["diligence" as const], severity: 1, at: w.state().time, witnesses: [], searched: false };
      w.ctx().store.append({ type: "deed_recorded", deed: d });
      return d;
    };
    expect(learn(w.ctx(), deed(1), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toBeNull();
    expect(learn(w.ctx(), deed(2), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toContain("오늘은 더 마음이 움직이지 않는다");
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: w.state().time + MINUTES_PER_DAY });
    const before = (w.state().relations[boss]?.[me] ?? NEUTRAL_RELATION).trust;
    expect(learn(w.ctx(), deed(3), boss, "report", ["trust", "respect"], REGARD_KINDS.missionDone)).toBeNull();
    expect((w.state().relations[boss]?.[me] ?? NEUTRAL_RELATION).trust).toBe(before + 1);
  });

  it("이름을 묻는 선택지는 그 사람의 이름을 알게 한다 (계단 밑의 귓속말)", () => {
    const ask = content.storylets.tr_inn_whisper!.choices.find((c) => c.id === "ask_name")!;
    expect(ask.effects.some((e) => "reveal_name" in e && e.reveal_name.who === "victim")).toBe(true);
    const w = make("role_c_raider");
    const victim = Object.values(content.npcs).find((n) => n.name === "곽연옥")!.id;
    applyEffect(w.ctx(), { reveal_name: { who: "victim" } }, { victim }, {}, "테스트");
    expect(w.state().known[w.state().playerId] ?? []).toContain(victim);
  });

  it("섬: 흔한 물건을 조금 지니고 있어도 찾아오기 의뢰가 나오고, 지닌 것보다 많이 맡긴다", () => {
    let offered = 0;
    for (const roll of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const w = make("role_y_islander", roll);
      const s = w.state();
      for (const item of ["canned_food", "dried_fish", "water_bottle"]) if (content.items[item]) w.ctx().store.append({ type: "item_granted", to: s.playerId, itemId: item, quantity: 1 });
      const islanders = Object.values(content.npcs).filter((n) => whereIs(w.state(), content, n.id)?.zone === s.playerZone && n.id !== s.playerId).map((n) => n.id);
      for (const id of islanders) {
        const offer = makeOffer(w.state(), content, id, () => roll);
        if (!offer?.item) continue;
        offered++;
        const held = w.state().characters[s.playerId]!.inventory[offer.item.id] ?? 0;
        expect(offer.item.quantity).toBeGreaterThan(held);
      }
    }
    expect(offered).toBeGreaterThan(0);
  });
});
