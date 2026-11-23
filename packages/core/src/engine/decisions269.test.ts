import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldKind } from "../rules/held.ts";
import { baseOfNow, hostileLand } from "../rules/home.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer, describeCaptivityForGm } from "./captivity.ts";
import { recordDeed } from "./reputationTools.ts";
import { raiseAlarm } from "./storyletTools.ts";

/** 공통 규칙 우회 고침 (12-269, docs/rules-bypass-audit.md). 실제 경로로 본다 */
const content = loadRealContent();
const make = (roleId: string) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-269-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("공통 규칙 우회 (12-269)", () => {
  it("격리는 적의 포로 글이 아니다 (빼앗긴 것 없음)", () => {
    const w = make("role_a_grunt");
    const s = w.state();
    w.ctx().store.append({ type: "player_captured", by: "faction_d", zone: "d_clinic", held: {}, quarantine: true });
    expect(heldKind(w.state())).toBe("quarantine");
    const gm = describeCaptivityForGm(w.state(), content);
    expect(gm).not.toContain("무기와 탄은 빼앗겼다");
    expect(gm).toContain("격리");
    void s;
  });

  it("들킨 결과는 경보 이야기가 열리지 않아도 남는다 (들키지 않기 임무)", () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    expect(hostileLand(w.state(), content, "c_warehouse")).toBe(true);
    // 이야기가 이미 열려 있으면 경보 이야기는 못 연다. 그래도 들킨 결과는 남아야 한다
    w.runCheat("~storylet cp_long_wall");
    const before = w.state().deeds;
    raiseAlarm(w.ctx());
    void before;
    const deeds = Object.values(w.state().deeds);
    expect(deeds.some((d) => /들어|침입|몰래/.test(d.summary))).toBe(true);
  });

  it("죽은 사람은 장면에 있어도 행적을 보지 않는다", () => {
    const w = make("role_a_grunt");
    const npc = Object.values(content.npcs).find((n) => whereIs(w.state(), content, n.id)?.zone === w.state().playerZone)!.id;
    w.executeTool("npc_presence", { npc_id: npc, action: "enter" });
    w.runCheat(`~kill ${npc}`);
    const { deed } = recordDeed(w.ctx(), { summary: "창고에서 통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "semi_private", noisy: false });
    expect(deed!.witnesses.some((x) => x.npcId === npc)).toBe(false);
  });

  it("갇혀 있으면 우리 무리 교전 소식이 닿지 않는다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    const n = (w.state().beliefs[w.state().playerId] ?? []).length;
    w.runCheat("~time +2d");
    const war = (w.state().beliefs[w.state().playerId] ?? []).slice(n).filter((b) => b.topic === "war" || /교전|공세|싸움/.test(b.fact));
    expect(war.every((b) => b.source !== "report")).toBe(true);
  });

  it("무리의 거점은 지금 주인으로 찾는다 (함락되면 없다)", () => {
    const w = make("role_a_grunt");
    expect(baseOfNow(w.state(), content, "faction_a")).toBe("a_base");
    const fallen = { zones: { ...w.state().zones, a_base: { ...w.state().zones.a_base!, owner: "faction_c" } } };
    expect(baseOfNow(fallen, content, "faction_a")).toBeNull();
  });
});
