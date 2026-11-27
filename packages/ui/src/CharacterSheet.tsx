import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HudPanel } from "./HudPanel.tsx";
import { MemoPanel } from "./MemoPanel.tsx";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./Portrait.tsx";
import { SheetTabs } from "./SheetTabs.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { ConfirmPopover, Popover } from "./Dialog.tsx";
import type { GearView, ItemView, PersonProfile, PlayerView, SymptomView, WarMapView } from "./types.ts";

/** 장비 칸 (core views/player.ts의 SLOT_LABELS 순서) */
const SLOTS = ["손", "몸", "머리", "팔"];
const TRAIT_KIND_LABELS: Record<PlayerView["traits"][number]["kind"], string> = { positive: "장점", negative: "약점", personality: "성격" };

/**
 * 캐릭터 시트 (12-64): 위에 고정한 HUD(누구, 경험치, 몸 상태, 전투, 임무)와
 * 그 아래 블록(능력, 스킬, 장비, 소지품, 복무, 무리, 사람, 기록)
 */
export function CharacterSheet({ player, war, onStatus }: { player: PlayerView; war?: WarMapView | null; onStatus?: (status: unknown) => void }) {
  return (
    <aside className={player.dead ? "sheet dead" : "sheet"} aria-label="캐릭터 시트">
      <SheetTabs
        player={player}
        head={
          <div className="hud">
            <div className="sheet-hero">
              {player.portraitChoices?.length ? (
                <PortraitChooser player={player} onStatus={onStatus} />
              ) : (
                <Portrait id={player.portrait} pack={player.packId} size={90} />
              )}
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

            <TodoCard todos={player.todos ?? []} />
          </div>
        }
      >
        {{
          ability: (
            <>
          {player.past && (
            <section className="block origin">
              <div className="origin-title" title={player.past.summary}>
                {player.past.icon && <Icon name={player.past.icon} size={16} />}
                {player.past.label} 출신
              </div>
            </section>
          )}

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

          {(player.personaScale?.length ?? 0) > 0 && (
            <section className="block persona">
              <h3>성격</h3>
              {/* 만들 때 고른 모양 그대로: 축마다 2 1 0 1 2 */}
              <div className="persona-table readonly">
                {player.personaScale!.map((a) => (
                  <div key={a.id} className="persona-row" title={a.acting || undefined}>
                    <span className="persona-side low">{a.low}</span>
                    <div className="persona-buttons">
                      {[-2, -1, 0, 1, 2].map((v) => (
                        <span key={v} className={`persona-btn${a.value === v ? " on" : ""}${v === 0 ? " mid" : ""}`} />
                      ))}
                    </div>
                    <span className="persona-side high">{a.high}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(player.settings?.length ?? 0) > 0 && (
            <section className="block settings-sheet">
              <h3>설정</h3>
              <dl className="stats">
                {player.settings!.map((x) => (
                  <div key={x.id} title={x.rolls ? "거스르면 정신력으로 굴린다" : undefined}>
                    <dt>
                      <span className="muted small">{x.slotLabel}</span> {x.name}
                    </dt>
                    <dd className="muted small">
                      {x.secret ? `${x.secret.fact} · 아는 사람: ${x.secret.knownBy.length ? x.secret.knownBy.join(", ") : "없음"}` : x.description}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <SkillBlock player={player} onStatus={onStatus} />

          {player.debts && player.debts.length > 0 && (
            <section className="service">
              <h3>빚</h3>
              <div className="condition-worse small">{player.debts.map((d) => `${d.name} ${d.amount}`).join(", ")}</div>
            </section>
          )}

          {player.scenario && (
            <section className="block origin">
              <h3>시나리오</h3>
              <div className="origin-title">{player.scenario.title}</div>
              <p className="origin-text">{player.scenario.pitch}</p>
            </section>
          )}

            </>
          ),
          items: (
            <EquipArea onStatus={onStatus}>
          {player.gear && (
            <section className="block">
              <h3>장비</h3>
              <div className="gear-boxes">
                {SLOTS.map((slot) => {
                  const g = [player.gear!.weapon, ...player.gear!.armor].find((x) => x?.slotLabel === slot);
                  return g ? <GearBox key={slot} gear={g} canUnequip /> : <EmptySlot key={slot} slot={slot} bare={slot === "손"} />;
                })}
              </div>
            </section>
          )}

          <section className="block">
            <div className="block-head">
              <h3>소지품</h3>
              {player.gear && <WeightBar gear={player.gear} />}
            </div>
            <ItemGrid items={player.inventory} empty="가진 것이 없습니다" move={player.stash?.canPut ? { direction: "put", onStatus } : undefined} wearable={!!player.gear} />
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

            </EquipArea>
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
            </>
          ),
          memory: (
            <>
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
          map: <MapPanel map={player.map ?? null} placeMap={player.placeMap ?? null} war={war ?? null} />,
          memo: player.memo ? <MemoPanel text={player.memo.text} /> : null,
        }}
      </SheetTabs>
    </aside>
  );
}

/** Lv UP을 누르면: 캐릭터 탭으로 가서 스킬 목록을 보여 준다 */
/** Lv UP: 캐릭터 탭의 스킬 블록으로 가서 잠깐 밝혀 보인다 (올릴 곳을 찾기 쉽게) */
function showSkills() {
  window.dispatchEvent(new CustomEvent("trpg:tab", { detail: "ability" }));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById("sheet-skills");
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // 다시 눌러도 처음부터 밝힌다
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
    }),
  );
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
          title={`스킬 포인트 ${growth.skillPoints} — 누르면 스킬 목록으로. 스킬 옆 +를 눌러 올린다`}
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
        {s.disobedience > 0 && <span className="condition-worse"> · 임무 미수행 {s.disobedience}</span>}
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
      {f.plans && f.plans.length > 0 && f.plans.map((p) => <div key={p} className="muted">{p}</div>)}
      {f.war && f.war.length > 0 && (
        <>
          <div className="info-tip-sep" />
          <div>최근 전황 (들은 것)</div>
          {f.war.map((w) => (
            <div key={w} className="muted">
              {w}
            </div>
          ))}
        </>
      )}
      {player.zone && (
        <div className="muted">
          있는 곳: {player.place ? `${player.place.name} · ` : ""}
          {player.zone.name} ({player.zone.owner})
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
        {p.age !== null && <span className="muted"> · {p.age}세</span>}
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
      {p.knowsMySecret && <span className="person-tip-line">이 사람은 내 비밀({p.knowsMySecret})을 안다.</span>}
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

/**
 * 퀘스트 칸: 임무·부탁·약속·큰 이야기·다짐을 종류 구분 없이 같은 퀘스트로 (core views/player.ts todoViews, 2026-11-25 사용자 결정).
 * 한 줄 = 제목(맡긴 사람) · 기한. 요구 조건·큰 이야기의 막은 체크 목록으로 아래에, 실마리는 그 아래 한 줄
 */
function TodoCard({ todos }: { todos: NonNullable<PlayerView["todos"]> }) {
  const first = todos[0];
  const urgent = todos.filter((t) => t.urgent).length;
  return (
    <HudPanel
      id="todo"
      label="퀘스트"
      meta={todos.length > 0 && <span className={urgent ? "todo-count urgent" : "todo-count"}>{urgent ? `급한 일 ${urgent} · ` : ""}{todos.length}개</span>}
      peek={first ? `${first.title}${todos.length > 1 ? ` 외 ${todos.length - 1}` : ""}` : "퀘스트가 없습니다"}
      empty={todos.length === 0}
    >
      {todos.length === 0 ? (
        <div className="muted small">퀘스트가 없습니다. 상관에게 일감을 받거나, 사람들의 부탁을 들어줄 수 있습니다.</div>
      ) : (
        <ul className="todo-list">
          {todos.map((t) => (
            <li key={t.key} className="todo">
              <div className="todo-main">
                <div className="todo-title" title={t.detail ?? undefined}>
                  {t.title}
                  {t.who && <span className="todo-who"> · {t.who}</span>}
                </div>
                {t.steps.length > 0 && (
                  <ul className="mission-reqs">
                    {t.steps.map((r) => (
                      <li key={r.text} className={r.met ? "met" : ""}>
                        <span className="check" aria-hidden="true">
                          {r.met ? "✓" : ""}
                        </span>
                        {r.text}
                      </li>
                    ))}
                  </ul>
                )}
                {t.note && <div className="todo-note">{t.note}</div>}
              </div>
              {t.dueLabel && <span className={t.urgent ? "todo-due urgent" : "todo-due"}>{t.dueLabel}</span>}
            </li>
          ))}
        </ul>
      )}
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
      <span className="ability-value">{signed(value)}</span>
    </div>
  );
}

function GearBox({ gear, canUnequip }: { gear: GearView; canUnequip?: boolean }) {
  const d = gear.durability;
  const ratio = d ? d.left / d.max : 1;
  const tone = ratio <= 0.25 ? "bad" : ratio <= 0.5 ? "warn" : "good";
  const equip = useContext(EquipContext);
  const clickable = !!(canUnequip && equip && gear.slot);
  const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const verb = gear.slot === "weapon" ? "내려놓을까요" : "벗을까요";
  return (
    <div
      ref={box}
      className={clickable ? "gear-box clickable" : "gear-box"}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-haspopup": "dialog" as const,
            "aria-expanded": confirm,
            title: gear.slot === "weapon" ? "눌러서 내려놓기" : "눌러서 벗기",
            onClick: () => setConfirm((v) => !v),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setConfirm((v) => !v);
              }
            },
          }
        : {})}
    >
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
      <ConfirmPopover
        open={clickable && confirm}
        onClose={() => setConfirm(false)}
        boundary={box}
        label={`${gear.name} ${verb}`}
        question={`${objectJosa(gear.name)} ${verb}?`}
        busy={equip?.busy}
        onConfirm={() => {
          setConfirm(false);
          void equip!.send({ slot: gear.slot });
        }}
      />
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

function ItemGrid({ items, empty, move, wearable }: { items: ItemView[]; empty: string; move?: StashMove; wearable?: boolean }) {
  const equip = useContext(EquipContext);
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return empty ? <div className="muted">{empty}</div> : null;
  return (
    <>
      <ul className={move ? "item-grid item-grid-move" : "item-grid"}>
        {items.map((item) => {
          const canWear = !!(wearable && equip && item.wear);
          const wear = () => {
            if (!equip!.busy) void equip!.send({ itemId: item.id });
          };
          return (
          <li
            key={item.id}
            className={canWear ? "item-wearable" : undefined}
            {...(canWear
              ? {
                  role: "button",
                  tabIndex: 0,
                  title: item.wear === "weapon" ? `${item.name} 손에 들기` : `${item.name} 입기`,
                  onClick: wear,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      wear();
                    }
                  },
                }
              : {})}
          >
            <Icon name={item.icon} className={ICON_TONE[item.icon ?? ""] ?? "icon-muted"} />
            <span className="item-name">{item.name}</span>
            {item.quantity > 1 && <span className="muted">×{item.quantity}</span>}
            {move && <MoveButton item={item} move={move} onError={setError} />}
          </li>
          );
        })}
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
    // 창고 단추를 누른 것은 아이템 칸(입기·들기)으로 번지지 않게 한다
    e.stopPropagation();
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
        e.stopPropagation();
        if (e.detail === 0) void sendOne();
      }}
      onKeyDown={(e) => e.stopPropagation()}
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

/**
 * 얼굴 고르기 기회 (12-139): 얼굴 없이 만든 주인공의 빈 초상화. 누르면 "얼굴을 선택하시겠습니까?"를 묻고,
 * [예]면 고를 수 있는 얼굴을 보인다. 얼굴을 누르면 바로 정해진다 (한 번만, 규칙은 core)
 */
function PortraitChooser({ player, onStatus }: { player: PlayerView; onStatus?: (status: unknown) => void }) {
  const [open, setOpen] = useState<null | "ask" | "pick">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);
  const choose = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portrait", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const body = (await res.json()) as { status?: unknown; error?: string };
      if (!res.ok) setError(body.error ?? "고르지 못했습니다");
      else {
        setOpen(null);
        if (body.status) onStatus?.(body.status);
      }
    } catch {
      setError("고르지 못했습니다");
    } finally {
      setBusy(false);
    }
  };
  const sections = player.portraitChoices ?? [];
  return (
    <div className="portrait-chooser" ref={box}>
      <button type="button" className="portrait-chooser-face" aria-haspopup="dialog" aria-expanded={open !== null} title="얼굴 고르기" onClick={() => setOpen(open ? null : "ask")}>
        <Portrait id={null} size={90} title="얼굴 없음 (눌러서 고르기)" />
      </button>
      <ConfirmPopover
        open={open === "ask"}
        onClose={close}
        boundary={box}
        label="얼굴 고르기"
        question="얼굴을 선택하시겠습니까?"
        note="한 번만 고를 수 있습니다."
        onConfirm={() => setOpen("pick")}
      />
      <Popover open={open === "pick"} onClose={close} boundary={box} label="얼굴 고르기" className="portrait-pop-pick">
        <p className="popover-q">얼굴을 골라 주세요</p>
        {error && <p className="portrait-pop-error">{error}</p>}
        <div className="portrait-pop-list">
          {sections.map((sec) => (
            <section key={sec.style}>
              {sections.length > 1 && <h3 className="portrait-section-title">{sec.label}</h3>}
              <div className="portrait-pop-grid">
                {sec.faces.map((id, i) => (
                  <button key={id} type="button" className="portrait-pick" disabled={busy} aria-label={sec.numbered ? `초상화 ${i + 1}` : `초상화 ${id}`} onClick={() => void choose(id)}>
                    <Portrait id={id} pack={player.packId} size={72} square />
                    {sec.numbered && <span className="portrait-number">{i + 1}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Popover>
    </div>
  );
}


/** 장비 착용·해제 (12-139): 아이템 탭 안의 들기·입기·벗기 단추가 함께 쓴다. 규칙은 core (GM의 equip tool과 같다) */
type EquipApi = { busy: boolean; send: (body: { itemId?: string; slot?: string }) => Promise<void> };
const EquipContext = createContext<EquipApi | null>(null);

function EquipArea({ onStatus, children }: { onStatus?: (status: unknown) => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: { itemId?: string; slot?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/equip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json()) as { status?: unknown; error?: string };
      if (!res.ok) setError(out.error ?? "바꾸지 못했습니다");
      else if (out.status) onStatus?.(out.status);
    } catch {
      setError("바꾸지 못했습니다");
    } finally {
      setBusy(false);
    }
  };
  return (
    <EquipContext.Provider value={{ busy, send }}>
      {error && <div className="item-move-error">{error}</div>}
      {children}
    </EquipContext.Provider>
  );
}

/**
 * 스킬 블록. 레벨업(스킬 포인트)이 남았으면 최고 단계 아래 스킬마다 + 단추로 올릴 것을 고른다 (12-139).
 * 고른 것은 바로 적용하지 않고, 오른쪽 위 [저장]을 눌러야 적용한다 ([취소]로 되돌린다). 규칙은 core (GM의 learn_skill tool과 같다)
 */
function SkillBlock({ player, onStatus }: { player: PlayerView; onStatus?: (status: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 저장 전에 고른 것: 스킬 id → 올릴 단계 수
  const [pending, setPending] = useState<Record<string, number>>({});
  const points = player.growth?.skillPoints ?? 0;
  const max = player.growth?.skillMax;
  const min = player.growth?.skillMin ?? -1;
  // 단계마다 올리는 점수가 다르다 (4.2.1: -1→0 1점, 0→+1 2점, +1→+2 3점)
  const stepCost = (from: number) => player.growth?.skillCosts?.[from - min] ?? 1;
  const pendingCost = (from: number, n: number) => Array.from({ length: n }, (_, i) => stepCost(from + i)).reduce((a, b) => a + b, 0);
  const used = player.skills.reduce((n, s) => n + (s.learned === null ? 0 : pendingCost(s.learned, pending[s.id] ?? 0)), 0);
  const left = points - used;
  const add = (skill: string) => setPending((p) => ({ ...p, [skill]: (p[skill] ?? 0) + 1 }));
  const save = async () => {
    if (busy || used === 0) return;
    setBusy(true);
    setError(null);
    let last: unknown = null;
    try {
      // 한 단계씩 차례로 올린다 (서버 규칙이 단계마다 검사한다)
      for (const [skill, n] of Object.entries(pending)) {
        for (let i = 0; i < n; i++) {
          const res = await fetch("/api/skill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill }) });
          const out = (await res.json()) as { status?: unknown; error?: string };
          if (!res.ok) throw new Error(out.error ?? "올리지 못했습니다");
          last = out.status ?? last;
        }
      }
      setPending({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "올리지 못했습니다");
      setPending({});
    } finally {
      if (last) onStatus?.(last);
      setBusy(false);
    }
  };
  return (
    <section className="block skills" id="sheet-skills">
      <div className="block-head">
        <h3>
          스킬
          {points > 0 && <span className="skill-points">스킬 포인트 {left}</span>}
        </h3>
        {used > 0 && (
          <div className="skill-actions">
            <button type="button" disabled={busy} onClick={() => setPending({})}>
              취소
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
              저장
            </button>
          </div>
        )}
      </div>
      {error && <div className="item-move-error">{error}</div>}
      {/* 할 수 있는 스킬은 분류별 묶음으로 (월드 팩 순서 그대로), 못 하는 전문 기술은 맨 아래 한 줄에 이름만 */}
      <div className="skill-groups">
        {groupByCategory(player.skills.filter((s) => s.usable)).map(([category, list]) => (
          <div key={category} className="skill-group">
            <h4>{category}</h4>
            <dl className="stats">
              {list.map((s) => {
                const plus = pending[s.id] ?? 0;
                const value = s.value + plus;
                const level = s.learned === null ? null : s.learned + plus;
                const next = level === null || max === undefined || level >= max ? null : stepCost(level);
                // 단계 이름(숙련·미숙 등)은 보이지 않고 값만. -1 이하는 흐리게
                return (
                  <div key={s.id} className={(level ?? min) <= min ? "skill-untrained" : undefined}>
                    <dt>
                      {s.label} <span className="muted small">{s.kind === "expert" ? "전문 · " : ""}{s.stats.join("·")}</span>
                    </dt>
                    <dd>
                      <span className={plus ? "skill-pending" : undefined}>{signed(value)}</span>
                      {points > 0 && max !== undefined && (
                        <button
                          type="button"
                          className="skill-up"
                          disabled={busy || next === null || left < next}
                          title={next === null ? `${s.label}: 최고 단계` : `${s.label} 한 단계 올리기: ${next}점 (저장해야 적용)`}
                          aria-label={`${s.label} 올리기`}
                          onClick={() => add(s.id)}
                        >
                          +
                        </button>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
      {player.skills.some((s) => !s.usable) && (
        <p className="skill-unusable">
          <span className="skill-unusable-head">못 함</span>
          {player.skills
            .filter((s) => !s.usable)
            .map((s, i) => (
              <span key={s.id} title={`${s.category} 전문 · ${s.stats.join("·")} — 배워야 할 수 있다`}>
                {i > 0 && " · "}
                {s.label}
              </span>
            ))}
        </p>
      )}
    </section>
  );
}

/** 분류별로 묶는다. 분류 순서와 묶음 안의 순서는 처음 나온 순서(월드 팩 순서) 그대로 */
function groupByCategory<T extends { category: string }>(list: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const s of list) {
    const key = s.category || "기타";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups];
}

/** 받침에 맞는 목적격 조사 (core의 josa와 같은 셈, 한글이 아니면 "를") */
function objectJosa(word: string): string {
  const base = word.trim().replace(/(\s*\([^()]*\))+$/, "");
  const code = base.charCodeAt(base.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return `${word}를`;
  return `${word}${(code - 0xac00) % 28 ? "을" : "를"}`;
}
