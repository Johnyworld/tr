import type { ReactNode } from "react";
import { HudPanel } from "./HudPanel.tsx";
import { MemoPanel } from "./MemoPanel.tsx";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./Portrait.tsx";
import { SheetTabs } from "./SheetTabs.tsx";
import type { GearView, ItemView, PlayerView, SymptomView } from "./types.ts";

/** 장비 칸 (core views/player.ts의 SLOT_LABELS 순서) */
const SLOTS = ["손", "몸", "머리", "팔"];

/**
 * 캐릭터 시트 (12-64): 위에 고정한 HUD(누구, 경험치, 몸 상태, 전투, 임무)와
 * 그 아래 블록(능력, 스킬, 장비, 소지품, 복무, 무리, 사람, 기록)
 */
export function CharacterSheet({ player }: { player: PlayerView }) {
  return (
    <aside className={player.dead ? "sheet dead" : "sheet"} aria-label="캐릭터 시트">
      <SheetTabs
        player={player}
        head={
          <div className="hud">
            <div className="sheet-hero">
              <Portrait id={player.portrait} size={68} />
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
                    <li key={p.id} className={p.dead ? "present-row dead" : "present-row"} title={p.look}>
                      <span className="present-name">{p.name}</span>
                      {p.rankLabel && <span className="present-rank">{p.rankLabel}</span>}
                      <span className="present-states">
                        {p.dead ? (
                          <span className="state-dead">사망</span>
                        ) : (
                          <>
                            {p.note && <span className="present-note">{p.note}</span>}
                            <SymptomList list={p.states ?? []} />
                          </>
                        )}
                      </span>
                    </li>
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

            <MissionCard mission={player.mission} loan={player.loan ?? []} />
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
            {player.traits.length > 0 && (
              <div className="trait-chips">
                {player.traits.map((t) => (
                  <span key={t.id} className={`trait-chip ${t.kind}`} title={t.description}>
                    {t.label}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="block skills" id="sheet-skills">
            <h3>스킬</h3>
            <dl className="stats">
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
            <ItemGrid items={player.inventory} empty="가진 것이 없습니다" />
          </section>

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
              <ul className="people">
                {player.companions.map((c) => (
                  <li key={c.id} className={c.apart ? "muted" : ""}>
                    {c.name} <span className="muted">· {c.bondLabel}</span>
                    {c.note && <span className={c.note === "갈림길" ? "condition-worse" : "muted"}> · {c.note}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {player.squad && (
            <section className="squad">
              <h3>분대</h3>
              <ul className="people">
                {player.squad.map((m) => (
                  <li key={m.id} title={m.report ?? undefined}>
                    {m.name} <span className="muted">· {m.doing}</span>
                    {m.report && <div className="muted small">보고: {m.report}</div>}
                  </li>
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
                        <td>{r.name}</td>
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

          {player.faction && (
            <section className="faction">
              <h3>무리</h3>
              <div>
                {player.faction.name} · 분위기 {player.faction.moraleLabel}
              </div>
              <div className="muted small">배급: {player.faction.rationLabel}</div>
              {player.policy && player.policy.length > 0 && (
                <div className="muted small">방침: {player.policy.map((p) => `${p.label} ${p.option}`).join(" · ")}</div>
              )}
              {player.zone && <div className="muted small">있는 곳: {player.zone.name} ({player.zone.owner})</div>}
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
    <div className="xp-row" title={`경험치 ${growth.xp} (다음 레벨 ${growth.next})`}>
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
  // 소속: 무리 소개 (캐릭터 만들 때 월드 이야기에서 본 말과 같다)
  // 직분이 없으면 복무 정보도 소속 툴팁에 함께
  const about = player.faction?.about ? <div>{player.faction.about}</div> : null;
  const factionTip = player.occupationLabel ? about : (
    <>
      {about}
      {about && <div className="info-tip-sep" />}
      {tip}
    </>
  );
  const faction: ReactNode = factionTip ? <InfoTip key="faction" label={player.faction?.name ?? "무소속"} tip={factionTip} /> : (player.faction?.name ?? "무소속");
  const parts: ReactNode[] = player.occupationLabel ? [faction, <InfoTip key="job" label={player.occupationLabel} tip={tip} />] : [faction];
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

function MissionCard({ mission, loan }: { mission: PlayerView["mission"]; loan: string[] }) {
  if (!mission) {
    return (
      <HudPanel id="mission" label="임무" peek="맡은 임무가 없습니다" empty>
        <div className="muted small">맡은 임무가 없습니다. 상관에게 일감을 받을 수 있습니다.</div>
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

function ItemGrid({ items, empty }: { items: ItemView[]; empty: string }) {
  if (items.length === 0) return empty ? <div className="muted">{empty}</div> : null;
  return (
    <ul className="item-grid">
      {items.map((item) => (
        <li key={item.id}>
          <Icon name={item.icon} className={ICON_TONE[item.icon ?? ""] ?? "icon-muted"} />
          <span className="item-name">{item.name}</span>
          {item.quantity > 1 && <span className="muted">×{item.quantity}</span>}
        </li>
      ))}
    </ul>
  );
}

function RelationCell({ value }: { value: number }) {
  return <td className={value > 0 ? "rel-pos" : value < 0 ? "rel-neg" : "muted"}>{signed(value)}</td>;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
