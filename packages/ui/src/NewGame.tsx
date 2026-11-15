import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Portrait, PORTRAIT_IDS } from "./Portrait.tsx";
import type { CreationStatus, NewGameView, RoleChoicesView } from "./types.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 고르기 (12-67): 월드 → 무리 → (떠돌이 동행) → 역할 → (수위) → 캐릭터 (12-77).
 * 화면은 core가 준 단계(newGameView)를 그리고, 고른 것을 채팅과 같은 말로 보낸다. 검증과 계산은 core가 한다.
 * 다 고르면 Claude 세션에서 기다리던 GM이 첫 장면을 서술한다
 */
export function NewGame({ creation }: { creation: CreationStatus }) {
  const { view, gmWorking } = creation;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 단계가 바뀌면 오류를 지운다
  const stepKey = `${view.step}:${view.character?.index.at ?? ""}`;
  useEffect(() => setError(null), [stepKey]);
  // 다음(또는 앞) 단계로 넘어가면 맨 위부터 보이게
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = rootRef.current?.closest(".status-sheet");
    if (scroller) scroller.scrollTop = 0;
  }, [stepKey]);

  const send = async (body: { answer?: string | string[]; back?: boolean; chat?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/creation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) setError(out.error ?? "보내지 못했습니다.");
    } catch {
      setError("Claude 세션과 연결이 끊겼습니다.");
    } finally {
      setBusy(false);
    }
  };
  const answer = (a: string | string[]) => void send({ answer: a });

  return (
    <div className="newgame" ref={rootRef}>
      {gmWorking ? (
        <div className="newgame-wait">
          <div className="newgame-spinner" aria-hidden="true" />
          <p>GM이 쓰신 이야기를 이 세계의 사람과 장소로 옮기고 있습니다. 잠시 뒤 이어서 고르실 수 있습니다.</p>
        </div>
      ) : (
        <Step view={view} busy={busy} answer={answer} />
      )}
      {error && (
        <p className="newgame-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 머리 제목: 지금 단계 (예: 새 게임 · 월드, 무너진 도시, 가람 · 시나리오, 캐릭터 3/7) */
export function newGameTitle(view: NewGameView): string {
  if (view.step === "world") return "새 게임 · 월드";
  if (view.step === "faction" || view.step === "companion" || view.step === "group") return `${view.world?.title} · 무리`;
  if (view.step === "role") return `${view.world?.title} · 계급`;
  if (view.step === "motive" || view.step.startsWith("story")) return `${view.world?.title} · 이야기`;
  if (view.step === "content") return `${view.world?.title} · 수위`;
  if (view.step === "dialogue") return `${view.world?.title} · 서술 방식`;
  const c = view.character;
  const who = view.mode === "heir" ? "새 캐릭터" : "캐릭터";
  return c ? `${who} ${c.index.at}/${c.index.total}` : who;
}

/** 한 단계 뒤로 갈 수 있는지 (처음 단계에서는 못 간다) */
export function canGoBack(view: NewGameView): boolean {
  return !(view.step === "world" || (view.mode === "heir" && view.step === "name" && (view.character?.index.at ?? 1) === 1));
}

type StepProps = { view: NewGameView; busy: boolean; answer: (a: string | string[]) => void };

function Step({ view, busy, answer }: StepProps) {
  switch (view.step) {
    case "world":
      return (
        <>
          <h2 className="newgame-title">어느 월드에서 시작할까요?</h2>
          <div className="choice-list">
            {view.worlds!.map((w) => (
              <WorldCard key={w.id} world={w} busy={busy} start={() => answer(w.id)} />
            ))}
          </div>
          {view.premise && <p className="newgame-premise">{view.premise}</p>}
        </>
      );
    case "faction": {
      const f = view.factions!;
      return (
        <>
          <h2 className="newgame-title">당신은 어느 무리에 속해 있나요?</h2>
          <div className="choice-list">
            {f.list.map((x) => (
              <button key={x.id} type="button" className="choice-card" disabled={busy} onClick={() => answer(x.id)}>
                <strong>{x.name}</strong>
                <span className="choice-desc">{x.about}</span>
              </button>
            ))}
            {f.loner && (
              <button type="button" className="choice-card" disabled={busy} onClick={() => answer(f.loner!)}>
                <strong>떠돌이</strong>
                <span className="choice-desc">어느 무리에도 속하지 않고 담 밖에서 버텨 왔습니다.</span>
              </button>
            )}
          </div>
        </>
      );
    }
    case "companion":
      return <CompanionStep view={view} busy={busy} answer={answer} />;
    case "group":
      return <GroupEditor view={view} busy={busy} answer={answer} />;
    case "role":
      return <RoleStep role={view.role!} busy={busy} answer={answer} />;
    case "motive":
    case "story":
      return <MotiveStory key={view.story!.motive ?? ""} view={view} busy={busy} answer={answer} />;
    case "story_setup":
      return (
        <div className="newgame-wait">
          <div className="newgame-spinner" aria-hidden="true" />
          <p>GM이 이야기를 옮기고 있습니다.</p>
        </div>
      );
    case "story_confirm": {
      const r = view.story!.result!;
      return (
        <>
          <h2 className="newgame-title">이렇게 옮겼습니다</h2>
          <div className="newgame-box">
            {r.opening && (
              <p>
                <strong>첫 장면</strong> {r.opening}
              </p>
            )}
            {r.history.length > 0 && (
              <>
                <p>
                  <strong>세계에 남는 지난 일</strong>
                </p>
                {r.history.map((h, i) => (
                  <p key={i} className="story-part">
                    {h}
                  </p>
                ))}
              </>
            )}
            {r.background.length > 0 && (
              <p>
                <strong>기억</strong> {r.background.join(" ")}
              </p>
            )}
          </div>
          <div className="newgame-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => answer("confirm")}>
              이대로
            </button>
            <button type="button" disabled={busy} onClick={() => answer("remap")}>
              다시 옮기기
            </button>
            <button type="button" disabled={busy} onClick={() => answer("rewrite")}>
              다시 쓰기
            </button>
          </div>
        </>
      );
    }
    case "content":
      return (
        <>
          <h2 className="newgame-title">성인 주제를 다룰까요?</h2>
          <div className="choice-list">
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("off")}>
              <strong>끄기 (기본)</strong>
              <span className="choice-desc">연애나 성적인 이야기는 나오지 않습니다. 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나옵니다.</span>
            </button>
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("on")}>
              <strong>켜기</strong>
              <span className="choice-desc">
                성인 사이의 끌림과 연애(장면은 암전), 성적인 농담·괴롭힘·위협(시도까지만)이 나올 수 있습니다. {view.content!.adultAge}세 미만은 어떤 경우에도 그 대상이
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

/**
 * 떠돌이의 소규모 무리 고치기 (12-77 3단계): 코드가 만든 사람들의 관계·이름·나이·성별을 고치고 더하고 뺀다.
 * 고친 것은 채팅과 같은 말(add, remove N, edit N 키=값, me 키=값)로 보내고, 규칙 확인은 core가 한다
 */
function GroupEditor({ view, busy, answer }: StepProps) {
  const g = view.group!;
  const has = (xs: string[]) => xs.length > 0;
  const ok = g.members.length > 0 && !has(g.problems) && !has(g.me.problems) && g.members.every((m) => !has(m.problems));
  // 글 칸은 다 쓰고 나서(초점이 떠나거나 Enter) 보낸다. 서버가 바꾼 값으로 다시 그려지게 key에 값을 넣는다
  const commit = (cmd: string) => answer(cmd);
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };
  return (
    <>
      <h2 className="newgame-title">누구와 함께 다니나요?</h2>
      <p className="newgame-note">
        관계·이름·나이·성별을 고칠 수 있습니다. {g.max}명까지. 능력과 소지품은 세계가 만들어질 때 정해집니다. 부모·자식은 18살 이상 차이, 배우자는 나와 다른 성별입니다.
      </p>
      <div className="group-list">
        <div className={has(g.me.problems) ? "group-card me bad" : "group-card me"}>
          <div className="group-row">
            <strong className="group-who">나</strong>
            <input
              key={`me-age:${g.me.age}`}
              className="newgame-input group-age"
              type="number"
              inputMode="numeric"
              min={g.meAge.min}
              max={g.meAge.max}
              defaultValue={g.me.age}
              aria-label="내 나이"
              disabled={busy}
              onKeyDown={onEnter}
              onBlur={(e) => Number(e.target.value) !== g.me.age && e.target.value && commit(`me 나이=${Number(e.target.value)}`)}
            />
            <span className="muted small">세</span>
            <select className="newgame-input group-gender" value={g.me.gender} aria-label="내 성별" disabled={busy} onChange={(e) => commit(`me 성별=${e.target.value}`)}>
              {g.genders.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          {g.me.problems.map((p) => (
            <p key={p} className="group-problem">
              {p}
            </p>
          ))}
        </div>
        {g.members.map((m, i) => (
          <div key={i} className={has(m.problems) ? "group-card bad" : "group-card"}>
            <div className="group-row">
              <select className="newgame-input group-relation" value={m.relation} aria-label={`${i + 1}번 관계`} disabled={busy} onChange={(e) => commit(`edit ${i + 1} 관계=${e.target.value}`)}>
                {g.relations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <span className="group-label">{m.label}</span>
              <button type="button" className="group-remove" aria-label={`${m.name} 빼기`} disabled={busy} onClick={() => commit(`remove ${i + 1}`)}>
                ×
              </button>
            </div>
            <div className="group-row">
              <input
                key={`name:${m.name}`}
                className="newgame-input group-name"
                defaultValue={m.name}
                aria-label={`${i + 1}번 이름`}
                disabled={busy}
                onKeyDown={onEnter}
                onBlur={(e) => {
                  const v = e.target.value.trim().replace(/\s+/g, "");
                  if (v && v !== m.name) commit(`edit ${i + 1} 이름=${v}`);
                  else e.target.value = m.name;
                }}
              />
              <input
                key={`age:${m.age}`}
                className="newgame-input group-age"
                type="number"
                inputMode="numeric"
                defaultValue={m.age}
                aria-label={`${i + 1}번 나이`}
                disabled={busy}
                onKeyDown={onEnter}
                onBlur={(e) => Number(e.target.value) !== m.age && e.target.value && commit(`edit ${i + 1} 나이=${Number(e.target.value)}`)}
              />
              <span className="muted small">세</span>
              <select className="newgame-input group-gender" value={m.gender} aria-label={`${i + 1}번 성별`} disabled={busy} onChange={(e) => commit(`edit ${i + 1} 성별=${e.target.value}`)}>
                {g.genders.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            {m.problems.map((p) => (
              <p key={p} className="group-problem">
                {p}
              </p>
            ))}
          </div>
        ))}
      </div>
      {g.problems.map((p) => (
        <p key={p} className="group-problem">
          {p}
        </p>
      ))}
      <div className="newgame-actions">
        {g.members.length < g.max && (
          <button type="button" disabled={busy} onClick={() => commit("add")}>
            + 사람 더하기 ({g.members.length}/{g.max})
          </button>
        )}
        {g.members.length === 0 ? (
          <button type="button" className="primary" disabled={busy} onClick={() => commit("alone")}>
            사실 난 혼자였다
          </button>
        ) : (
          <button type="button" className="primary" disabled={busy || !ok} onClick={() => commit("done")}>
            이대로
          </button>
        )}
      </div>
    </>
  );
}


/** 계급 고르기 (12-84): 무리에서 부르는 계급 이름과 그 자리의 시나리오. 카드를 고르고 시작한다 */
function RoleStep({ role, busy, answer }: { role: RoleChoicesView; busy: boolean; answer: (a: string) => void }) {
  const [picked, setPicked] = useState<string | null>(role.presets.length === 1 ? role.presets[0]!.rank : null);
  const card = (on: boolean) => (on ? "choice-card motive on" : "choice-card motive");
  return (
    <>
      <h2 className="newgame-title">{role.factionName}에서 어떤 계급으로 시작할까요?</h2>
      <div className="choice-list">
        {role.presets.map((p) => (
          <button key={p.roleId} type="button" className={card(picked === p.rank)} aria-pressed={picked === p.rank} disabled={busy} onClick={() => setPicked(p.rank)}>
            <strong>{p.rankLabel}</strong>
            <span className="choice-tagline">{p.title}</span>
            <span className="choice-desc">{p.pitch}</span>
            {p.gains && <span className="choice-gains">받는 것: {p.gains}</span>}
          </button>
        ))}
      </div>
      <p className="newgame-note">계급마다 그 자리에 필요한 솜씨 하나를 받고, 나머지 스킬은 다음에 고르는 과거 배경에서 옵니다.</p>
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || !picked} onClick={() => answer(picked!)}>
          이 계급으로 시작
        </button>
      </div>
    </>
  );
}

/** 떠돌이: 누구와 다니는지 (붕괴 전의 일은 캐릭터를 만들 때 과거 배경으로 고른다) */
function CompanionStep({ view, busy, answer }: StepProps) {
  return (
    <>
      <h2 className="newgame-title">누구와 함께 다니고 있나요?</h2>
      <p className="newgame-note">떠돌이는 무리가 없어 계급도 직분도 없습니다.</p>
      <div className="choice-list">
        {view.companions!.map((c) => (
          <button key={c.id} type="button" className="choice-card" disabled={busy} onClick={() => answer(c.id)}>
            <strong>{c.label}</strong>
            <span className="choice-desc">{c.summary}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** 월드 카드: 누르면 펼쳐져 월드 이야기를 읽고, 맨 아래 단추로 이 월드에서 시작한다 */
function WorldCard({ world, busy, start }: { world: NonNullable<NewGameView["worlds"]>[number]; busy: boolean; start: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "world-card open" : "world-card"}>
      <button type="button" className="world-card-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="world-card-text">
          <strong>{world.title}</strong>
          {world.tagline && <span className="choice-tagline">{world.tagline}</span>}
          {!open && world.description && <span className="choice-desc">{world.description}</span>}
        </span>
        <span className="world-card-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="world-card-body">
          <StoryText text={world.intro ?? world.description} />
          <button type="button" className="primary world-card-start" disabled={busy} onClick={start}>
            이 월드에서 게임 시작
          </button>
        </div>
      )}
    </div>
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

/**
 * 동기와 이야기 (12-77 2단계): 한 화면에서 동기를 고르면 바로 아래에 이야기 칸이 열린다.
 * 보낼 때는 [동기, 이야기]를 한 번에 (채팅은 두 단계로 묻는다). 쓰기 도움: 동기별 예시, 이 도시의 무리와 알 만한 사람
 */
function MotiveStory({ view, busy, answer }: StepProps) {
  const st = view.story!;
  const [picked, setPicked] = useState<string | null>(st.motive);
  const [text, setText] = useState(st.text ?? "");
  const m = st.motives.find((x) => x.id === picked) ?? null;
  return (
    <>
      {st.situation && <Story text={st.situation} title="지금 상황" />}
      <h2 className="newgame-title">무엇이 당신을 움직이나요?</h2>
      <p className="newgame-note">
        {st.title}. 동기를 고르고 그 이야기를 써 주세요. 쓴 이야기 중 일부는 이 세계의 역사로 남습니다.
        {st.situation ? " 이야기 없이 시작해도 됩니다. 지금 상황과 어긋나는 부분은 옮기지 않습니다." : ""}
      </p>
      <div className="motive-grid">
        {st.motives.map((x) => (
          <button key={x.id} type="button" className={picked === x.id ? "choice-card motive on" : "choice-card motive"} aria-pressed={picked === x.id} disabled={busy} onClick={() => setPicked(x.id)}>
            <strong>{x.label}</strong>
            <span className="choice-desc">{x.summary}</span>
          </button>
        ))}
      </div>
      {m && (
        <>
          <p className="newgame-note">{m.prompt} 서너 문장이면 됩니다.</p>
          <textarea className="newgame-textarea" value={text} maxLength={st.maxLength} rows={6} onChange={(e) => setText(e.target.value)} placeholder={m.example ?? "나는…"} />
          {m.example && (
            <button type="button" className="newgame-link" disabled={busy} onClick={() => setText(m.example!)}>
              예시로 채우기
            </button>
          )}
          <details className="newgame-story">
            <summary>이 도시의 무리와 사람들</summary>
            <h4>무리</h4>
            {st.help.factions.map((f) => (
              <p key={f.name}>
                <strong>{f.name}</strong> — {f.about}
              </p>
            ))}
            <h4>이름이 알려진 사람</h4>
            {st.help.people.map((p) => (
              <p key={p.name}>
                <strong>{p.name}</strong> · {p.who}
              </p>
            ))}
            <p className="muted">원수나 잃은 사람을 이 사람들 중에서 고르면, 그 일이 이 세계의 사실이 됩니다.</p>
          </details>
        </>
      )}
      <div className="newgame-actions">
        <button type="button" disabled={busy} onClick={() => answer("skip")}>
          이야기 없이 시작
        </button>
        {m && (
          <>
            <span className="muted small">
              {text.length}/{st.maxLength}
            </span>
            <button type="button" className="primary" disabled={busy || text.trim().length === 0} onClick={() => answer([m.id, text.trim()])}>
              이 이야기로
            </button>
          </>
        )}
      </div>
    </>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function CharacterStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const step = view.step;
  const options = c.options;
  return (
    <>
      {c.situation && c.index.at === 1 && <Story text={c.situation} title="지금 상황" />}
      <Chosen view={view} />
      {step === "past" && <PastStep view={view} busy={busy} answer={answer} />}
      {step === "skill_set" && <SkillStep view={view} busy={busy} answer={answer} />}
      {step === "portrait" && <PortraitStep busy={busy} answer={answer} />}
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
              강점은 약점으로 얻은 포인트만큼만 가질 수 있습니다. 약점 {c.traitLimits.max_negative}개 · 강점 {c.traitLimits.max_positive}개 · 성격 {c.traitLimits.max_personality}개까지.
            </p>
          )}
          <div className={step === "gender" ? "choice-row" : "choice-list"}>
            {options.map((o) => (
              <button key={o.value} type="button" className="choice-card" disabled={busy} onClick={() => answer(o.value)}>
                <strong>{o.label}</strong>
                {o.description && <span className="choice-desc">{o.description}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {step === "ability_set" && (c.tiers ? <TierStep view={view} busy={busy} answer={answer} /> : <PointStep view={view} busy={busy} answer={answer} />)}
      {(step === "traits_pick" || step === "traits_personality") && <TraitStep key={step} view={view} busy={busy} answer={answer} />}
      {step === "confirm" && (
        <>
          <h2 className="newgame-title">이 사람으로 시작할까요?</h2>
          {c.unusedPoints > 0 && <p className="newgame-warn">능력 포인트 {c.unusedPoints}을(를) 쓰지 않았습니다. 이대로 시작하면 사라집니다.</p>}
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

/** 지금까지 정한 것 */
function Chosen({ view }: { view: NewGameView }) {
  const ch = view.character!.chosen;
  if (!ch.past && !ch.name && !ch.gender && ch.abilities.length === 0 && !ch.traits) return null;
  return (
    <div className="newgame-chosen">
      {ch.portrait && <Portrait id={ch.portrait} size={56} />}
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
      </div>
    </div>
  );
}

/** 얼굴 고르기 (이름 다음 단계). 고르지 않으면 실루엣 */
function PortraitStep({ busy, answer }: Pick<StepProps, "busy" | "answer">) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="newgame-form">
      <h2 className="newgame-title">얼굴을 골라 주세요</h2>
      <div className="portrait-grid">
        {PORTRAIT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={picked === id ? "portrait-pick on" : "portrait-pick"}
            disabled={busy}
            aria-pressed={picked === id}
            aria-label={`초상화 ${id}`}
            onClick={() => setPicked(picked === id ? null : id)}
          >
            <Portrait id={id} size={56} />
          </button>
        ))}
      </div>
      <div className="newgame-actions">
        <button type="button" disabled={busy} onClick={() => answer("none")}>
          고르지 않기
        </button>
        <button type="button" className="primary" disabled={busy || !picked} onClick={() => picked && answer(picked)}>
          다음
        </button>
      </div>
    </div>
  );
}

/** 이름 폭: 한글·한자·전각 2, 나머지 1 (core nameWidth와 같은 셈, 표시용. 검증은 core) */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
const nameWidth = (name: string) => [...name].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);

function NameStep({ view, busy, answer }: StepProps) {
  const [name, setName] = useState("");
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
  const [age, setAge] = useState(String(range.default));
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
/** 과거 배경 (12-84): 붕괴 전에 하던 일. 능력·스킬의 기본값과 물건을 준다 */
function PastStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const [picked, setPicked] = useState<string | null>(null);
  const card = (on: boolean) => (on ? "choice-card motive on" : "choice-card motive");
  return (
    <>
      <h2 className="newgame-title">붕괴 전에는 무엇을 했나요?</h2>
      <p className="newgame-note">과거 배경이 능력과 스킬의 기본값을 정합니다. 뒤에서 같은 포인트 안에서 고칠 수 있습니다.</p>
      <div className="motive-grid">
        {c.pasts.map((p) => (
          <button key={p.id} type="button" className={card(picked === p.id)} aria-pressed={picked === p.id} disabled={busy} onClick={() => setPicked(p.id)}>
            <strong>{p.label}</strong>
            <span className="choice-desc">{p.summary}</span>
            <span className="choice-gains">{p.skills}</span>
            <span className="choice-gains">{p.stats}</span>
            {p.items && <span className="choice-gains">{p.items}</span>}
            {p.minAge && <span className="choice-gains">{p.minAge}세부터</span>}
          </button>
        ))}
      </div>
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || !picked} onClick={() => answer(picked!)}>
          이 배경으로
        </button>
      </div>
    </>
  );
}

/** 스킬 고치기 (12-84): 포인트 안에서 스킬마다 +max까지. 과거 배경의 스킬에서 시작한다 */
function SkillStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const rule = c.skillRule ?? { points: 0, max: 1 };
  const [picked, setPicked] = useState<string[]>(() => Object.keys(c.pastDefaults?.skills ?? {}));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < rule.points ? [...p, id] : p));
  const categories = [...new Set(c.moves.map((m) => m.category))];
  return (
    <>
      <h2 className="newgame-title">스킬을 골라 주세요</h2>
      {c.rankSkills && <p className="newgame-note">계급 기본 훈련({c.rankSkills})은 따로 더해집니다.</p>}
      <div className="tier-legend">
        <span className={picked.length === rule.points ? "done" : ""}>
          +{rule.max} · {picked.length}/{rule.points}
        </span>
      </div>
      {categories.map((cat) => (
        <div key={cat}>
          <h3 className="newgame-sub">{cat || "그 밖"}</h3>
          <div className="choice-row">
            {c.moves
              .filter((m) => m.category === cat)
              .map((m) => {
                const on = picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={on ? "chip on" : "chip"}
                    aria-pressed={on}
                    title={m.description}
                    disabled={busy || (!on && picked.length >= rule.points)}
                    onClick={() => toggle(m.id)}
                  >
                    {m.label}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => answer(picked.length ? picked.map((id) => c.moves.find((m) => m.id === id)!.label) : "없음")}>
          {picked.length < rule.points ? `${rule.points - picked.length}포인트 남기고 다음` : "다음"}
        </button>
      </div>
    </>
  );
}

function TierStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const tiers = c.tiers!;
  // 과거 배경이 있으면 그 배치에서 고치기 시작한다 (12-84)
  const [picked, setPicked] = useState<Record<string, number>>(() => Object.fromEntries(Object.entries(c.pastDefaults?.stats ?? {}).filter(([, v]) => v !== 0)));
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
  return (
    <>
      <h2 className="newgame-title">타고난 능력을 골라 주세요</h2>
      <div className="tier-legend">
        {tiers.map((t) => (
          <span key={t.value} className={count(t.value) === t.count ? "done" : ""}>
            {t.label} {signed(t.value)} · {count(t.value)}/{t.count}
          </span>
        ))}
        <span className="muted">나머지 0</span>
      </div>
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
  const [values, setValues] = useState<Record<string, number>>({});
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
function TraitStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const personality = view.step === "traits_personality";
  const [picked, setPicked] = useState<string[]>([]);
  const byId = useMemo(() => new Map(c.traits.map((t) => [t.id, t])), [c.traits]);
  const chosen = picked.map((id) => byId.get(id)!).filter(Boolean);
  const gained = chosen.filter((t) => t.kind === "negative").reduce((n, t) => n + t.cost, 0);
  const used = chosen.filter((t) => t.kind === "positive").reduce((n, t) => n + t.cost, 0);
  const lim = c.traitLimits;
  const countOf = (kind: string) => chosen.filter((t) => t.kind === kind).length;
  const limitOf = (kind: string) => (kind === "negative" ? lim?.max_negative : kind === "positive" ? lim?.max_positive : lim?.max_personality) ?? 99;
  const over = used > gained;
  const blockedBy = (t: (typeof c.traits)[number]) =>
    !picked.includes(t.id) && (countOf(t.kind) >= limitOf(t.kind) || t.opposites.some((o) => picked.includes(o)) || chosen.some((x) => x.opposites.includes(t.id)));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const groups: { kind: string; title: string }[] = personality
    ? [{ kind: "personality", title: "성격" }]
    : [
        { kind: "negative", title: "약점 (포인트를 얻는다)" },
        { kind: "positive", title: "강점 (포인트를 쓴다)" },
      ];
  return (
    <>
      <h2 className="newgame-title">{personality ? "성격을 골라 주세요" : "약점과 강점을 골라 주세요"}</h2>
      {!personality && (
        <p className={over ? "newgame-warn" : "newgame-note"}>
          약점으로 얻은 {gained} · 강점에 쓴 {used}
          {over ? " — 강점이 약점보다 많습니다" : ""} · 약점 {countOf("negative")}/{lim?.max_negative} · 강점 {countOf("positive")}/{lim?.max_positive}
        </p>
      )}
      {personality && <p className="newgame-note">포인트 없음 · {countOf("personality")}/{lim?.max_personality}개까지</p>}
      {groups.map((g) => {
        const list = c.traits.filter((t) => t.kind === g.kind);
        if (list.length === 0) return null;
        return (
          <div key={g.kind}>
            <h3 className="newgame-sub">{g.title}</h3>
            <div className="trait-list">
              {list.map((t) => {
                const on = picked.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`trait-card ${t.kind}${on ? " on" : ""}`}
                    disabled={busy || blockedBy(t)}
                    aria-pressed={on}
                    onClick={() => toggle(t.id)}
                  >
                    <span className="trait-head">
                      <strong>{t.label}</strong>
                      {t.kind !== "personality" && <span className="trait-cost">{t.kind === "negative" ? `+${t.cost}` : `-${t.cost}`}</span>}
                    </span>
                    <span className="choice-desc">{t.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || over} onClick={() => answer(picked)}>
          {picked.length ? `${picked.length}개로 다음` : "고르지 않고 다음"}
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
