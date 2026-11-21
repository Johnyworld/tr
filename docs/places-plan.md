# 구역별 장소(실내/바깥) 근거 조사

## 출처와 세는 법
- 플레이 기록: 세이브 30개(`.../fc4f4bbb.../scratchpad/pt/*/saves/worlds/*.db`)의 `turn_started.input` 2,904턴. `zone_moved`로 그때 구역을 따라가며 장소 낱말이 든 입력 수를 셈(=PT). 세이브에 서술 요약 이벤트는 없음(입력만). `docs/playtests/*.md` 전체에서 낱말 출현 수도 따로 셈(=MD).
- 이야기: `storylets/*.yaml` 893개 중 `when.zones`가 있는 419개의 setup 문장에서 장소 낱말 셈(=ST). zones 없는 474개는 "아무 데나".
- NPC: `npcs/*.yaml` routine 값을 zone별로 모음(=NPC, 시간대 칸 수).
- 주의: "다리"(신체/교량), "담"(담배·담장), "방"은 부풀려짐. "줄"(배급 줄)은 대부분 줄글.

구역별 턴 수(PT 분모): a_base 429, yeoul_isle 306, b_base 290, d_clinic 284, old_town 278, c_base 229, c_warehouse 224, riverside 210, e_market 154, hospital_ruins 137, a_east_post 89, south_fields 43, mall_ruins 36, subway_hub 34, cathedral 34, power_plant 34, overpass 31, water_plant 22, campus 16, rest_stop 13, prison 11.

표기: `id 이름 (indoor) — PT/ST/NPC` · ← 대응하는 기존 routine 문자열

---

## 거점

### a_base 청솔형제단 거점 (옛 공업고, 턴 429, 이야기 87)
- `staff_room` 교무실 (true) — PT 0 / ST 9 / NPC 7 ← 교무실, 교무실 옆 작은 방, 교무실 앞 대기, 지도부 회의(5)
- `infirmary` 의무실 (true) — PT 33 / ST 1+ / NPC 3 ← 의무실
- `barracks` 막사(교실 개조) (true) — PT 48 / ST 6 / NPC 13 ← 막사, 막사 구석, 막사 구석 침상, 간부 숙소, 분대 훈련(실내면)
- `mess` 식당 천막 (false, 천막·지붕만) — PT 22 / ST 8 / NPC 10 ← 식당 천막, 식당 천막 구석·설거지, 배식, 불 피우기
- `storehouse` 보급 창고·무기고 (true) — PT 25(창고)+16(보급) / ST 23(창고)+5 / NPC 12 ← 보급 창고(정리·뒷문·대장 맞추기), 창고 경비(보조), 창고 앞 보초, 무기고, 발전기실, 공작실, 총기 손질
- `yard_gate` 운동장·정문·담장 (false) — PT 26(정문)+4(운동장)+7(담장)+6(망루) / ST 12(정문)+3 / NPC 10 ← 정문, 남쪽 담장 순찰·보수, 담장 순찰·보수, 망루, 거점 순회, 막사 앞 모닥불·담배, 버들마을 쪽문 근처
- 수용소(NPC 6 "수용소")는 별도 장소 `stockade` (true) 후보. 운동장 한쪽 창고로 둘 수 있음.
- 화장실·교실: 근거 0 (교실은 PT 1). 넣지 않는 걸 권함.
- 구역 밖으로 빼야 할 routine: 남쪽 텃밭(·경비·울타리) 6 → south_fields, 동쪽 초소(·왕복) 2 → a_east_post, 장터나 버들마을 오가기·물자 호위 → 이동.

### b_base 버들마을 (옛 아파트, 턴 290, 이야기 92)
- `office` 관리사무소(+지하 교실·창고) (true) — PT 2+3(지하)+2(교실) / ST 8+4 / NPC 17 ← 관리사무소, 관리사무소 지하, 지하 교실(앞), 관리사무소 회의, 회의, 배급 줄·배급, 대표실, 대표 사무실 앞, 사무실, 마을 회관, 약초 창고
- `blocks` 101~103동 집·계단 (true) — PT 26(숙소)+5(계단) / ST 7(계단)+5 / NPC 21 ← 101동, 102동, 103동, 103동 계단, 102동 지하, 101동 지하, 102동 집, 집, 숙소, 103동 집집 돌기, 아이들 귀가, 단지 부엌(3)
- `rooftop_watch` 102동 옥상 망루 (false) — PT 6+4 / ST 4 / NPC 7 ← 102동 옥상 망루, 102동 옥상, 옥상 망루
- `gate` 정문·경비실·쪽문 (false, 경비실만 실내) — PT 22+13+7 / ST 13+5+7 / NPC 19 ← 정문(경비·교대·보조 당번), 정문 정찰대 집합, 경비실, 쪽문 점검·근처, 북쪽 쪽문(근처), 단지 순찰, 거점 순찰
- `yard` 단지 텃밭·우물 (false) — PT 16(우물)+11(밭) / ST 5 / NPC 10 ← 텃밭, 단지 텃밭, 우물 물 긷기, 아랫단 우물, 우물가
- 경비실을 따로 실내 장소로 둘지 검토(ST "경비실 난로 앞" 2건). 밖: 단지 밖 정찰·수색, 구시가 수색, 청솔 연락 → 이동.

### c_base 붉은연합 (옛 공단, 턴 229, 이야기 75)
- `barracks` 막사(벌조 막사 포함) (true) — PT 35 / ST 3 / NPC 13 ← 막사, 막사 순찰·점호·구석·화투판·옥상, 벌조 막사(점호)
- `office_block` 사무동(위원회·규율반) (true) — PT 0 / ST 2 / NPC 8 ← 공단 사무동, 사무동, 위원회(천막), 규율반 천막·사무실, 명부 정리
- `kitchen` 거점 부엌·배급 줄 (true) — PT 5(배식) / ST 5 / NPC 6 ← 거점 부엌, 부엌 뒷방, 배급 줄, 배식 줄
- `yard` 광장·창고 앞 검수 (false) — PT 28(창고)+22(보급) / ST 16+5 / NPC 7 ← 광장(연설·포고), 창고 앞 할당량 검수(참관), 쓰레기 수레 정리, 약탈조 출발
- `wall` 담·감시탑·사격장 (false) — PT 30(담)+7(망루)+5(감시탑) / ST 5 / NPC 6 ← 거점 담벼락, 거점 담 그늘, 사격장, 붉은연합 사격장, 고가도로 밑 연습장(구역 밖일 수 있음)
- `armory` 무기고 (true) — NPC 1 ← 붉은연합 무기고. 창고와 합쳐도 됨.

### d_clinic 하얀매 진료소 (옛 보건소, 턴 284, 이야기 74)
- `ward` 치료실·수술실 (true) — PT 10 / ST 3+ / NPC 11 ← 치료실(보조·약 내주기), 수술실(문 잠그고 혼자), 진료, 진료소, 진료소 문진
- `pharmacy` 약제실 (true) — PT 6 / ST 8 / NPC 9 ← 약제실(장부·창고 앞·선반 정리), 장부 정리, 약 나누기, 문기순과 장부 맞추기
- `quarantine` 격리실 (true) — PT 14 / ST 5 / NPC 6 ← 격리실 철문, 격리실 확인·배식, 격리실 옆 창고
- `lodging` 숙소·부엌·대표의 방 (true) — PT 11 / ST 6(부엌)+7(숙소)+대표의 방 5 / NPC 15 ← 수습 숙소, 수비대 숙소, 숙소, 자기 방, 진료소 부엌, 진료소 뒷방
- `gate` 정문·접수대·마당 (false, 접수대는 처마) — PT 9+3 / ST 14 / NPC 15 ← 정문, 정문 초소, 정문 소매 검사, 접수대, 문진 줄 정리, 거래 손님 응대, 진료소 마당(벤치), 수습 숙소 앞 벤치, 붕대 빨래, 들것 손질
- `back_wall` 뒷담·쪽문 (false) — ST 3+3 / NPC 3 ← 담장 순찰, 진료소 쪽문 근처, 진료소 뒷담. gate와 합쳐도 됨.
- 대표의 방(ST 5건 "대표의 방")이 routine에 없음 → lodging 또는 별도 `director_room`.

### e_market 나루상단 장터 (옛 휴게소, 턴 154, 이야기 90)
- `stalls` 장터 좌판·천막 (false) — PT 29 / ST 8+4 / NPC 11 ← 장터, 장터 천막, 천막, 장터 순찰, 피난민 천막
- `pawnshop` 전당포·장부석·매점 (true) — PT 2 / ST 3+계산대 / NPC 7 ← 전당포, 전당포 다락, 장터 장부석, 장부 맞추기, 빚 걷기, 창고 다락
- `bunkhouse` 호위·짐꾼 막사 (true) — PT 10(숙소) / ST 1+ / NPC 9 ← 호위 막사, 짐꾼 막사
- `wagon_yard` 짐마차 마당·마구간 (false) — NPC 14 ← 짐 싣기, 짐마차 점검·옆·바퀴, 호위 출발 준비, 출발 준비, 호위조 점검, 장터 마구간 천막, 화살 손질
- `landing` 선착장 (false) — ST 2+3(나루) / NPC 3 ← 장터 선착장, 강 하구 나루(→ water_plant와 겹침)
- 망루 1(장터 망루), 뒷골목 3 → stalls. "길 위" 8, 정수장 물가 2 → 이동/다른 구역.

### yeoul_isle 여울섬 (턴 306, 이야기 75)
- `council_hall` 의회 회관·부엌·저장고 (true) — PT 14(식당) / ST 10(의회)+13(식당)+5(부엌) / NPC 17 ← 의회 회관, 의회 부엌, 의회 저장고(뒤 별채), 식당, 식당 구석, 부엌 뒤 쪽방, 섬 학당, 섬 약방
- `quarters` 관사·숙소 (true) — PT 42(숙소)+7(침상) / ST 5 / NPC 10 ← 관사, 관사 앞마당·마당, 섬 숙소, 경비 막사
- `dock` 부두·검역 막사·부두 망루 (false) — PT 34+17(망루) / ST 10 / NPC 11 ← 부두, 섬 부두, 부두 검역 막사, 부두 망루, 부두(내보내는 배), 등대
- `farm_shore` 양식장·텃밭·바닷가 (false) — PT 9+2 / ST 0~2 / NPC 12 ← 섬 양식장, 양식장(감독 막사), 텃밭, 바닷가, 해안 순찰, 그물 창고, 창고, 저장고 옆 움막
- 탄약 공방(설명에 있음): 근거 거의 없음(PT 0). 넣는다면 `workshop` (true).

## 바깥 구역

| 구역 | 제안 장소 (indoor) | 근거 PT / ST / NPC |
|---|---|---|
| a_east_post 동쪽 초소 (89턴) | `watchtower` 망루 (false) · `bunker` 초소 안·창고 (true) | 초소18·망루1·창고15·고가11 / ST 7(망루3, 고가4) / NPC(거점 쪽 "망루","동쪽 초소") |
| c_warehouse 물류창고 (224턴) | `yard` 창고 마당·불가 (false) ← 물류창고 마당(불가·잔일), 광장 연설, 약탈조 출발, 조원 점호 · `barracks` 막사·취사 천막 (true) ← 막사10, 물류창고 취사 천막, 식당 천막, 취사 천막 뒷방, 배급 줄 · `stockade` 수용소 (true, 바깥문·담은 false) ← 수용소 바깥문·담 보초·배식·순찰·바깥 창고·노역조 · `command` 지휘소·정비소 (true) ← 지휘소, 물류창고 지휘소, 정비소(뒷방), 거점 치료실 · `wall` 감시탑·담 (false) ← 감시탑(아래), 담 보초, 경비 초소 | 창고35·초소22·망루22·감방9·수용소7 / ST 21(수용소8·마당4·지휘소2·하역장1) / NPC 50+ |
| riverside 강변 공장 (210턴) | `factory` 공장 건물 안 (true) · `bank` 강가·나루 (false) · `pumphouse_cellar` 옛 양수장 지하 (true) | 공장39·강가8+강변16·나루12·지하5 / ST 40(공장6·지하6·담장 그늘 2) / NPC 0 (떠돌이 "강변 수풀","강가 갈대밭") |
| old_town 구시가 (278턴) | `alleys` 시장 골목 (false) · `shops` 상가·약국 안 (true) · `boiler_room` 목욕탕 보일러실 (true) ← 보일러실3, 목욕탕 탕 안 텃밭 · `basement` 상가 지하 (true) | 골목35·상가30·약국17·계단8·지하7 / ST 37(골목8·상가7·지하5) / NPC 5 |
| south_fields 남쪽 텃밭 (43턴) | `field` 밭고랑 (false) ← 남쪽 텃밭, 밭고랑, 약초 캐기 · `hut` 움막 (true) ← 움막, 남쪽 텃밭 움막, 움막 앞 약초 말리기(false) · `south_wall` 무너진 남쪽 담장 (false) | 밭11·담장8·텃밭4 / ST 18(텃밭4·담장3) / NPC 8 + a_base 쪽 6 |
| hospital_ruins 시립병원 (137턴) | `lobby` 입구·응급실 (true) · `stairs_basement` 비상계단·지하 약제실 (true) · `yard` 병원 마당·별관 장례식장 (false/true) ← 병원 입구, 병원 마당(무덤 손질), 별관 장례식장 | 약제실18·계단18·응급실15·지하12·로비3 / ST 23(계단4·지하3·약제실3·접수대1) / NPC 6 |
| water_plant 정수장 (22턴) | `pump_room` 펌프실 (true) ← 펌프 돌리기4, 펌프실, 정비, 정수장 창고 · `waterside` 물가·나루 (false) ← 물 나눠 주기, 강 하구 나루, 배 손질, 배 위 | 펌프9·펌프실4 / ST 37(펌프4·나루3) / NPC 17 |
| subway_hub 환승역 (34턴) | `concourse` 개찰구·지하상가 (true) · `platform` 승강장·터널 (true) | 계단9·매대3·승강장1·개찰구1 / ST 7(승강장2·터널1) / NPC 0. 전부 실내. |
| power_plant 발전소 (34턴) | `coal_yard` 저탄장 (false) · `turbine_hall` 발전동·사무동 (true) | 창고5·사무동2·굴뚝2 / ST 10(저탄장2·발전기2·굴뚝2) / NPC 0 |
| prison 교도소 (11턴) | `cellblock` 감방동 (true) · `admin` 행정동·무기고 (true) · `yard` 운동장·담 (false) | 교도소5·담장2 / ST 6(감방2·무기고1·행정동 og_admin_ledger) / NPC 0 |
| mall_ruins 마트 (36턴) | `sales_floor` 매장 (true) · `stockroom` 무너진 창고·하역장 (true, 지붕 무너짐) · `parking` 주차장 (false) | 마트15·창고6·지하4·매대3·주차장2 / ST 7(창고2·하역장2) / NPC 0 |
| cathedral 성당 (34턴) | `nave` 성당 안·제대 (true) ← 제대 앞, 저녁 기도, 고해소 옆 의자, 성당 아이들 방, 성당 부엌, 종탑 아래 피난민 거처 · `bell_tower` 종탑 (true) ← 성당 종탑 · `churchyard` 뒤뜰·묘지 (false) ← 성당 뒤뜰(묘지) | 종탑3·뒤뜰2·지하4 / ST 12(종탑4·뒤뜰2·마당2) / NPC 11 |
| campus 캠퍼스 (16턴) | `library` 도서관 열람실·서고 (true) ← 서고(앞 계단), 열람실(창가), 도서관 열람실 · `lab` 약대 실험실(지하) (true) ← 약대 실험실(지하) · `greenhouse` 농대 온실 (true) ← 온실(난로·옆 창고), 온실 뒤 실습장(false) | 온실3 / ST 7(도서관2·온실2·칠판1) / NPC 15 |
| rest_stop 휴게소 (13턴) | `canopy` 주유소 지붕 밑·칠판 (false) ← 주유소 지붕 밑, 휴게소 지붕, 칠판 앞 · `diner` 휴게소 식당 안 (true) ← 휴게소 식당 안 · `tollgate` 톨게이트 (false) | 장터5·화장실1 / ST 19(칠판4·주유소2·톨게이트 2) / NPC 5 |
| overpass 고가도로 (31턴) | `deck` 고가 위 차량 행렬 (false) · `underpass` 고가 밑 (false) | 고가13 / ST 2 / NPC 0. 실내 없음 (버려진 차 안을 쉼터로 쓰면 indoor 하나). |

---

## 플레이에서 실제로 간 곳 (빈도)
PT = 세이브 입력, MD = 플레이 보고서 출현 수.

| 장소 | PT | MD | 주 구역 |
|---|---|---|---|
| 창고 | 160+ | 267 | c_warehouse, c_base, a_base, riverside |
| 담·담장(경계) | 200+(부풀림) | — | b_base, a_base, c_base |
| 숙소·막사·침상 | 숙소 109·막사 101·침상 55 | 막사 46 | yeoul, a_base, c_base, b_base |
| 정문 | 72 | 102 | a_base, b_base, d_clinic |
| 망루·초소 | 망루 57·초소 64 | 85 | c_warehouse, a_east_post, yeoul |
| 진료소/의무실 | 진료소 94·의무실 43 | 66 | old_town·hospital(목적지로 언급), a_base |
| 공장 | 83 | — | riverside |
| 골목·상가 | 49·38 | — | old_town |
| 지하 | 44 | 110 | hospital_ruins, old_town, riverside |
| 부두 | 34 | 25 | yeoul_isle |
| 약제실·응급실·계단 | 24·16·49 | 36 | hospital_ruins, d_clinic |
| 우물·경비실 | 16·14 | — | b_base |
| 격리실·치료실 | 14·10 | 24 | d_clinic |
| 식당 | 37 | 23 | a_base, yeoul |
| 펌프·펌프실 | 13 | — | water_plant |
| 교무실·운동장·화장실·교실 | 0·4·1·3 | 0 | — |

결론: 교무실은 이야기(9)·NPC(7)엔 많지만 플레이어 입력엔 0. 운동장·화장실·교실은 근거가 거의 없다. 반대로 정문·의무실·막사·창고·망루는 실제로 자주 간다.

---

## 실내/바깥이 뚜렷한 이야기 (zones 있는 것 위주 + 아무 데나 중 뚜렷한 것)

실내(indoor: true에서만):
1. wounded_arrive (a_base 의무실)
2. card_game (a_base 막사 구석)
3. ledger_inspection (a_base 막사)
4. a_of_council_split (교무실)
5. a_of_ledger_gap (교무실)
6. a_of_doyun_reckoning (빈 교무실)
7. a_of_jaeseok_offer (교무실 옆 작은 방, 난로)
8. a_of_jaeseok_gone (교무실 옆 작은 방)
9. a_of_ration_allocation (교무실)
10. a_of_send_squad (교무실 밖 복도)
11. a_of_hangyeol_sister (막사 구석)
12. b_well_reckoning (관리사무소 지하)
13. b_conscript_list (지하 교실 앞)
14. bo_gate_stance (경비실 난로 앞)
15. b_sl_myeongsuk_stairs / b_sl_gyeongtae_confess (동 계단참·계단 밑)
16. co_gyeongsu_offer (사무동 계단참)
17. co_prisoner_use (탁자, 수용소 명단)
18. d_count_short / d_verdict / do_ledger_gap (약제실)
19. d_quarantine_door / d_sl_yuna_door (격리실 철문 앞)
20. d_triage_choice / d_enemy_on_table (치료실)
21. d_pharmacy_map / occ_cook_white_porridge (진료소 부엌)
22. do_first_council / do_trade_line / do_verdict / d_sl_six_guards (대표의 방)
23. d_sori_fever (숙소 문)
24. es_contract_clause (매점 계산대)
25. e_deoksu_bearing (펌프실)
26. fr_emily_broadcast (성당 종탑)
27. og_er_register (응급실 접수대) · og_quarantine_mark (감방동 복도) · og_admin_ledger (행정동 이층)
28. d_pharmacy_vault / d_sl_shaft_stash / occ_sc_deep_run (병원 지하, 엘리베이터 통로)
29. e_bearing_salvage (옛 양수장 지하 계단)
30. ms_seojin_theory (칠판, 실험실)
31. bs_dream_before (아무 데나, 꿈이라 무관) — 제외해도 됨

바깥(indoor: false에서만):
1. overpass_signal / night_post_talk (망루) · c_message_out (공터 너머 망루)
2. infected_at_wall / b_fence_drawn (담장 틈·철망)
3. refugee_at_gate / a_of_b_left / a_of_trader_visit / b_gate_sister / bo_after_break / b_sl_two_orders / b_envoy_at_gate (정문·쪽문 밖)
4. a_of_night_sacks (운동장을 돈다) · a_sl_dongwook_hand (운동장 구석)
5. a_sl_byungchul_letter (정문 옆 그늘)
6. b_rooftop_kids / b_mina_names (옥상 망루)
7. bo_well_numbers (아랫단 우물가) · bo_ration_ladle (관리사무소 앞마당)
8. b_fields_thief (남쪽 텃밭 고랑)
9. cm_old_fire (물류창고 마당 드럼통 불가) · cm_strength_test (마당 공터) · c_prisoner_example (수용소 앞마당)
10. c_sora_plan (감시탑 아래 배수로)
11. d_red_offer / d_sl_armed_visitors / d_bitten_stranger / d_chaewon_plea (정문 쇠창살·정문 옆)
12. d_sl_side_gate / d_sl_fence_offer (뒤편 쪽문·담장 순찰)
13. d_sori_wrist / d_sori_clear (붕대 빨래 널기)
14. ms_night_boat / ms_boat_heist (선착장 끝)
15. es_toll_cache / es_toll_ambush (톨게이트) · es_underpass (굴다리)
16. e_road_ambush / e_decoy_raid (강변 공장 담장 그늘)
17. camp_* / cp_patrol_sees_fire / cp_watch_dozed (모닥불·야영지, zones 없음) — 실내 거처에서 뜨면 어긋남
18. bg_deserter_notice (길가 기둥) · bg_loss_ruin (집터 마당)

**충돌 위험**: (1) camp 계열(모닥불·야영)은 zones 없이 뜨므로 거점 실내 잠자리에서 뜰 수 있다. (2) 보고서에 이미 "보초가 실내 체감으로 셈" "정문 앞 처마인데 실내 +7" "야영인데 실내 +4" 버그가 여러 판 기록됨 — 장소 indoor 플래그가 기온 계산의 근거가 되어야 함. (3) 12-204 `activities` 조건 제안(wait·rest 중엔 실내 이야기)과 보고서의 "이야기마다 어디서(식당·부두·숙소·저장고·나루·물가·실내)를 데이터로" 제안이 바로 이 작업과 겹침.

---

## 빈틈 (플레이어가 원했는데 콘텐츠가 받쳐 주지 않는 곳)
- **강 하구 나루 / 거래선 접선 장소**: 섬 호위 브리핑 "강 하구에서 나루상단의 배를 맞아"인데 장소가 없어 섬 부두에서 완수(보고서 섬 판, 지난 판 6번 그대로). → water_plant 또는 e_market에 `landing`.
- **의무실(a_base)**: PT 33인데 의무실 이야기는 wounded_arrive 하나, NPC 3칸. 실제 수요 대비 부족.
- **정문 밖 처마/대기 자리**: 방문자 판에서 정문 앞 기다림이 실내로 셈. 담 밖 `outside_gate` (false) 필요.
- **약국(구시가)**: PT 17, ST 1(old_pharmacy). 상가 안 약국을 장소로.
- **공장 건물 안(riverside)**: PT 39인데 NPC 0, 이야기는 담장 그늘·지하. 실내 공장 이야기 없음.
- **지하철·마트·교도소·발전소**: NPC routine 0. 장소를 만들어도 사람이 없다(탐색 전용으로 충분할 수 있음).
- **대표의 방(d_clinic)**: 이야기 5건이 쓰는데 NPC routine에 없음.
- **교무실(a_base)**: 반대 경우 — 이야기 9·NPC 7이지만 플레이어 입력 0 (간부 역할 판이 적어서일 가능성).
- **화장실·교실·운동장**: 근거 없음. 교실은 막사로 묶기를 권함.
- **탄약 공방(여울섬)**, **농대 온실 밖 실습장**: 설명엔 있으나 플레이·이야기 근거 거의 없음.
