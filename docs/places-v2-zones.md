# 장소 개편: 구역별 장소표 (초안 2)

2026-11-23. `docs/places-v2-plan.md`의 2단계(콘텐츠). 사용자가 확인한 뒤 YAML로 옮긴다.

## 정한 것 (사용자)

- 구역마다 길과 바깥 장소를 넉넉히 (초소, 쪽문 밖, 검문 줄 등)
- 길 이름은 행선지로 ("구시가 가는 길")
- 잠입 깊이는 **gate**로 센다: 담을 지나 처음 닿는 장소에 `gate: true`. 길에서 gate를 거치지 않고 닿는 곳은 0(담 밖), gate는 1(담 안), gate 너머는 1 + gate에서 몇 칸(2에서 멈춤). gate가 없는 구역(담 없는 땅)은 길에서 몇 칸(2에서 멈춤)
- 장소 사이 이동과 잠입 중 이동은 이웃(near)으로만. 더 깊은 이웃으로 가면 한 칸 들어간 것, 같은 깊이 이웃은 숨기 판정만 하고 깊이는 그대로

## 읽는 법

- **굵게** = 새 장소, 나머지는 지금 있는 장소(id 그대로). 🛣 = 길(구역에 들어오면 도착하는 곳), 🚪 = gate
- 깊이는 위 규칙으로 계산한 값 (콘텐츠에 적지 않는다)
- 이웃은 한쪽에만 적었다 (로더가 양쪽으로 맞춘다)

## 1. 청솔형제단 거점 `a_base` (담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_post** 초소·고가 가는 길 | 바깥 | 0 | wall_path | a_east_post, overpass |
| 🛣 **to_old_town** 구시가 가는 길 | 바깥 | 0 | wall_path | old_town |
| 🛣 **to_riverside** 강변 가는 길 | 바깥 | 0 | wall_path | riverside |
| 🛣 **to_south** 버들마을·텃밭 가는 길 | 바깥 | 0 | wall_path | b_base, south_fields |
| **wall_path** 담 밖 둘레길 | 바깥 | 0 | checkpoint, back_gap | |
| **checkpoint** 정문 앞 1번 초소 | 바깥 | 0 | yard_gate | |
| 🚪 yard_gate 운동장·정문·담장 | 바깥 | 1 | mess, barracks, storehouse, staff_room, infirmary, stockade | |
| 🚪 **back_gap** 뒷담 쪽문 | 바깥 | 1 | yard_gate, barracks | |
| staff_room 교무실 · infirmary 의무실 · barracks 막사 · mess 식당 천막 · storehouse 보급 창고·무기고 | 실내 | 2 | | |
| stockade 수용소 (가둠) | 실내 | 2 | | |

## 2. 동쪽 초소 `a_east_post` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_base** 거점 가는 길 | 바깥 | 0 | trench, watchtower | a_base |
| 🛣 **to_warehouse** 물류창고 가는 비탈 | 바깥 | 0 | trench | c_warehouse |
| **trench** 모래주머니 참호 | 바깥 | 1 | watchtower, bunker | |
| watchtower 망루 | 바깥 | 1 | bunker | |
| bunker 초소 안·창고 | 실내 | 2 | | |

## 3. 구시가 `old_town` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_east** 청솔·붉은연합·고가 가는 길 | 바깥 | 0 | crossroads, alleys | a_base, c_base, overpass |
| 🛣 **to_west** 병원·진료소·버들마을 가는 길 | 바깥 | 0 | crossroads | hospital_ruins, d_clinic, b_base |
| 🛣 **hill_steps** 성당 가는 언덕 계단 | 바깥 | 0 | crossroads | cathedral |
| 🛣 **subway_entrance** 지하철 입구 | 바깥 | 0 | crossroads | subway_hub |
| **crossroads** 시장 앞 네거리 (뒤집힌 버스) | 바깥 | 1 | alleys | |
| alleys 시장 골목 | 바깥 | 1 | shops, boiler_room | |
| shops 상가·약국 안 | 실내 | 2 | basement | |
| boiler_room 목욕탕 보일러실 | 실내 | 2 | | |
| basement 상가 지하 | 실내 | 2 | | |

## 4. 강변 공장 지대 `riverside` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_west** 청솔·환승역·고가 가는 공단 길 | 바깥 | 0 | factory_gate | a_base, subway_hub, overpass |
| 🛣 **to_north** 물류창고·발전소 가는 둑길 | 바깥 | 0 | factory_gate, bank | c_warehouse, power_plant |
| 🛣 **to_south** 장터·정수장 가는 강둑길 | 바깥 | 0 | bank | e_market, water_plant |
| 🛣 **ferry** 여울섬 나룻배 대는 곳 (물가) | 바깥 | 0 | bank | yeoul_isle |
| **factory_gate** 공장 정문·트럭 차고 | 바깥 | 1 | factory | |
| bank 강가 | 바깥 | 1 | pumphouse_cellar | |
| factory 공장 건물 안 | 실내 | 2 | | |
| pumphouse_cellar 옛 양수장 지하 | 실내 | 2 | | |

## 5. 버들마을 거점 `b_base` (담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_north** 청솔·구시가·성당 가는 길 | 바깥 | 0 | gate_front | a_base, old_town, cathedral |
| 🛣 **to_east** 텃밭·마트 가는 길 | 바깥 | 0 | gate_front, side_lane | south_fields, mall_ruins |
| **gate_front** 정문 앞 검문 줄 | 바깥 | 0 | gate | |
| **side_lane** 쪽문 밖 골목 | 바깥 | 0 | yard | |
| 🚪 gate 정문·경비실 | 바깥 | 1 | office, blocks, yard | |
| 🚪 yard 단지 텃밭·우물 (쪽문 안) | 바깥 | 1 | blocks | |
| office 관리사무소 · blocks 101~103동 집·계단 | 실내 | 2 | | |
| rooftop_watch 102동 옥상 망루 | 바깥 | 2 | blocks | |
| lockup 관리동 지하 가두는 방 (가둠) | 실내 | 2 | office | |

(지금 "정문·경비실·쪽문"에서 쪽문을 텃밭 쪽으로 옮긴다)

## 6. 고가도로 너머 물류창고 `c_warehouse` (붉은연합, 담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_south** 초소·강변 가는 고가 밑 길 | 바깥 | 0 | checkpoint_3 | a_east_post, riverside |
| 🛣 **to_west** 붉은연합 거점 가는 길 | 바깥 | 0 | checkpoint_3 | c_base |
| 🛣 **to_north** 발전소 가는 길 | 바깥 | 0 | container_gap | power_plant |
| **checkpoint_3** 3번 초소 (정문 앞 검문) | 바깥 | 0 | yard | |
| **container_gap** 컨테이너 담 틈 | 바깥 | 0 | wall | |
| 🚪 yard 창고 마당 | 바깥 | 1 | barracks, command, stockade, wall | |
| 🚪 wall 감시탑·담 | 바깥 | 1 | | |
| barracks 막사·취사 천막 · command 지휘소·정비소 | 실내 | 2 | | |
| stockade 수용소 (가둠) | 실내 | 2 | | |

## 7. 붉은연합 거점 `c_base` (담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_warehouse** 물류창고 가는 길 | 바깥 | 0 | checkpoint_1 | c_warehouse |
| 🛣 **to_old_town** 구시가 가는 길 | 바깥 | 0 | checkpoint_1 | old_town |
| 🛣 **to_prison** 교도소 가는 길 | 바깥 | 0 | range_fence | prison |
| **checkpoint_1** 1번 초소 (철조망 정문 앞) | 바깥 | 0 | yard | |
| **range_fence** 사격장 철조망 밖 | 바깥 | 0 | wall | |
| 🚪 yard 광장·창고 앞 | 바깥 | 1 | barracks, office_block, kitchen, armory, cells, wall | |
| 🚪 wall 담·감시탑·사격장 | 바깥 | 1 | | |
| barracks · office_block · kitchen · armory | 실내 | 2 | | |
| cells 철망 감방 (가둠) | 실내 | 2 | | |

## 8. 하얀매의 진료소 `d_clinic` (담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_north** 병원·캠퍼스·구시가 가는 길 | 바깥 | 0 | queue, back_alley | old_town, hospital_ruins, campus |
| **queue** 문 밖 기다리는 줄 | 바깥 | 0 | gate | |
| **back_alley** 뒷골목 | 바깥 | 0 | back_wall | |
| 🚪 gate 정문·접수대·마당 | 바깥 | 1 | ward, pharmacy, lodging, quarantine, director_room | |
| 🚪 back_wall 뒷담·쪽문 | 바깥 | 1 | lodging, lockup | |
| ward · pharmacy · quarantine · lodging · director_room | 실내 | 2 | | |
| lockup 잠긴 뒤창고 (가둠) | 실내 | 2 | | |

## 9. 나루상단의 장터 `e_market` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_north** 강변·휴게소 가는 큰길 | 바깥 | 0 | stalls, wagon_yard | riverside, rest_stop |
| 🛣 **to_water_plant** 정수장 가는 강둑 오솔길 | 바깥 | 0 | landing | water_plant |
| stalls 장터 좌판·천막 | 바깥 | 1 | pawnshop, landing | |
| wagon_yard 짐마차 마당 | 바깥 | 1 | bunkhouse | |
| landing 선착장 | 바깥 | 1 | | |
| pawnshop 전당포·장부석 · bunkhouse 호위·짐꾼 막사 | 실내 | 2 | | |
| lockup 전당포 지하실 (가둠) | 실내 | 2 | pawnshop | |

## 10. 옛 시립병원 `hospital_ruins` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_old_town** 구시가 가는 길 | 바깥 | 0 | yard | old_town |
| 🛣 **to_clinic** 진료소 가는 길 | 바깥 | 0 | yard | d_clinic |
| 🛣 **to_campus** 캠퍼스 가는 언덕길 | 바깥 | 0 | annex | campus |
| yard 병원 마당 | 바깥 | 1 | lobby, annex | |
| **annex** 별관 장례식장 | 실내 | 1 | | |
| lobby 입구·응급실 | 실내 | 2 | stairs_basement | |
| stairs_basement 비상계단·지하 약제실 | 실내 | 2 | | |

## 11. 정수장 `water_plant` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_riverside** 강변 가는 둑길 | 바깥 | 0 | settling_tank | riverside |
| 🛣 **to_market** 장터 가는 둑길 | 바깥 | 0 | waterside | e_market |
| 🛣 **ferry** 여울섬 가는 작은 나루 (물가) | 바깥 | 0 | waterside | yeoul_isle |
| **settling_tank** 침전조 | 바깥 | 1 | pump_room | |
| waterside 물가·나루 | 바깥 | 1 | pump_room | |
| pump_room 펌프실 | 실내 | 2 | | |

## 12. 남쪽 텃밭 `south_fields` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_base** 청솔 거점 가는 밭길 | 바깥 | 0 | field | a_base |
| 🛣 **to_west** 버들마을·마트 가는 밭길 | 바깥 | 0 | field, south_wall, scarecrow_post | b_base, mall_ruins |
| field 밭고랑 | 바깥 | 1 | hut | |
| **scarecrow_post** 허수아비 망보는 자리 | 바깥 | 1 | field | |
| south_wall 무너진 남쪽 담장 | 바깥 | 1 | | |
| hut 움막 | 실내 | 2 | | |

## 13. 여울섬 `yeoul_isle` (돌담 있음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 dock 부두·검역 막사 (지금 장소가 길이 된다) | 바깥 | 0 | farm_shore, stone_wall | riverside, water_plant |
| farm_shore 양식장·텃밭·바닷가 | 바깥 | 0 | | |
| 🚪 **stone_wall** 돌담 문·망루 | 바깥 | 1 | council_hall, quarters, workshop, lockup | |
| council_hall 의회 회관·식당 · quarters 관사·숙소 | 실내 | 2 | | |
| **workshop** 탄약 공방 | 실내 | 2 | | |
| lockup 등대 밑 창고 (가둠) | 실내 | 2 | | |

## 14. 지하철 환승역 `subway_hub` (담 없음, 길이 실내)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_old_town** 구시가 가는 출구 계단 | 바깥 | 0 | concourse | old_town |
| 🛣 **tunnel_east** 강변 가는 터널 | 실내 | 0 | platform | riverside |
| 🛣 **tunnel_southwest** 마트 가는 터널 | 실내 | 0 | platform | mall_ruins |
| concourse 개찰구·지하상가 | 실내 | 1 | platform | |
| platform 승강장·터널 | 실내 | 1 | | |

(길은 바깥이 원칙이지만 터널은 실내로 둔다)

## 15. 대형 마트 폐허 `mall_ruins` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **avenue** 버들마을·텃밭 가는 대로 | 바깥 | 0 | parking, loading_dock | b_base, south_fields |
| 🛣 **subway_stairs** 환승역 가는 지하철 계단 | 바깥 | 0 | sales_floor | subway_hub |
| parking 주차장 | 바깥 | 1 | sales_floor | |
| **loading_dock** 하역장 뒤 골목 | 바깥 | 1 | stockroom | |
| sales_floor 매장 | 실내 | 1 | stockroom | |
| stockroom 무너진 창고·하역장 | 실내 | 2 | | |

## 16. 화력발전소 터 `power_plant` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_south** 강변·물류창고 가는 길 | 바깥 | 0 | coal_yard | riverside, c_warehouse |
| 🛣 **highway_ramp** 휴게소 가는 고속도로 진입로 | 바깥 | 0 | coal_yard | rest_stop |
| 🛣 **to_prison** 교도소 가는 길 | 바깥 | 0 | chimney | prison |
| coal_yard 저탄장 | 바깥 | 1 | turbine_hall, chimney | |
| **chimney** 굴뚝 밑 | 바깥 | 1 | | |
| turbine_hall 발전동·사무동 | 실내 | 2 | | |

## 17. 북쪽 교도소 `prison` (담 있음, 주인 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **to_power_plant** 발전소 가는 길 | 바깥 | 0 | outer_gate | power_plant |
| 🛣 **to_red_base** 붉은연합 거점 가는 길 | 바깥 | 0 | outer_gate | c_base |
| **outer_gate** 바깥 정문·면회소 | 바깥 | 0 | yard | |
| 🚪 yard 운동장·담 | 바깥 | 1 | admin, cellblock | |
| admin 행정동·무기고 | 실내 | 2 | | |
| cellblock 감방동 (가둠) | 실내 | 2 | | |

## 18. 언덕 위 성당 `cathedral` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **hill_steps** 구시가·버들마을 가는 언덕 계단 | 바깥 | 0 | front_steps | old_town, b_base |
| 🛣 **to_campus** 캠퍼스 가는 오솔길 | 바깥 | 0 | churchyard | campus |
| **front_steps** 성당 앞 계단 | 바깥 | 1 | nave, churchyard | |
| churchyard 뒤뜰·묘지 | 바깥 | 1 | | |
| nave 성당 안 | 실내 | 2 | bell_tower | |
| bell_tower 종탑 | 실내 | 2 | | |

## 19. 가람대학교 캠퍼스 `campus` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **east_gate** 성당 가는 동쪽 교문 | 바깥 | 0 | quad | cathedral |
| 🛣 **south_gate** 진료소·병원 가는 남쪽 교문 | 바깥 | 0 | quad | d_clinic, hospital_ruins |
| **quad** 잔디 광장 | 바깥 | 1 | library, lab, greenhouse | |
| library 도서관 · lab 약대 실험실 · greenhouse 농대 온실 | 실내 | 2 | | |

## 20. 고속도로 휴게소 `rest_stop` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 tollgate 톨게이트 (지금 장소가 길이 된다, 발전소 가는 고속도로) | 바깥 | 0 | canopy, parking_lot | power_plant |
| 🛣 **to_market** 장터 가는 뒷길 | 바깥 | 0 | canopy | e_market |
| canopy 주유소 지붕 밑 | 바깥 | 1 | diner | |
| **parking_lot** 화물차 주차장 | 바깥 | 1 | | |
| diner 휴게소 식당 안 | 실내 | 2 | | |

## 21. 무너진 고가도로 `overpass` (담 없음)

| 장소 | 실내 | 깊이 | 이웃 | 이어지는 구역 |
|---|---|---|---|---|
| 🛣 **ramp_southeast** 청솔·강변 가는 진입로 | 바깥 | 0 | deck, underpass | a_base, riverside |
| 🛣 **ramp_southwest** 구시가 가는 진입로 | 바깥 | 0 | underpass | old_town |
| deck 고가 위 | 바깥 | 1 | car_line | |
| underpass 고가 밑 | 바깥 | 1 | | |
| **car_line** 버려진 차 행렬 | 바깥 | 2 | | |

## 숫자

- 구역 21, 장소 지금 82 → 약 158 (새 장소 약 76: 길 50, 그 밖 26. 지금 장소 둘이 길이 된다)
- gate가 있는 구역 7 (청솔·버들마을·물류창고·붉은연합·진료소·여울섬·교도소)
- 새 장소마다 묘사(description) 한 줄과 일과용 별칭(aliases)은 YAML로 옮길 때 적는다
