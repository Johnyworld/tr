import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Portrait, PORTRAIT_IDS } from "./Portrait.tsx";
import { Icon } from "./Icon.tsx";
import type { CreationStatus, NewGameView } from "./types.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 고르기 (12-67): 월드 → 무리 → (떠돌이 동행) → 역할 → (수위) → 캐릭터 (12-77).
 * 화면은 core가 준 단계(newGameView)를 그리고, 고른 것을 채팅과 같은 말로 보낸다. 검증과 계산은 core가 한다.
 * 다 고르면 Claude 세션에서 기다리던 GM이 첫 장면을 서술한다
 */
/**
 * 화면이 보낸 답 (POST /api/creation). 응답에 바뀐 화면(status)이 실려 온다.
 * 부르는 쪽은 busy 풀기와 status 적용을 한 번에 한다: SSE를 기다리면 앞 단계가, 따로 하면 흐린 새 단계가 잠깐 보인다
 */
export type CreationBody = { answer?: string | string[]; back?: boolean; menu?: boolean; version?: number };
export async function postCreation(body: CreationBody): Promise<{ ok: boolean; error?: string; status?: unknown }> {
  try {
    const res = await fetch("/api/creation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as { ok?: boolean; error?: string; status?: unknown };
    return res.ok && out.ok ? { ok: true, status: out.status } : { ok: false, error: out.error ?? "보내지 못했습니다." };
  } catch {
    return { ok: false, error: "Claude 세션과 연결이 끊겼습니다." };
  }
}

/** readOnly: 채팅에서 만드는 중 (12-214). 화면은 진행을 보여 주기만 하고 누를 수 없다 */
/**
 * peek: 시나리오 선택에서 설명을 보고 있는 시나리오 (roleId). 목록 → 설명 → 시작의 두 쪽이고, 머리의 뒤로 단추가 설명에서 목록으로 돌아가야 해서 StatusApp이 쥔다
 */
export function NewGame({
  creation,
  readOnly = false,
  onStatus,
  peek = null,
  onPeek = () => {},
}: {
  creation: CreationStatus;
  readOnly?: boolean;
  onStatus: (status: unknown) => void;
  peek?: string | null;
  onPeek?: (roleId: string | null) => void;
}) {
  const { view, version } = creation;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 단계가 바뀌면 오류를 지운다
  const stepKey = `${view.step}:${view.character?.index.at ?? ""}:${peek ?? ""}`;
  useEffect(() => setError(null), [stepKey]);
  // 다음(또는 앞) 단계로 넘어가면 맨 위부터 보이게
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = rootRef.current?.closest(".status-sheet");
    if (scroller) scroller.scrollTop = 0;
  }, [stepKey]);

  const send = async (body: CreationBody) => {
    setBusy(true);
    setError(null);
    // 보고 있던 판을 함께 보낸다: 그 사이 채팅에서 먼저 진행했으면 서버가 거절한다 (12-214)
    const out = await postCreation({ ...body, version });
    setBusy(false);
    if (out.status) onStatus(out.status);
    if (!out.ok) setError(out.error ?? "보내지 못했습니다.");
  };
  const answer = (a: string | string[]) => void send({ answer: a });

  return (
    <div className={busy ? "newgame busy" : readOnly ? "newgame read-only" : "newgame"} ref={rootRef}>
      {/* 보기 전용이면 fieldset으로 안의 단추·입력을 모두 막는다 */}
      <fieldset className="newgame-fields" disabled={readOnly}>
        <Step view={view} busy={busy} answer={answer} peek={peek} onPeek={onPeek} />
      </fieldset>
      {error && (
        <p className="newgame-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 머리 제목: 지금 단계 (예: 새 게임 · 월드, 무너진 도시 가람 · 시나리오, 캐릭터 3/7) */
export function newGameTitle(view: NewGameView): string {
  if (view.step === "world") return "새 게임 · 월드";
  if (view.step === "scenario") return `${view.world?.title} · 시나리오`;
  if (view.step === "content") return `${view.world?.title} · 수위`;
  if (view.step === "dialogue") return `${view.world?.title} · 서술 방식`;
  const c = view.character;
  const who = view.mode === "heir" ? "새 캐릭터" : "캐릭터";
  return c ? `${who} ${c.index.at}/${c.index.total}` : who;
}

/** 한 단계 뒤로 갈 수 있는지 (처음 단계(first)에서는 못 간다. 새 캐릭터는 캐릭터 만들기의 첫 단계가 처음이다: 과거 배경이 있으면 그것, 없으면 이름) */
export function canGoBack(view: NewGameView): boolean {
  return !(view.first || view.step === "world" || (view.mode === "heir" && (view.character?.index.at ?? 1) === 1));
}

/** 메인 메뉴의 새로운 게임으로 연 만들기는 첫 단계(월드, 월드가 하나뿐이면 시나리오)에서 메인 메뉴로 돌아간다 (12-214) */
export function canGoMenu(creation: CreationStatus): boolean {
  return creation.fromMenu === true && creation.driver === "screen" && creation.view.mode === "new_world" && (creation.view.first === true || creation.view.step === "world");
}

type StepProps = { view: NewGameView; busy: boolean; answer: (a: string | string[]) => void };

function Step({ view, busy, answer, peek, onPeek }: StepProps & { peek: string | null; onPeek: (roleId: string | null) => void }) {
  switch (view.step) {
    case "world":
      return (
        <>
          <h2 className="newgame-title">어느 월드에서 시작할까요?</h2>
          <div className="choice-list">
            {view.worlds!.map((w) => (
              <button key={w.id} type="button" className="choice-card" disabled={busy} onClick={() => answer(w.id)}>
                <strong>{w.title}</strong>
                {w.tagline && <span className="choice-tagline">{w.tagline}</span>}
                {w.description && <span className="choice-desc">{w.description}</span>}
              </button>
            ))}
          </div>
        </>
      );
    case "scenario":
      return <ScenarioStep view={view} busy={busy} answer={answer} peek={peek} onPeek={onPeek} />;
    case "content":
      return (
        <>
          <h2 className="newgame-title">성인 주제를 다룰까요?</h2>
          <div className="choice-list">
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("off")}>
              <strong>끄기 (기본)</strong>
              <span className="choice-desc">성적인 이야기는 나오지 않습니다. 연애는 나오지만 손잡기·입맞춤까지입니다. 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나옵니다.</span>
            </button>
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("on")}>
              <strong>켜기</strong>
              <span className="choice-desc">
                성인 사이의 잠자리(장면은 암전), 성적인 농담·괴롭힘·위협(시도까지만)이 나올 수 있습니다. {view.content!.adultAge}세 미만은 어떤 경우에도 그 대상이
                되지 않습니다.
              </span>
            </button>
          </div>
          <p className="newgame-note">게임 중에도 설정(톱니바퀴)에서 바꿀 수 있습니다.</p>
        </>
      );
    case "dialogue":
      return (
        <>
          <h2 className="newgame-title">이야기를 어떤 방식으로 들을까요?</h2>
          <div className="choice-list">
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("novel")}>
              <strong>소설식 (기본)</strong>
              <span className="choice-desc">대사가 서술 속에 녹아 있습니다.</span>
              <span className="choice-gains">강태호가 담배를 비벼 끄며 "오늘은 동쪽이다"라고 말했다.</span>
            </button>
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("script")}>
              <strong>대본식</strong>
              <span className="choice-desc">대사를 "이름: 대사" 줄로 따로 뗍니다.</span>
              <span className="choice-gains">강태호: "오늘은 동쪽이다."</span>
            </button>
          </div>
          <p className="newgame-note">게임 중에도 설정(톱니바퀴)에서 바꿀 수 있습니다.</p>
        </>
      );
    default:
      return <CharacterStep view={view} busy={busy} answer={answer} />;
  }
}

/** 시나리오 고르기 (기획서 12.4.1): 카드를 누르면 바로 고른다. 잠긴 시나리오는 해금 조건과 함께 흐리게 */
/** 시나리오 선택: 목록(이름과 누구로 시작하는지만) → 설명(짧은 소개·목표와 시작 단추). 잠긴 것은 이름과 해금 조건만 */
function ScenarioStep({ view, busy, answer, peek, onPeek }: StepProps & { peek: string | null; onPeek: (roleId: string | null) => void }) {
  const picked = view.scenarios!.find((c) => c.roleId === peek && !c.locked);
  if (picked)
    return (
      <div className="scenario-detail">
        <h2 className="newgame-title">{picked.title}</h2>
        <span className="choice-tagline">{picked.who}</span>
        <p className="scenario-pitch">{picked.pitch}</p>
        {picked.goal && <p className="choice-gains">목표: {picked.goal}</p>}
        <button type="button" className="primary scenario-start" disabled={busy} onClick={() => answer(picked.roleId)}>
          이 시나리오로 시작
        </button>
      </div>
    );
  return (
    <>
      <h2 className="newgame-title">시나리오 선택</h2>
      <div className="choice-list">
        {view.scenarios!.map((c) =>
          c.locked ? (
            <div key={c.roleId} className="choice-card locked" aria-disabled="true">
              <strong>
                <Icon name="lock" size={14} /> {c.title}
              </strong>
              <span className="choice-desc">해금 조건: {c.locked}</span>
            </div>
          ) : (
            <button key={c.roleId} type="button" className="choice-card" disabled={busy} onClick={() => onPeek(c.roleId)}>
              <strong>{c.title}</strong>
              <span className="choice-tagline">{c.who}</span>
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** 마크다운 조금(## 제목, - 목록)만 읽는 글 */
function StoryText({ text }: { text: string }) {
  const blocks = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="story-text">
      {blocks.map((line, i) =>
        line.startsWith("#") ? (
          <h4 key={i}>{line.replace(/^#+\s*/, "")}</h4>
        ) : line.startsWith("- ") ? (
          <p key={i} className="story-item">
            {line.slice(2)}
          </p>
        ) : (
          <p key={i}>{line}</p>
        ),
      )}
    </div>
  );
}

/** 접는 이야기 상자 (지금 상황 등) */
function Story({ text, title }: { text: string; title?: string }) {
  return (
    <details className="newgame-story" open>
      <summary>{title ?? "이야기"}</summary>
      <StoryText text={text} />
    </details>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 뒤로 왔을 때 이 단계에 전에 골라 둔 값 (없으면 undefined) */
const rememberedOf = (view: NewGameView) => (view.character?.remembered?.step === view.step ? view.character.remembered : undefined);
/** 전에 고른 보기인지 (눌러서 바로 고르는 단계에서 표시만 한다) */
const wasPicked = (view: NewGameView, value: string | null) => {
  const r = rememberedOf(view);
  return r !== undefined && r.value === value;
};

function CharacterStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const step = view.step;
  const options = c.options;
  // 고르는 중인 단계의 남은 수 (능력·스킬·트레잇): 위의 현황 카드에 보인다
  const [live, setLive] = useState<{ step: string; text: string; bad?: boolean } | null>(null);
  const onLive = useCallback((text: string, bad = false) => setLive({ step, text, bad }), [step]);
  return (
    <>
      <Chosen view={view} live={live?.step === step ? live : null} />
      {step === "past" && <PastStep view={view} busy={busy} answer={answer} />}
      {step === "skill_set" && <SkillStep view={view} busy={busy} answer={answer} onLive={onLive} />}
      {step === "portrait" && <PortraitStep view={view} busy={busy} answer={answer} />}
      {step === "name" && <NameStep view={view} busy={busy} answer={answer} />}
      {step === "age" && <AgeStep view={view} busy={busy} answer={answer} />}
      {(step === "gender" || step === "abilities" || step === "skills" || step === "traits") && (
        <>
          <h2 className="newgame-title">
            {step === "gender"
              ? "성별을 골라 주세요"
              : step === "abilities"
                ? "타고난 능력은 어떻게 정할까요?"
                : step === "skills"
                  ? "몸에 익은 솜씨(스킬)는 어떻게 할까요?"
                  : "타고난 기질과 버릇(트레잇)은 어떻게 할까요?"}
          </h2>
          {step === "abilities" && (
            <p className="newgame-note">
              {c.tiers
                ? `${c.pastDefaults ? "고치면 과거 배경의 배치에서 시작합니다. " : ""}직접 정하면 ${c.tiers.map((t) => `${t.label}(${signed(t.value)}) ${t.count}개`).join(", ")}를 고르고 나머지는 보통(0)입니다.`
                : `모두 0에서 시작해 ${c.points?.total ?? 0}포인트를 나눠 씁니다.`}
            </p>
          )}
          {step === "traits" && c.traitLimits && (
            <p className="newgame-note">
              강점은 약점으로 얻은 포인트만큼만 가질 수 있습니다. 약점 {c.traitLimits.max_negative}개 · 강점 {c.traitLimits.max_positive}개까지{c.traitLimits.max_phobia !== undefined ? ` · 공포증 ${c.traitLimits.max_phobia}개까지` : ""}
              {c.traitLimits.max_personality !== undefined ? `, 성격 ${c.traitLimits.max_personality}개까지` : ", 성격은 몇 개든"}.
            </p>
          )}
          <div className={step === "gender" ? "choice-row" : "choice-list"}>
            {options.map((o) => (
              <button key={o.value} type="button" className={wasPicked(view, o.value) ? "choice-card remembered" : "choice-card"} disabled={busy} onClick={() => answer(o.value)}>
                <strong>{o.label}</strong>
                {o.description && <span className="choice-desc">{o.description}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {step === "ability_set" && (c.tiers ? <TierStep view={view} busy={busy} answer={answer} onLive={onLive} /> : <PointStep view={view} busy={busy} answer={answer} />)}
      {(step === "traits_pick" || step === "traits_personality") && <TraitStep key={step} view={view} busy={busy} answer={answer} onLive={onLive} />}
      {step === "persona" && <PersonaStep view={view} busy={busy} answer={answer} />}
      {step === "settings" && <SettingsStep view={view} busy={busy} answer={answer} />}
      {step === "confirm" && (
        <>
          <h2 className="newgame-title">이 사람으로 시작할까요?</h2>
          {c.unusedPoints > 0 && <p className="newgame-warn">능력 포인트 {c.unusedPoints}점을 쓰지 않았습니다. 이대로 시작하면 사라집니다.</p>}
          <div className="newgame-actions">
            {options.map((o) => (
              <button key={o.value} type="button" className={o.value === "start" ? "primary" : ""} disabled={busy} onClick={() => answer(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** 지금까지 정한 것 (위에 붙어 있다). live: 고르는 중인 단계의 남은 수 */
function Chosen({ view, live }: { view: NewGameView; live: { text: string; bad?: boolean } | null }) {
  const ch = view.character!.chosen;
  if (!ch.past && !ch.name && !ch.gender && ch.abilities.length === 0 && !ch.traits && !live) return null;
  return (
    <div className="newgame-chosen">
      {ch.portrait && <Portrait id={ch.portrait} pack={view.world?.id} size={56} />}
      <div className="chosen-info">
        {ch.name && <div className="chosen-name">{ch.name}</div>}
        {ch.past && <div className="muted small">과거: {ch.past}</div>}
        {(ch.gender || ch.age) && <div className="muted small">{[ch.gender, ch.age ? `${ch.age}세` : null].filter(Boolean).join(" · ")}</div>}
        {ch.abilities.length > 0 && (
          <div className="chosen-stats">
            {ch.abilities.map((a) => (
              <span key={a.label} className={a.value > 0 ? "up" : a.value < 0 ? "down" : ""}>
                {a.label} {signed(a.value)}
              </span>
            ))}
          </div>
        )}
        {ch.skills && <div className="muted small">스킬: {ch.skills.length ? ch.skills.map((x) => `${x.label} ${signed(x.value)}`).join(", ") : "없음"}</div>}
        {ch.traits && <div className="muted small">트레잇: {ch.traits.length ? ch.traits.join(", ") : "없음"}</div>}
        {ch.persona && <div className="muted small">성격: {ch.persona}</div>}
        {ch.settings && ch.settings.length > 0 && <div className="muted small">설정: {ch.settings.join(", ")}</div>}
        {live && <div className={live.bad ? "chosen-live bad" : "chosen-live"}>{live.text}</div>}
      </div>
    </div>
  );
}

/**
 * 얼굴 고르기 (성별 다음 단계, 12-139). 고른 성별의 얼굴을 화풍 섹션으로 보인다.
 * 월드에 초상화 목록이 없으면 코드로 그린 실루엣 12종. 고르지 않으면 실루엣
 */
function PortraitStep({ view, busy, answer }: StepProps) {
  const sections = view.character!.portraits ?? [];
  const pack = view.world?.id;
  // 누르면 바로 고른다 (다음 단계로 넘어간다)
  const pick = (id: string, size: number, square: boolean, number?: number) => (
    <button
      key={id}
      type="button"
      className={wasPicked(view, id) ? "portrait-pick remembered" : "portrait-pick"}
      disabled={busy}
      aria-label={number !== undefined ? `초상화 ${number}` : `초상화 ${id}`}
      onClick={() => answer(id)}
    >
      <Portrait id={id} pack={pack} size={size} square={square} />
      {number !== undefined && <span className="portrait-number">{number}</span>}
    </button>
  );
  // 화풍이 하나뿐이면 화풍 이름은 보이지 않는다
  const titled = sections.length > 1;
  return (
    <div className="newgame-form">
      <h2 className="newgame-title">얼굴을 골라 주세요</h2>
      {sections.length > 0 ? (
        sections.map((sec) => (
          <section key={sec.style} className="portrait-section">
            {titled && <h3 className="portrait-section-title">{sec.label}</h3>}
            <div className="portrait-grid portrait-grid-art">{sec.faces.map((id, i) => pick(id, 96, true, sec.numbered ? i + 1 : undefined))}</div>
          </section>
        ))
      ) : (
        <div className="portrait-grid">{PORTRAIT_IDS.map((id) => pick(id, 56, false))}</div>
      )}
      <div className="newgame-actions">
        <button type="button" className={wasPicked(view, null) ? "remembered" : undefined} disabled={busy} onClick={() => answer("none")}>
          고르지 않기
        </button>
      </div>
    </div>
  );
}

/** 이름 폭: 한글·한자·전각 2, 나머지 1 (core nameWidth와 같은 셈, 표시용. 검증은 core) */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
const nameWidth = (name: string) => [...name].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);

function NameStep({ view, busy, answer }: StepProps) {
  const [name, setName] = useState(() => String(rememberedOf(view)?.value ?? ""));
  const max = view.character!.nameMax;
  const width = nameWidth(name.trim());
  const over = width > max;
  return (
    <form
      className="newgame-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !over) answer(name.trim());
      }}
    >
      <h2 className="newgame-title">이름을 정해 주세요</h2>
      <div className="newgame-inline">
        <input className="newgame-input" value={name} maxLength={max} autoFocus onChange={(e) => setName(e.target.value)} placeholder={`한글 ${max / 2}자, 영문 ${max}자까지`} />
        <button type="submit" className="primary" disabled={busy || !name.trim() || over}>
          다음
        </button>
      </div>
      {over && <p className="newgame-warn">이름이 너무 깁니다. 한글 {max / 2}자, 영문 {max}자까지입니다.</p>}
    </form>
  );
}

/** 나이: 숫자로 적거나 시나리오의 나이 그대로 */
function AgeStep({ view, busy, answer }: StepProps) {
  const range = view.character!.age!;
  const [age, setAge] = useState(() => String(rememberedOf(view)?.value ?? range.default));
  const n = Number(age);
  const ok = Number.isInteger(n) && n >= range.min && n <= range.max;
  return (
    <form
      className="newgame-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) answer(String(n));
      }}
    >
      <h2 className="newgame-title">나이를 정해 주세요</h2>
      <p className="newgame-note">
        {range.min}~{range.max}세. 이 시나리오의 기본은 {range.default}세입니다.
      </p>
      <div className="newgame-inline">
        <input
          className="newgame-input"
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          value={age}
          autoFocus
          onChange={(e) => setAge(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !ok}>
          다음
        </button>
      </div>
    </form>
  );
}

/** 등급 고르기: 능력마다 등급 단추. 등급별 개수가 다 차면 다음 */
/** 과거 배경 (12-84): 붕괴 전에 하던 일. 능력·스킬의 기본값과 물건을 준다. 누르면 바로 고른다 */
function PastStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  return (
    <>
      <h2 className="newgame-title">붕괴 전에는 무엇을 했나요?</h2>
      <p className="newgame-note">과거 배경이 능력과 스킬의 기본값을 정합니다. 뒤에서 같은 포인트 안에서 고칠 수 있습니다.</p>
      <div className="past-grid">
        {c.pasts.map((p) => (
          <button key={p.id} type="button" className={wasPicked(view, p.id) ? "past-card remembered" : "past-card"} disabled={busy} onClick={() => answer(p.id)}>
            <span className="past-head">
              <strong>{p.label}</strong>
              {p.minAge && <span className="past-age">{p.minAge}세부터</span>}
            </span>
            <span className="past-line">{p.skills}</span>
            <span className="past-line">{p.stats}</span>
            {p.items && <span className="past-line muted">{p.items}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 스킬 고치기 (4.2.1): 과거 배경의 배치(12점)에서 시작해 스킬마다 − / +로 단계를 정한다.
 * 올리는 값은 단계마다 다르다 (-1→0 1점, 0→+1 2점, +1→+2 3점). 전문 기술은 과거가 가르쳐 준 것과 자리가 주는 것만. 남은 점수는 위의 현황 카드에
 */
function SkillStep({ view, busy, answer, onLive }: StepProps & { onLive: (text: string) => void }) {
  const c = view.character!;
  const rule = c.skillRule ?? { points: 0, min: -1, max: 2, costs: [] };
  const teachable = c.teachable ?? [];
  const [layout, setLayout] = useState<Record<string, number>>(() => ({ ...(rememberedOf(view)?.values ?? c.pastDefaults?.skills ?? {}) }));
  const costTo = (v: number) => Array.from({ length: Math.max(0, v - rule.min) }, (_, i) => rule.costs[i] ?? 1).reduce((a, b) => a + b, 0);
  const spent = Object.values(layout).reduce((n, v) => n + costTo(v), 0);
  const left = rule.points - spent;
  const valueOf = (id: string) => layout[id] ?? rule.min;
  const step = (id: string, d: number) =>
    setLayout((p) => {
      const v = (p[id] ?? rule.min) + d;
      const next = { ...p, [id]: v };
      if (v <= rule.min && !teachable.includes(id)) delete next[id];
      return next;
    });
  const categories = [...new Set(c.moves.map((m) => m.category))];
  useEffect(() => onLive(`남은 스킬 포인트 ${left}`), [left, onLive]);
  const tierLabel = (kind: string, v: number) => (v <= rule.min ? (kind === "expert" ? "배움" : "미숙") : ({ 0: "할 수 있음", 1: "숙련", 2: "마스터" } as Record<number, string>)[v] ?? "");
  const submit = () => {
    const parts = c.moves.filter((m) => layout[m.id] !== undefined && (layout[m.id]! > rule.min || m.kind === "expert")).map((m) => `${m.label} ${signed(layout[m.id]!)}`);
    answer(parts.length ? parts.join(", ") : "없음");
  };
  return (
    <>
      <h2 className="newgame-title">스킬을 정해 주세요</h2>
      <p className="newgame-note">
        {rule.points}점을 나눕니다. 0은 1점, +1 숙련은 3점, +2 마스터는 6점입니다. 누구나 하는 일은 찍지 않아도 -1로 할 수 있고, 전문 기술은 배운 것만 할 수 있습니다.
        {c.grantedSkills ? ` 자리가 요구하는 ${c.grantedSkills}은 점수 없이 배운 상태로 받습니다.` : ""} 남긴 점수는 레벨업 점수와 함께 나중에 씁니다.
      </p>
      {categories.map((cat) => (
        <div key={cat}>
          <h3 className="newgame-sub">{cat || "그 밖"}</h3>
          <div className="skill-grid">
            {c.moves
              .filter((m) => m.category === cat)
              .map((m) => {
                const locked = m.kind === "expert" && !teachable.includes(m.id);
                const v = valueOf(m.id);
                const up = v < rule.max ? (rule.costs[v - rule.min] ?? 1) : null;
                return (
                  <div key={m.id} className={v > rule.min ? "skill-card on" : locked ? "skill-card locked" : "skill-card"}>
                    <span className="past-head">
                      <strong>{m.label}</strong>
                      {m.stats && <span className="past-age">{m.kind === "expert" ? "전문 · " : ""}{m.stats}</span>}
                    </span>
                    {m.description && <span className="skill-desc">{m.description}</span>}
                    <span className="skill-level">
                      {locked ? (
                        <span className="muted small">못 함 (배워야 한다)</span>
                      ) : (
                        <>
                          <button type="button" className="skill-step" disabled={busy || v <= rule.min} aria-label={`${m.label} 내리기`} onClick={() => step(m.id, -1)}>
                            −
                          </button>
                          <span>
                            {signed(v)} <span className="muted small">{tierLabel(m.kind ?? "common", v)}</span>
                          </span>
                          <button
                            type="button"
                            className="skill-step"
                            disabled={busy || up === null || left < up}
                            title={up === null ? "최고 단계" : `${up}점`}
                            aria-label={`${m.label} 올리기`}
                            onClick={() => step(m.id, 1)}
                          >
                            +
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || left < 0} onClick={submit}>
          {left > 0 ? `${left}점 남기고 다음` : "다음"}
        </button>
      </div>
    </>
  );
}

function TierStep({ view, busy, answer, onLive }: StepProps & { onLive: (text: string) => void }) {
  const c = view.character!;
  const tiers = c.tiers!;
  // 과거 배경이 있으면 그 배치에서 고치기 시작한다 (12-84)
  const [picked, setPicked] = useState<Record<string, number>>(() => Object.fromEntries(Object.entries(rememberedOf(view)?.values ?? c.pastDefaults?.stats ?? {}).filter(([, v]) => v !== 0)));
  const count = (v: number) => Object.values(picked).filter((x) => x === v).length;
  const full = tiers.every((t) => count(t.value) === t.count);
  const toggle = (id: string, v: number) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[id] === v) delete next[id];
      else if (count(v) < (tiers.find((t) => t.value === v)?.count ?? 0)) next[id] = v;
      return next;
    });
  const submit = () => answer(tiers.map((t) => Object.keys(picked).filter((id) => picked[id] === t.value).join(", ")).join(" / "));
  // 골라야 하는 수 (등급별 개수의 합)에서 고른 수를 뺀 것
  const left = tiers.reduce((n, t) => n + t.count, 0) - Object.keys(picked).length;
  useEffect(() => onLive(`남은 선택 ${left}`), [left, onLive]);
  return (
    <>
      <h2 className="newgame-title">타고난 능력을 골라 주세요</h2>
      <p className="newgame-note">{tiers.map((t) => `${signed(t.value)} ${t.count}개`).join(", ")}를 고르고, 나머지는 0입니다.</p>
      <div className="tier-table">
        {c.stats.map((s) => (
          <div key={s.id} className="tier-row">
            <div className="tier-stat">
              <strong>{s.label}</strong>
              <span className="muted small">{s.description}</span>
            </div>
            <div className="tier-buttons">
              {tiers.map((t) => {
                const on = picked[s.id] === t.value;
                const blocked = !on && count(t.value) >= t.count;
                return (
                  <button
                    key={t.value}
                    type="button"
                    className={`tier-btn ${t.value > 0 ? "up" : "down"}${on ? " on" : ""}`}
                    disabled={busy || blocked}
                    aria-pressed={on}
                    title={t.label}
                    onClick={() => toggle(s.id, t.value)}
                  >
                    {signed(t.value)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || !full} onClick={submit}>
          다음
        </button>
      </div>
    </>
  );
}

/** (등급이 없는 월드) 포인트 나누기. 남은 포인트 표시는 비용표로 세고, 맞는지는 core가 본다 */
function PointStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const p = c.points!;
  const [values, setValues] = useState<Record<string, number>>(() => ({ ...(rememberedOf(view)?.values ?? {}) }));
  const values0 = p.cost.map((x) => x.value);
  const min = Math.min(...values0, 0);
  const max = Math.max(...values0, 0);
  const costOf = (v: number) => p.cost.find((x) => x.value === v)?.cost ?? 0;
  const spent = Object.values(values).reduce((n, v) => n + costOf(v), 0);
  const set = (id: string, v: number) => setValues((x) => ({ ...x, [id]: Math.max(min, Math.min(max, v)) }));
  return (
    <>
      <h2 className="newgame-title">타고난 능력을 골라 주세요</h2>
      <p className="newgame-note">
        남은 포인트 {p.total - spent} · 0보다 낮추면 포인트를 돌려받습니다 ({p.maxLow}개까지)
      </p>
      <div className="tier-table">
        {c.stats.map((s) => (
          <div key={s.id} className="tier-row">
            <div className="tier-stat">
              <strong>{s.label}</strong>
              <span className="muted small">{s.description}</span>
            </div>
            <div className="tier-buttons">
              <button type="button" className="tier-btn" disabled={busy} onClick={() => set(s.id, (values[s.id] ?? 0) - 1)}>
                −
              </button>
              <span className="tier-value">{signed(values[s.id] ?? 0)}</span>
              <button type="button" className="tier-btn" disabled={busy} onClick={() => set(s.id, (values[s.id] ?? 0) + 1)}>
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="newgame-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            answer(
              Object.entries(values)
                .filter(([, v]) => v !== 0)
                .map(([id, v]) => `${id} ${signed(v)}`)
                .join(", ") || `${c.stats[0]?.id ?? ""} 0`,
            )
          }
        >
          다음
        </button>
      </div>
    </>
  );
}

/** 트레잇 고르기: 약점·강점은 한 표(포인트 잔액), 성격은 따로 */
function TraitStep({ view, busy, answer, onLive }: StepProps & { onLive: (text: string, bad?: boolean) => void }) {
  const c = view.character!;
  const personality = view.step === "traits_personality";
  const [picked, setPicked] = useState<string[]>(() => {
    const r = rememberedOf(view)?.value;
    return Array.isArray(r) ? r : [];
  });
  const byId = useMemo(() => new Map(c.traits.map((t) => [t.id, t])), [c.traits]);
  const chosen = picked.map((id) => byId.get(id)!).filter(Boolean);
  const gained = chosen.filter((t) => t.kind === "negative").reduce((n, t) => n + t.cost, 0);
  const spent = chosen.filter((t) => t.kind === "positive").reduce((n, t) => n + t.cost, 0);
  const lim = c.traitLimits;
  const countOf = (kind: string) => chosen.filter((t) => t.kind === kind).length;
  const limitOf = (kind: string) => (kind === "negative" ? lim?.max_negative : kind === "positive" ? lim?.max_positive : lim?.max_personality) ?? 99;
  const over = spent > gained;
  const blockedBy = (t: (typeof c.traits)[number]) =>
    !picked.includes(t.id) && (countOf(t.kind) >= limitOf(t.kind) || t.opposites.some((o) => picked.includes(o)) || chosen.some((x) => x.opposites.includes(t.id)));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // 남은 포인트: 약점으로 얻고 강점에 쓴다 (0에서 시작). 성격은 포인트 없이 남은 개수
  const live = personality ? `고른 성격 ${countOf("personality")}` : `남은 포인트 ${gained - spent}`;
  useEffect(() => onLive(live, over), [live, over, onLive]);

  // 반대되는 것끼리 한 줄에 (왼쪽·오른쪽). 하나를 고르면 맞은편은 막힌다. 짝이 없는 것은 아래에 따로
  type T = (typeof c.traits)[number];
  const pool = c.traits.filter((t) => (personality ? t.kind === "personality" : t.kind !== "personality"));
  const used = new Set<string>();
  const pairs: [T | null, T][] = [];
  const firsts = personality ? pool : pool.filter((t) => t.kind === "negative");
  const opposed = (a: T, b: T) => a.opposites.includes(b.id) || b.opposites.includes(a.id);
  for (const t of firsts) {
    if (used.has(t.id)) continue;
    // 반대가 여럿이면 값이 가장 가까운 것과 짝 (험악한 인상 1 ↔ 호감형 외모 1)
    const partner = pool
      .filter((o) => !used.has(o.id) && o.id !== t.id && opposed(t, o) && (personality || o.kind === "positive"))
      .sort((a, b) => Math.abs(a.cost - t.cost) - Math.abs(b.cost - t.cost))[0];
    if (!partner) continue;
    used.add(t.id);
    used.add(partner.id);
    pairs.push([t, partner]);
    // 짝을 못 찾은 같은 계열 강점은 바로 아래 오른쪽에 (아름다운 외모는 호감형 외모 아래)
    for (const o of pool) {
      if (used.has(o.id) || personality || o.kind !== "positive" || !opposed(t, o)) continue;
      used.add(o.id);
      pairs.push([null, o]);
    }
  }
  const singles = pool.filter((t) => !used.has(t.id));
  const card = (t: T) => {
    const on = picked.includes(t.id);
    return (
      <button key={t.id} type="button" className={`trait-card ${t.kind}${on ? " on" : ""}`} disabled={busy || blockedBy(t)} aria-pressed={on} onClick={() => toggle(t.id)}>
        <span className="trait-head">
          <strong>{t.label}</strong>
          {t.kind !== "personality" && <span className="trait-cost">{t.kind === "negative" ? `+${t.cost}` : `-${t.cost}`}</span>}
        </span>
        <span className="choice-desc">{t.description}</span>
      </button>
    );
  };
  return (
    <>
      <h2 className="newgame-title">{personality ? "성격을 골라 주세요" : "약점과 강점을 골라 주세요"}</h2>
      <p className="newgame-note">
        {personality
          ? "성격은 GM이 이 사람을 그릴 때의 말투와 태도입니다. 몇 개든 고를 수 있고, 반대되는 것끼리는 함께 고를 수 없습니다."
          : "약점을 고르면 포인트를 얻고, 그 포인트로 강점을 고릅니다. 반대되는 것끼리는 함께 고를 수 없습니다."}
      </p>
      {!personality && (
        <div className="trait-pair-head">
          <span>약점 (포인트를 얻는다)</span>
          <span>강점 (포인트를 쓴다)</span>
        </div>
      )}
      <div className="trait-pairs">
        {pairs.map(([l, r]) => (
          <div key={r.id} className="trait-pair">
            {l ? card(l) : <div className="trait-empty" aria-hidden="true" />}
            {card(r)}
          </div>
        ))}
      </div>
      {singles.length > 0 && (
        <>
          <h3 className="newgame-sub">{personality ? "그 밖의 성격" : "짝이 없는 것"}</h3>
          <div className="trait-pairs">
            <div className="trait-single">{singles.map(card)}</div>
          </div>
        </>
      )}
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || over} onClick={() => answer(picked)}>
          {picked.length ? `${picked.length}개로 다음` : "고르지 않고 다음"}
        </button>
      </div>
    </>
  );
}

/** 성격 (12-99): 축마다 다섯 칸 (2 1 0 1 2), 기본 0. 답은 채팅과 같은 말 ("다혈질 2, 과묵함 1" / "기본") */
function PersonaStep({ view, busy, answer }: StepProps) {
  const axes = view.character!.personaAxes ?? [];
  const [values, setValues] = useState<Record<string, number>>(() => ({ ...(rememberedOf(view)?.values ?? {}) }));
  const submit = () => {
    const parts = axes.filter((a) => values[a.id]).map((a) => `${values[a.id]! > 0 ? a.high : a.low} ${Math.abs(values[a.id]!)}`);
    answer(parts.length ? parts.join(", ") : "기본");
  };
  return (
    <>
      <h2 className="newgame-title">어떤 성격인가요?</h2>
      <p className="newgame-note">양 끝은 캐릭터의 성격이 강하게 드러냅니다. GM이 말투와 태도를 이 성격대로 그립니다. 그리고 사회 관계에 영향이 있을 수도 있습니다.</p>
      <div className="persona-table">
        {axes.map((a) => (
          <div key={a.id} className="persona-row">
            <span className="persona-side low">{a.low}</span>
            <div className="persona-buttons">
              {[-2, -1, 0, 1, 2].map((v) => {
                const on = (values[a.id] ?? 0) === v;
                return (
                  <button
                    key={v}
                    type="button"
                    className={`persona-btn${on ? " on" : ""}${v === 0 ? " mid" : ""}`}
                    disabled={busy}
                    aria-pressed={on}
                    aria-label={v === 0 ? `${a.low}·${a.high} 보통` : `${v > 0 ? a.high : a.low} ${Math.abs(v)}`}
                    onClick={() => setValues((x) => ({ ...x, [a.id]: v }))}
                  >
                  </button>
                );
              })}
            </div>
            <span className="persona-side high">{a.high}</span>
          </div>
        ))}
      </div>
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy} onClick={submit}>
          다음
        </button>
      </div>
    </>
  );
}

/**
 * 캐릭터 설정 (4.6.4): 칸마다 고르거나 건너뛴다. 못 고르는 것은 흐리게 까닭과 함께("다혈질 2 필요", "함께 고를 수 없음: ○○").
 * 답은 채팅과 같은 말 (이름을 쉼표로, 없으면 "없음")
 */
function SettingsStep({ view, busy, answer }: StepProps) {
  const data = view.character!.settings;
  const [picked, setPicked] = useState<string[]>(() => {
    const r = rememberedOf(view)?.value;
    return Array.isArray(r) ? r : [];
  });
  if (!data) return null;
  const nameOf = (id: string) => data.items.find((x) => x.id === id)?.name ?? id;
  const toggle = (id: string, slot: string, max: number) =>
    setPicked((p) => {
      if (p.includes(id)) return p.filter((x) => x !== id);
      const inSlot = p.filter((x) => data.items.find((i) => i.id === x)?.slot === slot);
      // 칸이 차면 가장 먼저 고른 것을 바꾼다 (하나짜리 칸은 바꿔 고르기)
      const kept = inSlot.length >= max ? p.filter((x) => x !== inSlot[0]) : p;
      return [...kept, id];
    });
  const blockedBy = (item: (typeof data.items)[number]) => picked.filter((x) => item.opposites.includes(x) || (data.items.find((i) => i.id === x)?.opposites ?? []).includes(item.id));
  return (
    <>
      <h2 className="newgame-title">설정을 골라 주세요</h2>
      <p className="newgame-note">
        성격이 어떻게 말하고 대하는지라면, 설정은 무엇을 믿고, 하지 않고, 몸에 배었는지입니다. 모두 건너뛰어도 됩니다. 보상은 없고, 이상·금기·결점을 거스르는 행동은 그때 정신력으로 굴립니다.
      </p>
      {data.slots.map((slot) => (
        <div key={slot.id}>
          <h3 className="newgame-sub">
            {slot.label} <span className="muted small">({slot.hint}, {slot.max}개까지)</span>
          </h3>
          <div className="choice-list">
            {data.items
              .filter((x) => x.slot === slot.id)
              .map((item) => {
                const on = picked.includes(item.id);
                const against = blockedBy(item);
                const reasons = [...item.reasons, ...(against.length ? [`함께 고를 수 없음: ${against.map(nameOf).join(", ")}`] : [])];
                const disabled = busy || (!on && reasons.length > 0);
                return (
                  <button key={item.id} type="button" className={`choice-card${on ? " featured" : ""}${disabled && !on ? " locked" : ""}`} disabled={disabled} aria-pressed={on} onClick={() => toggle(item.id, slot.id, slot.max)}>
                    <strong>{item.name}</strong>
                    <span className="choice-desc">
                      {item.description}
                      {reasons.length > 0 && <span className="muted"> · {reasons.join(", ")}</span>}
                      {item.clash && <span className="muted"> · 이 시나리오와 자주 부딪힘</span>}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      <div className="newgame-actions">
        <button type="button" disabled={busy} onClick={() => answer("없음")}>
          모두 건너뛰기
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => answer(picked.length ? picked.map(nameOf).join(", ") : "없음")}>
          다음
        </button>
      </div>
    </>
  );
}

export function CreatedToast({ onClose }: { onClose: () => void }): ReactNode {
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="created-toast" role="status">
      캐릭터를 만들었습니다. Claude 세션에서 첫 장면이 이어집니다.
      <button type="button" aria-label="닫기" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
