/**
 * 공통 규칙 6: 걸린 판정 (docs/design.md "공통 규칙").
 *
 * 무언가 걸린 판정만 경험치를 준다 (12-218). 무엇이 "걸린 것"인지는 여기서만 정한다:
 * 판정을 굴리는 곳은 사실(StakeFacts)을 모아 atStake에 묻는다 (rules/stakes.test.ts가 다른 곳에서 stakes를 직접 정하면 실패시킨다).
 */

export type StakeFacts = {
  /** 실패하면 다치는 위험을 걸었다 */
  harm: boolean;
  /** 맞서는 상대·공격 대상이 있다 */
  opponent: boolean;
  /** 임무를 위한 판정이다 */
  mission: boolean;
  /** 열린 이야기의 선택지가 요구하는 판정이다 (이야기가 열려 있기만 한 것은 아니다, 플레이 테스트 13) */
  storyChoice: boolean;
  /** 전투 중이다 */
  battle: boolean;
  /** 남을 치료하거나 자기를 돌본다 */
  treatment: boolean;
  /** 옮겨 가는 판정이면: 떠나는 땅이나 닿는 땅이 적대하는 땅인가 (hostile), 아니면 safe. 옮겨 가지 않으면 none */
  travel: "none" | "hostile" | "safe";
  /** 적대하는 땅에서 시간을 들이다 들킬 수 있다 */
  exposed: boolean;
  /** 먹을 것 구하기·덫 */
  gathering: boolean;
  /** 시간을 들이는 활동(수색·일·보초 등)의 결과를 정한다 */
  activity: boolean;
};

const REASONS: Record<Exclude<keyof StakeFacts, "travel">, string> = {
  harm: "위험",
  opponent: "상대",
  mission: "임무",
  storyChoice: "이야기",
  battle: "전투",
  treatment: "치료",
  exposed: "적 땅",
  gathering: "먹을 것",
  activity: "활동",
};

/** 이 판정에 무언가 걸렸는가, 그리고 무엇이 */
export function atStake(f: StakeFacts): { stake: boolean; why: string[] } {
  const why = (Object.keys(REASONS) as (keyof typeof REASONS)[]).filter((k) => f[k]).map((k) => REASONS[k]);
  // 적 땅을 드나드는 이동만 걸린 것이다 (플레이 테스트 13: 빈 땅으로 옮겨 가며 건 은밀이 아무 일 없이 경험치만 줬다)
  if (f.travel === "hostile") why.push("적 땅 드나들기");
  return { stake: why.length > 0, why };
}

/** 아무것도 걸리지 않은 사실 (부르는 쪽이 걸린 것만 켠다, 12-269: 판정 도구마다 stakes를 꼭 정하게) */
export const NO_STAKES: StakeFacts = { harm: false, opponent: false, mission: false, storyChoice: false, battle: false, treatment: false, travel: "none", exposed: false, gathering: false, activity: false };

/** 걸린 것만 적어 묻는다: stakesOf({ opponent: true }) */
export function stakesOf(f: Partial<StakeFacts>): boolean {
  return atStake({ ...NO_STAKES, ...f }).stake;
}
