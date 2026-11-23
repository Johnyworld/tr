# 공통 규칙 우회 점검 (2026-11-23)

사용자 요청으로 "공통 규칙 모듈(`packages/core/src/rules/`)을 써야 하는데 쓰지 않는 곳"을 코드에서 찾았다. 장소(규칙 15)는 12-268에서 따로 다뤘다.
확실 = 코드를 읽고 확인, 추정 = 의도인지 판단이 필요. ★ = 직접 열어 다시 확인한 것.

## 근본 원인

1. `guards.test.ts`가 상태 필드 이름 몇 개만 정규식으로 막는다. 다른 필드, 변수에 받은 비교, 기본값 생략(`stakes`)으로 같은 판단을 다시 짜면 통과한다
2. 모듈 함수가 다루는 하위 경우(격리·벌 / 적의 포로, 의식불명 / 무력화)가 갈라져 있어, 부르는 쪽이 하위 표시를 직접 읽는다
3. 이야기를 여는 길이 여럿이다 (eligible·road·tag·camp·broadcast). 규칙(쉬기·이야기의 자리)이 eligible 경로에만 걸려 있다

## 규칙별 우회

| 규칙 | 우회 위치 | 다르게 나오는 것 | 확실도 |
|---|---|---|---|
| 1 갇힘 | ★ `engine/body.ts:321-323` | 우리 무리의 벌도 적의 포로처럼 끼니 바닥·배급 못 받음. 다른 무리 격리실이면 "우리 땅 밖"으로 배급 못 받음 (격리는 그쪽이 먹인다고 했다) | 확실 |
| | ★ `engine/captivity.ts:236-240` | 다른 무리 격리도 GM 글이 "무기와 탄은 빼앗겼다" (빼앗은 것 없음) | 확실 |
| | `engine/action.ts:639, 1275-1283` | 벌·격리에서 달아나도 [용기] 행적, "빠져나왔다" (GM 글은 "벌을 어긴 것") | 확실 |
| | `warTools.ts:305`, `storylets.ts:286`·`situation.ts:64` | 다른 무리 격리도 "우리 무리 사정을 모른다", 우리 무리 격리면 갇힌 동안 이야기가 하나도 안 열림 | 추정 |
| 2 탓할 수 없는 일 | ★ `engine/action.ts:1449` missedRollCall | 의식을 잃은 채 sleep으로 시간을 흘려도 점호 불복종 행적 | 확실 |
| 3 실패의 결과 | ★ `engine/storyletTools.ts:1280` raiseAlarm | 경보 이야기가 열렸을 때만 들킨 결과(들키지 않기 임무 깨짐, 침입 행적). 후보가 쿨다운이면 들켜도 아무 일 없음 | 확실 |
| 4 처지 | `opposition.ts:83-87`, `exploration.ts:168`, `helpless.ts:94` | "위협 앞" 감염체를 저마다 다르게 (threatInScene은 동행 빼고 의식불명도 봄) | 확실 |
| | `storyletTools.ts:1200` runTagEvent | 자는 중·의식불명에도 몰려든 감염체 이야기가 열림 | 추정 |
| | `storylets.ts:477`, `turnStart.ts:63` | 의식불명이면 이야기 목록을 통째로 비워 situation의 누움 분기가 안 쓰임 | 확실(의도 추정) |
| 5 쉬기 | `story/storylets.ts:741` roadStorylets | 경보 이야기 쉬기(3일)가 실제 경보 경로(raiseAlarm → road)에 없음 | 확실 |
| 6 걸린 판정 | `engine/checks.ts:170` | `stakes`를 넘기지 않는 판정(연애·흥정·통솔·외교·잠입 등)은 늘 경험치. 테스트는 `stakes:` 문자열만 봄 | 확실 |
| | `storyletTools.ts` hostileZone / `warTools.ts:283` / `command.ts:91` | "적 땅"을 세 가지로 정함 (태도 -1인 땅: 경보는 걸리는데 GM 화면은 적 땅이 아님) | 확실 |
| 7 본 대로 | ★ `engine/reputationTools.ts:135` | 장면의 목격자가 동물만 뺀다: 죽은 사람·의식불명·갇힌 사람도 "본다" → 기절시킨 경비가 경보·원망 | 확실 |
| | `reputationTools.ts:328` spread_rumor | 의식불명 증상인 사람도 소문을 들음 | 확실 |
| 8 곁의 사람 | ★ `engine/care/kinds.ts:27` healerFor | 죽은 치료사·의식불명·갇힌 치료사도 치료 | 확실 |
| | `fear.ts:65`, `body.ts:775`, `forage.ts:84` | 끌고 가는 포로·의식불명·갇힌 동행도 "곁에 있다"로 공포·마음이 쉼 | 확실 |
| | `command.ts:419` squadFollowBonus | 부르는 곳 없는 죽은 코드 | 확실 |
| 11 우리 땅 | `helpless.ts:98` | 지금 주인 없는 땅이면 처음 주인이 쓰러진 나를 찾아냄 | 확실 |
| | `storyletTools.ts:801`, `captivity.ts:38` baseOf, `care/fee.ts:30`, `missionTools.ts` 등 | 거점을 콘텐츠의 처음 주인으로 찾음: 거점이 함락되면 "집으로 돌아왔다"가 적 거점 | 확실(함락 때만) |
| 13 피해의 셈 | `helpless.ts:116` | 쓰러진 사이 감염체에게 물려도 방어구가 안 막음 | 확실 |
| | `agenda.ts:71` | 인물의 일로 사람을 죽일 때 버팀·보호를 안 거침 | 확실 |
| 14 소식이 닿는 길 | ★ `engine/battleTools.ts:89, 229` reportClash | 갇혀 있어도 우리 무리 교전 소식이 "전해 들음"으로 (12-243이 고친 버그가 이 경로에 남음) | 확실 |
| | `diplomacy.ts:161`, `agenda.ts:76`, `people.ts:218`, `factionTalk.ts:101` | 휴전 끝·인물의 일·현상금 소식이 갇혀 있어도 닿음 | 확실 |
| 17 이야기의 자리 | `camp.ts:101`, `broadcast.ts:36`, runTagEvent | 위급할 때도 야영·무전 이야기 (일부는 "한 일의 결과"라 의도) | 추정 |
| 시간·판정과 스킬·남의 물건 | `companions.ts:115`, `commands.ts:79`, `scavenge.ts:31`, `care/fee.ts:115` 등 | 지금은 결과가 같다 (다시 짠 계산) | 확실(결과 같음) |
| 9 바뀐 것 알리기, 16 자기다움 | 우회 못 찾음 | | |

## guards.test.ts에 더할 막기 (제안)

- 규칙 1: `.quarantine`·`.releaseAt`을 held.ts·quarantine.ts·state.ts 밖에서 읽지 않는다. held.ts에 `heldByEnemy` 같은 함수
- 규칙 6: rollPlayerCheck의 `stakes`를 필수로
- 규칙 7·8: `scene.present.filter`로 목격자·듣는 사람·치료사를 고르는 곳, `state.companions.length`·`activeCompanions(state).length`를 company.ts 밖에서 막는다
- 규칙 11: 처음 주인으로 거점 찾기(`l.owner === … && l.kind === "base"`)를 home.ts 밖에서 막는다, "적 땅"을 한 함수로
- 규칙 14: news.ts 밖에서 주인공에게 `source: "report"`·`"rumor"` belief_added를 넣지 않는다
- 규칙 17: `roadStorylets(`·`storylet_pacing.`을 storySlot.ts·storylets.ts 밖에서 막는다
- 시간: rules/time.ts 밖에서 `/ 1440`, `/ (24 * 60)`
