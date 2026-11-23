import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCastFates } from "../content/loader.ts";
import { arrivalPlace, movePlayer, placesIn, storyIndoor, storyOpenPlaces } from "../rules/place.ts";
import { storyText } from "../rules/storySlot.ts";
import { atEntry, knowAllPlaces, loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { remainsHere } from "./remains.ts";
import { fireStorylet } from "./storyletTools.ts";

/** 이동 기획 (12-287): 이야기는 주인공을 옮기지 않는다, 주인공 이동은 movePlayer 하나로, 따라오는 사람, 계승 자리, 함께 아는 장소, 유해 자리. 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role = "role_a_grunt", roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-287-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("이동 기획 (12-287)", () => {
  it("이야기는 주인공을 옮기지 않는다: 장소가 다른 이야기를 열어도 그 자리에 그대로", () => {
    const w = atEntry(make());
    const road = w.state().playerPlace;
    const story = Object.values(content.storylets).find((s) => !s.when.summons && s.when.places?.length && s.when.zones?.includes(w.state().playerZone!) && !s.when.places.includes(road!))!;
    fireStorylet(w.ctx(), story, {});
    expect(w.state().playerPlace).toBe(road);
  });

  it("부르는 이야기는 movePlayer로 불려 가고 시간이 든다", () => {
    const w = atEntry(make());
    const s0 = w.state();
    const far = placesIn(s0, content, s0.playerZone).find((p) => p.indoor && !p.road)!;
    const t = s0.time;
    const line = movePlayer(w.ctx(), { zone: s0.playerZone!, place: far.id }, "summoned");
    expect(line).toContain("불려 갔다");
    expect(w.state().time).toBeGreaterThan(t);
  });

  it("업혀 다른 구역으로 가면 길만큼 시간이 든다", () => {
    const w = make();
    const t = w.state().time;
    const line = movePlayer(w.ctx(), { zone: "old_town" }, "carried");
    expect(line).toContain("업혀");
    expect(w.state().playerPlace).toBe(arrivalPlace(w.state(), content, "old_town"));
    expect(w.state().time - t).toBeGreaterThan(30);
  });

  it("함께 있던 동행도 그 장소를 안다", () => {
    const w = make("role_l_wanderer");
    const dog = w.state().companions[0]!;
    knowAllPlaces(w, content);
    const target = placesIn(w.state(), content, w.state().playerZone).find((p) => p.id !== w.state().playerPlace)!;
    w.executeTool("take_action", act({ place_to: target.id }));
    expect(w.state().knownPlaces[dog] ?? []).toContain(`${w.state().playerZone}:${target.id}`);
  });

  it("유해는 죽은 자리에서만 닿는다", () => {
    const w = make();
    const s0 = w.state();
    const here = s0.playerPlace;
    w.ctx().store.append({ type: "remains_left", remains: { of: "a_taeho", holder: "a_taeho", zone: s0.playerZone!, diedAt: s0.time, buriedAt: null, marker: null, spot: here } });
    expect(remainsHere(w.state()).length).toBe(1);
    const other = placesIn(w.state(), content, w.state().playerZone).find((p) => p.id !== here)!;
    movePlayer(w.ctx(), { zone: w.state().playerZone!, place: other.id }, "walk");
    expect(remainsHere(w.state()).length).toBe(0);
  });

  it("구역이 정해진 이야기는 그 구역 어딘가에서 열릴 수 있고, 글이 배역의 처지를 바꾸면 효과가 있다", () => {
    const s0 = make().state();
    for (const s of Object.values(content.storylets)) for (const z of s.when.zones ?? []) {
      if (content.locations[z]) expect(storyOpenPlaces(s0, content, z, { ...s.when, indoor: storyIndoor(s.when) }, storyText(s)).length, `${s.id}@${z}`).toBeGreaterThan(0);
    }
    expect(checkCastFates(content)).toEqual([]);
    const st = content.storylets.a_grunt_deserter ?? Object.values(content.storylets).find((x) => x.cast.deserter)!;
    const broken = { ...st, choices: st.choices.map((c) => ({ ...c, effects: c.effects.filter((e) => !("npc_depart" in e) && !("npc_capture" in e)), outcomes: c.outcomes ? Object.fromEntries(Object.entries(c.outcomes).map(([k, v]) => [k, v.filter((e) => !("npc_depart" in e) && !("npc_capture" in e))])) : c.outcomes })) };
    expect(checkCastFates({ ...content, storylets: { [st.id]: broken as typeof st } }).length).toBeGreaterThan(0);
  });

  it("판정을 건 이동의 상대는 따라오지 않고, 빗나가면 쫓아온다", () => {
    for (const [roll, follows] of [[0.99, false], [0.01, true]] as const) {
      const w = make("role_a_grunt", roll);
      knowAllPlaces(w, content);
      const mate = Object.values(content.npcs).find((n) => n.faction === "faction_a" && n.id !== content.roles.role_a_grunt!.commander)!.id;
      w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
      const to = placesIn(w.state(), content, w.state().playerZone).find((p) => p.id !== w.state().playerPlace && !p.road)!;
      const r = w.executeTool("take_action", act({ place_to: to.id, check: { move: "athletics", stat: "agility", difficulty: "normal", harm_on_failure: "none", harm_cause: "", opponent: mate } }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(w.state().playerPlace).toBe(to.id);
      expect(w.state().scene.present.includes(mate)).toBe(follows);
    }
  });
});
