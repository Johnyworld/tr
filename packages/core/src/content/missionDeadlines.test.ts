import { describe, expect, it } from "vitest";
import { addDaylight, daylightMinutes, missionDeadline } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { checkMissionDeadlines, daylightLeft } from "./missionDeadlines.ts";

const day2 = 1440; // 2일차 0시
const at = (h: number, m = 0) => day2 + h * 60 + m;

describe("임무 기한은 밤을 세지 않는다 (12-354)", () => {
  it("addDaylight: 낮 안이면 그대로, 밤을 만나면 04시부터 다시 센다", () => {
    expect(addDaylight(at(9), 120)).toBe(at(11));
    expect(addDaylight(at(18), 4 * 60)).toBe(at(4 + 2 + 24)); // 18~20시 2시간 + 다음 날 04~06시 2시간
    expect(addDaylight(at(22), 60)).toBe(at(5 + 24)); // 밤에 받으면 04시부터
    expect(addDaylight(at(2), 60)).toBe(at(5));
    expect(addDaylight(at(19), 17 * 60)).toBe(at(24 + 20)); // 19~20시 1시간 + 다음 날 낮 16시간
  });
  it("daylightMinutes: 밤은 세지 않는다", () => {
    expect(daylightMinutes(at(17), at(24 + 8))).toBe((3 + 4) * 60);
    expect(daylightMinutes(at(21), at(23))).toBe(0);
    expect(daylightMinutes(at(9), at(10))).toBe(60);
  });
  it("급하지 않은 10시간짜리를 18시에 받으면 다음 날 20시", () => {
    expect(missionDeadline(at(18), 10, false)).toBe(at(24 + 20));
  });
  it("급한 10시간짜리를 18시에 받으면 밤을 건너 다음 날 낮에 끝난다", () => {
    expect(missionDeadline(at(18), 10, true)).toBe(at(24 + 4 + 8));
    expect(missionDeadline(at(18), 10, true, 60)).toBe(at(24 + 4 + 9));
  });
  it("급하지 않은 일도 낮 시간이 더 길면 그쪽", () => {
    expect(missionDeadline(at(6), 36, false)).toBe(at(48 + 10));
    expect(missionDeadline(at(6), 10, false)).toBe(at(24 + 20));
  });
  it("실제 콘텐츠: 17시에 받아도 모든 임무에 낮 6시간 이상이 남는다", () => {
    const content = loadRealContent();
    expect(checkMissionDeadlines(content).errors).toEqual([]);
    for (const m of Object.values(content.missions)) expect(daylightLeft(m.deadline_hours, m.urgent ?? false)).toBeGreaterThanOrEqual(6);
  });
});

describe("이야기의 동행 기한 (12-356)", () => {
  it("저녁에 시작해 낮이 6시간도 안 되는 동행 기한은 오류다 (함께 가던 사람이 밤사이 떠난다)", () => {
    const content = loadRealContent();
    const st = Object.values(content.storylets).find((x) => x.id === "ms_deserter_found")!;
    const short = structuredClone(st);
    const json = JSON.stringify(short).replace(/"until":\{"hours":24\}/g, '"until":{"hours":12}');
    const broken = { ...content, storylets: { ...content.storylets, [st.id]: JSON.parse(json) } };
    expect(checkMissionDeadlines(broken).errors.join("\n")).toContain("ms_deserter_found");
  });

  it("실제 콘텐츠의 동행 기한은 모두 낮 6시간 이상이다", () => {
    expect(checkMissionDeadlines(loadRealContent()).errors.filter((e) => e.includes("동행 기한"))).toEqual([]);
  });
});
