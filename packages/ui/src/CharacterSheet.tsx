import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HudPanel } from "./HudPanel.tsx";
import { MemoPanel } from "./MemoPanel.tsx";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./Portrait.tsx";
import { SheetTabs } from "./SheetTabs.tsx";
import type { GearView, ItemView, PersonProfile, PlayerView, SymptomView } from "./types.ts";

/** 장비 칸 (core views/player.ts의 SLOT_LABELS 순서) */
const SLOTS = ["손", "몸", "머리", "팔"];
const TRAIT_KIND_LABELS: Record<PlayerView["traits"][number]["kind"], string> = { positive: "장점", negative: "약점", personality: "성격" };

/**
 * 캐릭터 시트 (12-64): 위에 고정한 HUD(누구, 경험치, 몸 상태, 전투, 임무)와
 * 그 아래 블록(능력, 스킬, 장비, 소지품, 복무, 무리, 사람, 기록)
 */
export function CharacterSheet({ player, onStatus }: { player: PlayerView; onStatus?: (status: unknown) => void }) {
  return (
    <aside className={player.dead ? "sheet dead" : "sheet"} aria-label="캐릭터 시트">
      <SheetTabs
        player={player}
        head={
          <div className="hud">
            <div className="sheet-hero">
              <Portrait id={player.portrait} pack={player.packId} size={68} />
              <div className="hero-who">
                {/* 이름 오른쪽에 레벨·경험치 바·스킬 포인트 */}
                <div className="hero-name-row">
                  <h2>{player.name}</h2>
                  {player.growth && <XpBar growth={player.growth} />}
                </div>
                <div className="sheet-sub">
                  {/* 소속과 직분만 (시나리오 이름은 계급과 직분이 겹쳐 보여 뺀다). 복무 정보는 직분(없으면 소속)의 툴팁으로 */}
                  <SubLine player={player} />
                </div>
                {/* 몸 상태: 같이 있는 인물과 같은 색 (2단계 노랑, 3단계 주황, 4단계 빨강, 죽음 빨강, 이상 없으면 초록). 처음 단계·숨은 단계는 안 보인다 */}
                <div className="hero-conditions">
                  <SymptomList list={player.symptoms ?? []} itemClassName="hero-condition" />
                  {/* 이 상태들 때문에 판정에 붙는 보정 (합) */}
                  {player.conditionPenalty !== 0 && (
                    <span className="penalty-chip" title="몸 상태 때문에 모든 판정에 붙는 보정">
                      판정 {signed(player.conditionPenalty)}
                    </span>
                  )}
                </div>
              </div>
            </div>


            <HudPanel
              id="present"
              label="같이 있는 인물"
              meta={player.present.length ? `${player.present.length}명` : null}
              peek={player.present.length ? player.present.map((p) => p.name).join(", ") : "아무도 없습니다"}
              empty={player.present.length === 0}
            >
              {player.present.length === 0 ? (
                <span className="muted small">아무도 없습니다</span>
              ) : (
                <ul className="present-list">
                  {player.present.map((p) => (
                    <PersonRow key={p.id} name={p.name} profile={player.profiles?.[p.id]} tag={p.rankLabel} bond={p.bond ?? null} note={p.note ?? null} states={p.states ?? []} dead={!!p.dead} />
                  ))}
                </ul>
              )}
            </HudPanel>

            {player.battle && (
              <section className="sheet-battle">
                <h3>
                  {player.battle.title} <span className="muted small">({player.battle.sideLabel} · {player.battle.round}라운드)</span>
                </h3>
                <div className="gauge-row" title={`전세 ${player.battle.momentum}`}>
                  전세 {"◀".repeat(Math.max(0, -player.battle.momentum))}
                  {"·".repeat(player.battle.momentumMax - Math.abs(player.battle.momentum))}
                  {"▶".repeat(Math.max(0, player.battle.momentum))} {player.battle.momentumLabel}
                </div>
                <div className="muted small">
                  경보 {player.battle.alarmLabel} · 위치 {player.battle.positionLabel}
                </div>
              </section>
            )}

            <MissionCard mission={player.mission} loan={player.loan ?? []} resolve={player.resolve ?? null} />
          </div>
        }
      >
        {{
          ability: (
            <>
          <section className="block">
            <h3>능력</h3>
            <div className="ability-grid">
              {player.stats.map((s) => (
                <AbilityRow key={s.id} label={s.label} value={s.value} range={player.statRange ?? { min: -1, max: 2 }} />
              ))}
            </div>
          </section>

          {player.traits.length > 0 && (
            <section className="block traits">
              <h3>트레잇</h3>
              <dl className="stats two-col">
                {player.traits.map((t) => (
                  <div key={t.id} title={t.description}>
                    <dt className={`trait-${t.kind}`}>{t.label}</dt>
                    <dd className="muted small">{TRAIT_KIND_LABELS[t.kind]}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {(player.persona?.length ?? 0) > 0 && (
            <section className="block persona">
              <h3>성격</h3>
              <dl className="stats two-col">
                {player.persona!.map((p) => (
                  <div key={p.id} title={p.acting}>
                    <dt>{p.label}</dt>
                    <dd>{p.level}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="block skills" id="sheet-skills">
            <h3>스킬</h3>
            <dl className="stats two-col">
              {player.skills.map((s) => (
                <div key={s.id}>
                  <dt>
                    {s.label} <span className="muted small">{s.category}</span>
                  </dt>
                  <dd>{signed(s.value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {player.debts && player.debts.length > 0 && (
            <section className="service">
              <h3>빚</h3>
              <div className="condition-worse small">{player.debts.map((d) => `${d.name} ${d.amount}`).join(", ")}</div>
            </section>
          )}

            </>
          ),
          items: (
            <>
          {player.gear && (
            <section className="block">
              <h3>장비</h3>
              <div className="gear-boxes">
                {SLOTS.map((slot) => {
                  const g = [player.gear!.weapon, ...player.gear!.armor].find((x) => x?.slotLabel === slot);
                  return g ? <GearBox key={slot} gear={g} /> : <EmptySlot key={slot} slot={slot} bare={slot === "손"} />;
                })}
              </div>
            </section>
          )}

          <section className="block">
            <div className="block-head">
              <h3>소지품</h3>
              {player.gear && <WeightBar gear={player.gear} />}
            </div>
            <ItemGrid items={player.inventory} empty="가진 것이 없습니다" move={player.stash?.canPut ? { direction: "put", onStatus } : undefined} />
          </section>

          {player.stash?.canPut && (
            <section className="block stash">
              <div className="block-head">
                <h3>창고</h3>
                <span className="muted stash-where">{player.stash.label}</span>
              </div>
              <ItemGrid items={player.stash.items} empty="비어 있습니다" move={{ direction: "take", onStatus }} />
            </section>
          )}

          {player.sceneItems.length > 0 && (
            <section className="block">
              <h3>주변에 놓인 물건</h3>
              <ItemGrid items={player.sceneItems} empty="" />
            </section>
          )}

            </>
          ),
          people: (
            <>
          {player.companions && player.companions.length > 0 && (
            <section className="companions">
              <h3>동행</h3>
              <ul className="present-list">
                {player.companions.map((c) => (
                  <PersonRow
                    key={c.id}
                    name={c.name}
                    profile={player.profiles?.[c.id]}
                    tag={c.bondLabel}
                    note={c.note}
                    noteWarn={c.note === "갈림길"}
                    states={c.states ?? []}
                    apart={c.apart}
                  />
                ))}
              </ul>
            </section>
          )}

          {player.squad && (
            <section className="squad">
              <h3>분대</h3>
              <ul className="present-list">
                {player.squad.map((m) => (
                  <PersonRow key={m.id} name={m.name} profile={player.profiles?.[m.id]} tag={m.doing} states={m.states ?? []} sub={m.report ? `보고: ${m.report}` : null} />
                ))}
              </ul>
            </section>
          )}

          {player.relations.length > 0 && (
            <section className="relations">
              <details open>
                <summary>
                  <h3>관계</h3>
                </summary>
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>신뢰</th>
                      <th>호감</th>
                      <th>존중</th>
                    </tr>
                  </thead>
                  <tbody>
                    {player.relations.map((r) => (
                      <tr key={r.id} className={r.dead ? "relation-dead" : undefined} title={r.dead ? "죽었습니다" : undefined}>
                        <td>
                          <PersonName name={r.name} profile={player.profiles?.[r.id]} />
                        </td>
                        <RelationCell value={r.trust} />
                        <RelationCell value={r.affection} />
                        <RelationCell value={r.respect} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          )}

          {player.ties && player.ties.length > 0 && (
            <section className="beliefs ties">
              <details open>
                <summary>
                  <h3>인물 사이 ({player.ties.length})</h3>
                </summary>
                <ul>
                  {player.ties.map((t) => (
                    <li key={t.key}>{t.text}</li>
                  ))}
                </ul>
              </details>
            </section>
          )}

            </>
          ),
          journal: (
            <>
          <section className="block journal">
            <h3>지난 일</h3>
            {(player.journal ?? []).length === 0 ? (
              <div className="muted">아직 남은 기록이 없습니다.</div>
            ) : (
              <ol className="journal-list">
                {(player.journal ?? []).map((j) => (
                  <li key={j.key} className={j.scene ? "scene" : ""}>
                    <span className="journal-time">
                      {j.timeLabel}
                      {j.scene && " · 장면"}
                    </span>
                    {j.text}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {player.deeds.length > 0 && (
            <section className="beliefs deeds">
              <details open>
                <summary>
                  <h3>내 행적 ({player.deeds.length})</h3>
                </summary>
                <ul>
                  {player.deeds.map((d) => (
                    <li key={d.id}>
                      <span className="belief-source">{d.tagLabels.join("·")}</span> {d.summary}
                      {d.visibleWitnesses.length > 0 && <span className="muted"> — 본 사람: {d.visibleWitnesses.join(", ")}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          <section className="beliefs">
            <details open>
              <summary>
                <h3>아는 것 ({player.beliefs.length})</h3>
              </summary>
              <ul>
                {player.beliefs.map((b) => (
                  <li key={b.id}>
                    <span className="belief-source">{b.sourceLabel}</span> {b.fact}
                  </li>
                ))}
              </ul>
            </details>
          </section>
            </>
          ),
          memo: player.memo ? <MemoPanel text={player.memo.text} /> : null,
        }}
      </SheetTabs>
    </aside>
  );
}

/** Lv UP을 누르면: 능력 탭으로 가서 스킬 목록을 보여 준다 */
function showSkills() {
  window.dispatchEvent(new CustomEvent("trpg:tab", { detail: "ability" }));
  requestAnimationFrame(() => document.getElementById("sheet-skills")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function XpBar({ growth }: { growth: NonNullable<PlayerView["growth"]> }) {
  const prev = growth.prev ?? 0;
  const span = Math.max(1, growth.next - prev);
  const ratio = Math.min(1, Math.max(0, (growth.xp - prev) / span));
  return (
    <div className="xp-row" title={growth.next <= prev ? `경험치 ${growth.xp} (최대 레벨)` : `경험치 ${growth.xp} (다음 레벨 ${growth.next})`}>
      {/* 찍을 스킬 포인트가 남았으면 레벨 자리에 "Lv UP"을 띄운다 (채팅에서 GM에게 올릴 스킬을 말한다) */}
      {growth.skillPoints > 0 ? (
        <button
          type="button"
          className="xp-level lvup"
          title={`스킬 포인트 ${growth.skillPoints} — 누르면 스킬 목록으로. 올릴 스킬은 채팅에서 GM에게 말하세요`}
          onClick={showSkills}
        >
          <span className="lvup-text">Lv UP</span>
        </button>
      ) : (
        <span className="xp-level">Lv {growth.level}</span>
      )}
      <div className="bar xp-bar">
        <div style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span className="xp-num">
        {growth.xp - prev}/{span}
      </span>
    </div>
  );
}


/** 이름 아래 줄: 소속 · 직분 · 나이 · 성별. 직분(없으면 소속)에 점선 밑줄, 올리면 복무 정보 */
function SubLine({ player }: { player: PlayerView }) {
  const s = player.service;
  const tip = player.faction ? (
    <>
      <div>
        {[s.rankLabel, `공적 ${s.merit}`, `복무 ${s.daysServed}일`].filter(Boolean).join(" · ")}
        {s.disobedience > 0 && <span className="condition-worse"> · 불복종 {s.disobedience}</span>}
      </div>
      {s.promotionMissing && s.promotionMissing.length > 0 && <div className="muted">진급까지: {s.promotionMissing.join(", ")}</div>}
    </>
  ) : (
    <div>{s.daysServed}일째 (무소속)</div>
  );
  // 소속: 무리 소개 (캐릭터 만들 때 월드 이야기에서 본 말과 같다)와 무리 사정 (분위기·배급·방침), 있는 곳
  // 직분이 없으면 복무 정보도 소속 툴팁에 함께
  const f = player.faction;
  const about = f ? (
    <>
      {f.about && <div>{f.about}</div>}
      {f.about && <div className="info-tip-sep" />}
      <div>
        분위기 {f.moraleLabel} · 배급 {f.rationLabel}
      </div>
      {player.policy && player.policy.length > 0 && <div className="muted">방침: {player.policy.map((p) => `${p.label} ${p.option}`).join(" · ")}</div>}
      {player.zone && (
        <div className="muted">
          있는 곳: {player.zone.name} ({player.zone.owner})
        </div>
      )}
    </>
  ) : null;
  const factionTip = player.occupationLabel ? about : (
    <>
      {about}
      {about && <div className="info-tip-sep" />}
      {tip}
    </>
  );
  const faction: ReactNode = factionTip ? <InfoTip key="faction" label={player.faction?.name ?? "무소속"} tip={factionTip} /> : (player.faction?.name ?? "무소속");
  const parts: ReactNode[] = player.occupationLabel ? [faction, <InfoTip key="job" label={player.occupationLabel} tip={tip} />] : [faction];
  if (player.motive) parts.push(<InfoTip key="motive" label={player.motive.label} tip={<div>동기: {player.motive.summary}</div>} />);
  for (const x of [player.age ? `${player.age}세` : null, player.genderLabel]) if (x) parts.push(x);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </>
  );
}

/** 점선 밑줄 글자: 올리거나(키보드로 초점을 주거나) 누르면 아래에 설명 상자 */
function InfoTip({ label, tip }: { label: string; tip: ReactNode }) {
  return (
    <span className="info-tip" tabIndex={0}>
      {label}
      <span className="info-tip-box" role="tooltip">
        {tip}
      </span>
    </span>
  );
}

/**
 * 인물 이름: 올리면(키보드로 초점을 주면) ?인물과 같은 정보를 상자로 띄운다.
 * 접는 칸(overflow: hidden)에 잘리거나 죽은 사람 줄의 흐림을 물려받지 않게 body에 띄운다
 */
function PersonName({ name, profile }: { name: string; profile?: PersonProfile }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!profile) return <>{name}</>;
  return (
    <span
      className="person-tip"
      tabIndex={0}
      onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
      onFocus={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onBlur={() => setAnchor(null)}
    >
      {name}
      {anchor && createPortal(<PersonTipBox anchor={anchor} profile={profile} />, document.body)}
    </span>
  );
}

/** 툴팁 상자: 띄운 뒤 실제 크기를 재서 이름 아래(모자라면 위), 화면 안에 들어오게 놓는다 */
function PersonTipBox({ anchor, profile }: { anchor: DOMRect; profile: PersonProfile }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - height;
    const top = below + height <= window.innerHeight - margin ? below : above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - width));
    setPos({ left, top });
  }, [anchor]);
  return (
    <span ref={ref} className="person-tip-box" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      <PersonCard profile={profile} />
    </span>
  );
}

/** 툴팁에 보이는 "아는 것" 수 */
const TIP_FACTS = 3;

function PersonCard({ profile: p }: { profile: PersonProfile }) {
  return (
    <>
      <span className="person-tip-head">
        <strong>{p.heading}</strong>
        {p.rankLabel && <span className="muted"> · {p.rankLabel}</span>}
      </span>
      {p.look && <span className="person-tip-line">{p.look}</span>}
      {p.reputation && <span className="person-tip-line muted">{p.reputation}</span>}
      {p.traits.length > 0 && <span className="person-tip-line">보이는 모습: {p.traits.join(" · ")}</span>}
      <span className="info-tip-sep" />
      {p.attitude ? (
        <>
          <span className="person-tip-sub">나에 대한 태도 (마지막으로 만났을 때)</span>
          <span className="person-tip-attitude">
            {p.attitude.map((x) => (
              <span key={x.axis}>
                {x.label} <span className={x.value > 0 ? "rel-pos" : x.value < 0 ? "rel-neg" : "muted"}>{x.word}</span>
              </span>
            ))}
          </span>
        </>
      ) : (
        <span className="person-tip-line muted">아직 직접 만나 본 적이 없습니다.</span>
      )}
      {p.facts.length > 0 && (
        <>
          <span className="info-tip-sep" />
          <span className="person-tip-sub">이 인물에 대해 아는 것</span>
          {/* 툴팁은 스크롤할 수 없으니 최근 것 몇 개만, 한 줄 한 줄도 짧게 (전부는 ?인물) */}
          {p.facts.slice(-TIP_FACTS).map((f, i) => (
            <span key={i} className="person-tip-line person-tip-fact">
              <span className="muted">[{f.source}]</span> {f.fact}
            </span>
          ))}
          {p.facts.length > TIP_FACTS && <span className="person-tip-more">전부 보기: ?인물 {p.heading}</span>}
        </>
      )}
    </>
  );
}

/**
 * 사람 한 줄 (같이 있는 인물, 동행, 분대): 이름, 계급·까닭, 동행 표시, 오른쪽에 상태 색 증상.
 * apart: 잠시 떨어져 있는 동행 (흐리게). dead: 줄 긋고 흐리게, "사망"은 빨강
 */
function PersonRow(props: {
  name: string;
  profile?: PersonProfile;
  tag?: string;
  bond?: string | null;
  note?: string | null;
  noteWarn?: boolean;
  states: SymptomView[];
  dead?: boolean;
  apart?: boolean;
  sub?: string | null;
  title?: string;
}) {
  const { name, profile, tag, bond, note, noteWarn, states, dead, apart, sub, title } = props;
  return (
    <li className={["present-row", dead && "dead", apart && "apart"].filter(Boolean).join(" ")} title={title || undefined}>
      <div className="present-main">
        <span className="present-name">
          <PersonName name={name} profile={profile} />
        </span>
        {(tag || bond) && (
          <span className="present-rank">
            {tag}
            {tag && bond && " · "}
            {bond && (
              <span className="present-bond" title={`함께 다니는 사람 (${bond})`}>
                동행
              </span>
            )}
          </span>
        )}
        <span className="present-states">
          {dead ? (
            <span className="state-dead">사망</span>
          ) : (
            <>
              {note && <span className={noteWarn ? "present-note warn" : "present-note"}>{note}</span>}
              <SymptomList list={states} />
            </>
          )}
        </span>
      </div>
      {sub && <div className="present-sub">{sub}</div>}
    </li>
  );
}

/**
 * 증상 목록 (주인공·같이 있는 인물 같이 쓴다, 12-74). 원인은 숨기고 증상만, 겹치는 증상은 하나.
 * 색은 tone: 노랑 1 · 주황 2 · 빨강 3, 죽음은 빨강. 증상이 없으면 초록 "건강함"
 */
function SymptomList({ list, itemClassName = "" }: { list: SymptomView[]; itemClassName?: string }) {
  if (list.length === 0) {
    return (
      <span className={`${itemClassName} state-step-0`.trim()} title="몸 상태에 이상이 없습니다">
        건강함
      </span>
    );
  }
  return (
    <>
      {list.map((x) => (
        <span key={x.id} className={`${itemClassName} ${x.fatal ? "state-dead" : `state-step-${x.tone}`}`.trim()} title={x.penalty ? `판정 ${signed(x.penalty)}` : undefined}>
          {x.label}
        </span>
      ))}
    </>
  );
}

/** 다짐 (12-164): 임무 칸 맨 아래 한 줄. 칸을 접으면 보이지 않는다 */
function ResolveLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="mission-resolve" title="다짐: 이 주인공의 큰 줄기">
      <span className="mission-resolve-label">다짐</span>
      <span>{text}</span>
    </div>
  );
}

function MissionCard({ mission, loan, resolve }: { mission: PlayerView["mission"]; loan: string[]; resolve: string | null }) {
  if (!mission) {
    return (
      <HudPanel id="mission" label="임무" peek="맡은 임무가 없습니다" empty>
        <div className="muted small">맡은 임무가 없습니다. 상관에게 일감을 받을 수 있습니다.</div>
        <ResolveLine text={resolve} />
      </HudPanel>
    );
  }
  const due = mission.deadlineLeftLabel ? (mission.deadlineLeftLabel === "기한 지남" ? "기한 지남" : `기한까지 ${mission.deadlineLeftLabel}`) : `기한 ${mission.deadlineLabel}`;
  return (
    <HudPanel
      id="mission"
      label="임무"
      meta={
        <span className={mission.urgent ? "mission-due urgent" : "mission-due"} title={`기한 ${mission.deadlineLabel}`}>
          {due}
        </span>
      }
      peek={mission.title}
    >
      <div className="mission-title" title={mission.briefing}>
        {mission.title}
      </div>
      <ul className="mission-reqs">
        {mission.requirements.map((r) => {
          const met = !r.includes("미충족");
          return (
            <li key={r} className={met ? "met" : ""}>
              <span className="check" aria-hidden="true">
                {met ? "✓" : ""}
              </span>
              {r}
            </li>
          );
        })}
      </ul>
      {loan.length > 0 && <div className="muted small">빌린 장비 (반납): {loan.join(", ")}</div>}
      <ResolveLine text={resolve} />
    </HudPanel>
  );
}

function AbilityRow({ label, value, range }: { label: string; value: number; range: { min: number; max: number } }) {
  const cells = range.max - range.min + 1;
  const filled = value - range.min + 1;
  const tone = value <= range.min && range.min < 0 ? "low" : value >= range.max ? "top" : "";
  return (
    <div className={`ability ${tone}`} title={`${label} ${signed(value)}`}>
      <span>{label}</span>
      <span className="cells" aria-label={`${label} ${signed(value)}`}>
        {Array.from({ length: cells }, (_, i) => (
          <i key={i} className={i < filled ? "on" : ""} />
        ))}
      </span>
    </div>
  );
}

function GearBox({ gear }: { gear: GearView }) {
  const d = gear.durability;
  const ratio = d ? d.left / d.max : 1;
  const tone = ratio <= 0.25 ? "bad" : ratio <= 0.5 ? "warn" : "good";
  return (
    <div className="gear-box">
      <span className="gear-slot">{gear.slotLabel}</span>
      <div className="gear-main">
        <div>
          <Icon name={gear.icon} className={gear.slotLabel === "손" ? "icon-weapon" : "icon-muted"} /> {gear.name}
          {gear.ammo && <span className="gear-ammo"> {gear.ammo}</span>}
        </div>
        {gear.detail && <div className="muted small">{gear.detail}</div>}
      </div>
      {d && (
        <div className={`gear-durability ${tone}`}>
          <div className="bar">
            <div style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <span>
            내구도 {d.left}/{d.max}
          </span>
        </div>
      )}
    </div>
  );
}

function EmptySlot({ slot, bare }: { slot: string; bare: boolean }) {
  return (
    <div className="gear-box empty">
      <span className="gear-slot">{slot}</span>
      <span className="muted">{bare ? "맨손" : "비어 있음"}</span>
    </div>
  );
}

function WeightBar({ gear }: { gear: NonNullable<PlayerView["gear"]> }) {
  const ratio = Math.min(1, gear.capacity > 0 ? gear.weight / gear.capacity : 0);
  const tone = gear.burden === 2 ? "bad" : gear.burden === 1 ? "warn" : "";
  const note = gear.burden === 2 ? " · 너무 무거움" : gear.burden === 1 ? " · 무거움" : "";
  return (
    <span className={`weight ${tone}`} title={gear.burden === 2 ? "너무 무거워 옮겨 가지 못합니다" : gear.burden === 1 ? "무거워서 판정이 불리합니다" : ""}>
      소지품 무게
      <span className="bar">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
      {gear.weight}/{gear.capacity}kg{note}
    </span>
  );
}

/** 아이콘 색: 치료는 빨강, 무기·탄약·불은 주황, 나머지는 회색 */
const ICON_TONE: Record<string, string> = {
  medicine: "icon-heal",
  blade: "icon-weapon",
  club: "icon-weapon",
  gun: "icon-weapon",
  bow: "icon-weapon",
  fire: "icon-weapon",
  bomb: "icon-weapon",
  ammo: "icon-weapon",
};

/** 창고로 넣기·꺼내기 (12-149) */
type StashMove = { direction: "put" | "take"; onStatus?: (status: unknown) => void };

/** 누르고 있으면 이만큼 뒤부터 */
const HOLD_DELAY_MS = 500;
/** 이만큼마다 하나씩 */
const HOLD_EVERY_MS = 100;

function ItemGrid({ items, empty, move }: { items: ItemView[]; empty: string; move?: StashMove }) {
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return empty ? <div className="muted">{empty}</div> : null;
  return (
    <>
      <ul className={move ? "item-grid item-grid-move" : "item-grid"}>
        {items.map((item) => (
          <li key={item.id}>
            <Icon name={item.icon} className={ICON_TONE[item.icon ?? ""] ?? "icon-muted"} />
            <span className="item-name">{item.name}</span>
            {item.quantity > 1 && <span className="muted">×{item.quantity}</span>}
            {move && <MoveButton item={item} move={move} onError={setError} />}
          </li>
        ))}
      </ul>
      {error && <div className="item-move-error">{error}</div>}
    </>
  );
}

/**
 * 하나씩 옮기는 아이콘 버튼. 누르면 하나, 누르고 있으면 0.5초 뒤부터 0.1초마다 하나씩 (다 옮기거나 손을 떼면 멈춘다).
 * 요청은 한 번에 하나만 보낸다 (앞 요청이 끝나기 전의 틱은 건너뛴다)
 */
function MoveButton({ item, move, onError }: { item: ItemView; move: StashMove; onError: (e: string | null) => void }) {
  const busy = useRef(false);
  const left = useRef(item.quantity);
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  left.current = item.quantity;

  const stop = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);

  const sendOne = async () => {
    if (busy.current || left.current < 1) return;
    busy.current = true;
    try {
      const res = await fetch("/api/stash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ direction: move.direction, itemId: item.id, quantity: 1 }) });
      const body = (await res.json()) as { status?: unknown; error?: string };
      if (!res.ok) {
        onError(body.error ?? "옮기지 못했습니다");
        stop();
      } else {
        onError(null);
        left.current -= 1;
        if (left.current < 1) stop();
        if (body.status) move.onStatus?.(body.status);
      }
    } catch {
      onError("옮기지 못했습니다");
      stop();
    } finally {
      busy.current = false;
    }
  };

  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    stop();
    void sendOne();
    timers.current.delay = setTimeout(() => {
      timers.current.every = setInterval(() => void sendOne(), HOLD_EVERY_MS);
    }, HOLD_DELAY_MS);
  };

  const title = `${item.name} 하나를 ${move.direction === "put" ? "창고에 넣습니다" : "꺼냅니다"}${item.quantity > 1 ? " (누르고 있으면 계속)" : ""}`;
  return (
    <button
      type="button"
      className="item-move"
      title={title}
      aria-label={title}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      // 키보드(Enter·Space)로 누르면 하나 (포인터로 누른 것은 pointerdown이 이미 보냈다)
      onClick={(e) => {
        if (e.detail === 0) void sendOne();
      }}
    >
      <Icon name={move.direction === "put" ? "stash-in" : "stash-out"} size={15} />
    </button>
  );
}

function RelationCell({ value }: { value: number }) {
  return <td className={value > 0 ? "rel-pos" : value < 0 ? "rel-neg" : "muted"}>{signed(value)}</td>;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
