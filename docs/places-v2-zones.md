# 장소 개편: 구역별 장소표 (초안)

2026-11-23. `docs/places-v2-plan.md`의 2단계(콘텐츠). 사용자가 확인한 뒤 YAML로 옮긴다.
사용자 요청: 구역마다 길 1~3개보다 더 많이, 바깥 장소(초소, 서쪽 길, 동쪽 길 등)도 다양하게.

## 읽는 법

- **굵게** = 새 장소. 나머지는 지금 있는 장소(id 그대로)
- 길(🛣)은 구역에 들어올 때 도착하는 곳. `to`는 그 길로 이어지는 구역. 방향은 지도 좌표(`map`)로 셌다
- 깊이: 잠입 깊이. 0 담 밖, 1 담 안, 2 깊은 곳 (아래 "정할 것 1")
- 이웃(near)은 한쪽에만 적어도 로더가 양쪽으로 맞춘다. 표에는 한쪽만 적었다
- 지도 방향이 지금 글과 어긋나는 곳은 ⚠ (예: "동쪽 초소"가 지도에서는 거점 북쪽)

## 1. 청솔형제단 거점 `a_base` (학교, 우리 거점)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **north_road** 🛣 | 북쪽 길 (초소·고가 쪽) | 바깥 | 0 | checkpoint | a_east_post, overpass |
| **west_road** 🛣 | 서쪽 길 (구시가 쪽) | 바깥 | 0 | checkpoint | old_town |
| **east_road** 🛣 | 동쪽 길 (강변 쪽) | 바깥 | 0 | back_gap | riverside |
| **south_road** 🛣 | 남쪽 길 (버들마을·텃밭 쪽) | 바깥 | 0 | back_gap | b_base, south_fields |
| **checkpoint** | 정문 앞 1번 초소 (바리케이드) | 바깥 | 0 | yard_gate | |
| **back_gap** | 뒷담 쪽문 | 바깥 | 0 | yard_gate | |
| yard_gate | 운동장·정문·담장 | 바깥 | 1 | mess, barracks, storehouse, staff_room, infirmary, stockade | |
| staff_room·infirmary·barracks·mess·storehouse | (그대로) | 실내 | 2 | yard_gate | |
| stockade | 수용소 | 실내 | 2 | yard_gate | |

⚠ 지도에서 동쪽 초소는 거점 북쪽이다. 길 이름을 "초소 가는 길"로 할지, 지도를 고칠지

## 2. 동쪽 초소 `a_east_post`

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **base_road** 🛣 | 거점 가는 길 | 바깥 | 0 | watchtower | a_base |
| **overpass_view** 🛣 | 고가도로 내려다보는 비탈 | 바깥 | 0 | watchtower | c_warehouse |
| **trench** | 모래주머니 참호 | 바깥 | 0 | watchtower, bunker | |
| watchtower | 망루 | 바깥 | 1 | bunker | |
| bunker | 초소 안·창고 | 실내 | 2 | | |

## 3. 구시가 `old_town` (빈 땅, 이웃 구역 여덟)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **east_street** 🛣 | 동쪽 큰길 | 바깥 | 0 | alleys, crossroads | a_base, c_base, overpass |
| **west_street** 🛣 | 서쪽 큰길 | 바깥 | 0 | crossroads | hospital_ruins, b_base, d_clinic |
| **hill_steps** 🛣 | 언덕 계단 | 바깥 | 0 | crossroads | cathedral |
| **subway_entrance** 🛣 | 지하철 입구 | 바깥 | 0 | crossroads | subway_hub |
| **crossroads** | 시장 앞 네거리 (뒤집힌 버스) | 바깥 | 0 | alleys | |
| alleys | 시장 골목 | 바깥 | 0 | shops, boiler_room | |
| shops | 상가·약국 안 | 실내 | 1 | basement | |
| boiler_room | 목욕탕 보일러실 | 실내 | 1 | | |
| basement | 상가 지하 | 실내 | 2 | | |

## 4. 강변 공장 지대 `riverside` (빈 땅, 이웃 여덟)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **west_road** 🛣 | 서쪽 공단 길 | 바깥 | 0 | factory_gate | a_base, subway_hub, overpass |
| **north_road** 🛣 | 북쪽 둑길 | 바깥 | 0 | factory_gate, bank | c_warehouse, power_plant |
| **south_road** 🛣 | 남쪽 강둑길 | 바깥 | 0 | bank | e_market, water_plant |
| **ferry** 🛣 | 나룻배 대는 곳 | 바깥 | 0 | bank | yeoul_isle |
| **factory_gate** | 공장 정문·트럭 차고 | 바깥 | 0 | factory | |
| bank | 강가 | 바깥 | 0 | pumphouse_cellar | |
| factory | 공장 건물 안 | 실내 | 1 | | |
| pumphouse_cellar | 옛 양수장 지하 | 실내 | 2 | | |

## 5. 버들마을 거점 `b_base` (아파트, 다른 무리 거점)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **north_road** 🛣 | 북쪽 길 (청솔·구시가·성당 쪽) | 바깥 | 0 | gate_front | a_base, old_town, cathedral |
| **east_road** 🛣 | 동쪽 길 (텃밭·마트 쪽) | 바깥 | 0 | side_lane | south_fields, mall_ruins |
| **gate_front** | 정문 앞 검문 줄 | 바깥 | 0 | gate | |
| **side_lane** | 쪽문 밖 골목 | 바깥 | 0 | gate | |
| gate | 정문·경비실·쪽문 | 바깥 | 1 | yard, office, blocks | |
| yard | 단지 텃밭·우물 | 바깥 | 1 | blocks | |
| rooftop_watch | 102동 옥상 망루 | 바깥 | 2 | blocks | |
| office·blocks | (그대로) | 실내 | 2 | | |
| lockup | 관리동 지하 가두는 방 | 실내 | 2 | office | |

## 6. 고가도로 너머 물류창고 `c_warehouse` (붉은연합)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **south_road** 🛣 | 남쪽 고가 밑 길 | 바깥 | 0 | checkpoint_3 | a_east_post, riverside |
| **west_road** 🛣 | 서쪽 길 (거점 쪽) | 바깥 | 0 | checkpoint_3 | c_base |
| **north_road** 🛣 | 북쪽 길 (발전소 쪽) | 바깥 | 0 | container_gap | power_plant |
| **checkpoint_3** | 3번 초소 (정문 앞 검문) | 바깥 | 0 | yard, wall | |
| **container_gap** | 컨테이너 담 틈 | 바깥 | 0 | wall | |
| wall | 감시탑·담 | 바깥 | 1 | yard | |
| yard | 창고 마당 | 바깥 | 1 | barracks, command, stockade | |
| barracks·command | (그대로) | 실내 | 2 | | |
| stockade | 수용소 | 실내 | 2 | | |

## 7. 붉은연합 거점 `c_base` (공단)

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **east_road** 🛣 | 동쪽 길 (물류창고 쪽) | 바깥 | 0 | checkpoint_1 | c_warehouse |
| **southwest_road** 🛣 | 남서쪽 길 (구시가 쪽) | 바깥 | 0 | checkpoint_1 | old_town |
| **north_road** 🛣 | 북쪽 길 (교도소 쪽) | 바깥 | 0 | range_fence | prison |
| **checkpoint_1** | 1번 초소 (철조망 정문) | 바깥 | 0 | yard | |
| **range_fence** | 사격장 철조망 밖 | 바깥 | 0 | wall | |
| yard·wall | (그대로) | 바깥 | 1 | barracks, office_block, kitchen, armory, cells | |
| barracks·office_block·kitchen·armory | (그대로) | 실내 | 2 | | |
| cells | 철망 감방 | 실내 | 2 | | |

## 8. 하얀매의 진료소 `d_clinic`

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **north_road** 🛣 | 북쪽 길 (병원·캠퍼스·구시가 쪽) | 바깥 | 0 | queue | old_town, hospital_ruins, campus |
| **queue** | 문 밖 기다리는 줄 | 바깥 | 0 | gate | |
| **back_alley** | 뒷골목 | 바깥 | 0 | back_wall, north_road | |
| gate | 정문·접수대·마당 | 바깥 | 1 | ward, pharmacy, lodging, quarantine, director_room | |
| back_wall | 뒷담·쪽문 | 바깥 | 1 | lodging, lockup | |
| 실내 다섯 + lockup | (그대로) | 실내 | 2 | | |

## 9. 나루상단의 장터 `e_market`

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **north_road** 🛣 | 북쪽 큰길 (강변·휴게소 쪽) | 바깥 | 0 | stalls, wagon_yard | riverside, rest_stop |
| **riverbank_path** 🛣 | 강둑 오솔길 (정수장 쪽) | 바깥 | 0 | landing | water_plant |
| stalls | 장터 좌판·천막 | 바깥 | 0 | pawnshop, bunkhouse | |
| wagon_yard | 짐마차 마당 | 바깥 | 1 | bunkhouse | |
| landing | 선착장 | 바깥 | 0 | stalls | |
| pawnshop·bunkhouse | (그대로) | 실내 | 1 | | |
| lockup | 전당포 지하실 | 실내 | 2 | pawnshop | |

장터는 담이 없어 좌판까지 깊이 0으로 했다.

## 10. 옛 시립병원 `hospital_ruins`

| id | 이름 | 실내 | 깊이 | 이웃 | to |
|---|---|---|---|---|---|
| **east_road** 🛣 | 동쪽 길 (구시가 쪽) | 바깥 | 0 | yard | old_town |
| **south_road** 🛣 | 남쪽 길 (진료소 쪽) | 바깥 | 0 | yard | d_clinic |
| **north_road** 🛣 | 북쪽 언덕길 (캠퍼스 쪽) | 바깥 | 0 | annex | campus |
| **annex** | 별관 장례식장 | 실내 | 1 | yard | |
| yard | 병원 마당 | 바깥 | 0 | lobby | |
| lobby | 입구·응급실 | 실내 | 1 | stairs_basement | |
| stairs_basement | 비상계단·지하 약제실 | 실내 | 2 | | |

(묘지기 엄태식의 일과 "별관 장례식장"이 장소가 된다)

## 11~21. 나머지 구역

| 구역 | 새 장소 (🛣 = 길, to) | 지금 장소 |
|---|---|---|
| 정수장 `water_plant` | 🛣 **north_bank** 북쪽 둑길 (riverside), 🛣 **south_bank** 남쪽 둑길 (e_market), 🛣 **dock** 작은 나루 (yeoul_isle), **settling_tank** 침전조 | pump_room, waterside |
| 남쪽 텃밭 `south_fields` | 🛣 **north_path** 북쪽 밭길 (a_base), 🛣 **west_path** 서쪽 밭길 (b_base, mall_ruins), **scarecrow_post** 허수아비 망보는 자리 | field, hut, south_wall |
| 여울섬 `yeoul_isle` | 🛣 dock(지금 부두)이 길이 된다 (riverside, water_plant), **stone_wall** 돌담·망루, **workshop** 탄약 공방(실내) | council_hall, quarters, farm_shore, lockup |
| 지하철 환승역 `subway_hub` | 🛣 **exit_northwest** 북서 출구 (old_town), 🛣 **tunnel_east** 동쪽 터널 (riverside), 🛣 **tunnel_southwest** 남서 터널 (mall_ruins) | concourse, platform |
| 대형 마트 `mall_ruins` | 🛣 **avenue** 남쪽 대로 (b_base, south_fields), 🛣 **subway_stairs** 지하철 계단 (subway_hub), **loading_dock** 하역장 뒤 골목 | sales_floor, stockroom, parking |
| 화력발전소 `power_plant` | 🛣 **south_road** 남쪽 길 (riverside, c_warehouse), 🛣 **highway_ramp** 고속도로 진입로 (rest_stop), 🛣 **west_road** 서쪽 길 (prison), **chimney** 굴뚝 밑 | coal_yard, turbine_hall |
| 북쪽 교도소 `prison` | 🛣 **east_road** 동쪽 길 (power_plant), 🛣 **south_road** 남쪽 길 (c_base), **outer_gate** 바깥 정문·면회소 | cellblock, admin, yard |
| 언덕 위 성당 `cathedral` | 🛣 **hill_steps** 언덕 계단 (old_town, b_base), 🛣 **west_path** 서쪽 오솔길 (campus), **front_steps** 성당 앞 계단 | nave, bell_tower, churchyard |
| 캠퍼스 `campus` | 🛣 **east_gate** 동쪽 교문 (cathedral), 🛣 **south_gate** 남쪽 교문 (d_clinic, hospital_ruins), **quad** 잔디 광장 | library, lab, greenhouse |
| 고속도로 휴게소 `rest_stop` | 🛣 tollgate(지금 톨게이트)가 길이 된다 (power_plant), 🛣 **service_road** 뒷길 (e_market), **parking_lot** 화물차 주차장 | canopy, diner |
| 무너진 고가도로 `overpass` | 🛣 **ramp_southeast** 남동쪽 진입로 (a_base, riverside), 🛣 **ramp_southwest** 남서쪽 진입로 (old_town), **car_line** 버려진 차 행렬 | deck, underpass |

나머지 구역의 이웃·깊이는 확인을 받은 뒤 같은 모양의 표로 펼친다. 빈 땅은 대개 길·바깥 장소가 깊이 0, 실내가 1, 지하·가장 안쪽이 2다.

## 정할 것

1. **잠입 깊이를 어떻게 적을까.** 바깥 장소(초소·쪽문 밖·검문 줄)를 더하면 "길에서 몇 칸"이 담과 맞지 않는다. 1번 초소는 길에서 한 칸인데 아직 담 밖이다.
   - 권장: 장소마다 `depth`(0 담 밖, 1 담 안, 2 깊은 곳)를 콘텐츠에 적는다. 적지 않으면 길에서 몇 칸으로 어림한다. content:check는 이웃끼리 깊이가 2 넘게 뛰지 않는지 본다
   - 다른 안: 담을 지나는 장소에 `gate: true`를 적고, 깊이는 "길에서 문까지 0, 문 너머 칸수"로 센다
2. **지도 방향과 글이 어긋나는 곳** (⚠ 동쪽 초소가 지도에서는 거점 북쪽): 길 이름을 행선지로 짓는가(권장), 지도 좌표를 고치는가
3. 구역마다 장소 수는 지금 2~8개에서 5~11개가 된다. 더 늘리거나 줄일 구역이 있는가
