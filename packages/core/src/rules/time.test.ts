import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import {
  dayOf,
  formatAgo,
  formatDuration,
  formatTime,
  nextSegmentStart,
  rollActivityMinutes,
  segmentOf,
  START_TIME,
} from "./time.ts";

const at = (day: number, h: number, m = 0) => (day - 1) * 1440 + h * 60 + m;

describe("게임 시간", () => {
  it("시작은 1일차 새벽 05:30", () => {
    expect(formatTime(START_TIME)).toBe("1일차 05:30 (새벽)");
  });

  it("시간대 경계", () => {
    expect(segmentOf(at(1, 3, 59))).toBe("night");
    expect(segmentOf(at(1, 4))).toBe("dawn");
    expect(segmentOf(at(1, 6))).toBe("morning");
    expect(segmentOf(at(1, 10))).toBe("day");
    expect(segmentOf(at(1, 17))).toBe("evening");
    expect(segmentOf(at(1, 20))).toBe("night");
    expect(dayOf(at(2, 0))).toBe(2);
  });

  it("다음 시간대 시작은 항상 미래다", () => {
    expect(nextSegmentStart(at(1, 5, 30), "morning")).toBe(at(1, 6));
    expect(nextSegmentStart(at(1, 6), "morning")).toBe(at(2, 6));
    expect(nextSegmentStart(at(1, 22), "morning")).toBe(at(2, 6));
  });

  it("시간 표시", () => {
    expect(formatDuration(5)).toBe("5분");
    expect(formatDuration(120)).toBe("2시간");
    expect(formatDuration(95)).toBe("1시간 35분");
  });

  it("범위 활동은 15분 단위로 범위 안에서 나온다", () => {
    const rng = createSeededRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const m = rollActivityMinutes({ kind: "range", min: 60, max: 120 }, rng);
      expect(m % 15).toBe(0);
      expect(m).toBeGreaterThanOrEqual(60);
      expect(m).toBeLessThanOrEqual(120);
      seen.add(m);
    }
    expect([...seen].sort()).toEqual([105, 120, 60, 75, 90]);
  });
});

describe("얼마나 전인지 (12-178)", () => {
  it("날짜로 센다", () => {
    expect(formatAgo(at(3, 23), at(3, 1))).toBe("오늘");
    expect(formatAgo(at(3, 1), at(2, 23))).toBe("어제");
    expect(formatAgo(at(5, 9), at(3, 9))).toBe("그저께");
    expect(formatAgo(at(10, 9), at(5, 9))).toBe("5일 전");
    expect(formatAgo(at(30, 9), at(9, 9))).toBe("3주 전");
    expect(formatAgo(at(100, 9), at(10, 9))).toBe("3달 전");
  });
});
