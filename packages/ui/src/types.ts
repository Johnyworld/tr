/** 상태 화면의 캐릭터 시트 (core의 playerView, packages/mcp/src/statusServer.ts 가 보낸다) */
export type PlayerView = {
  name: string;
  genderLabel: string | null;
  portrait: string | null;
  age: number | null;
  roleLabel: string;
  timeLabel: string;
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean }[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  traits: { id: string; label: string; kind: TraitKind; description: string }[];
  skills: { id: string; label: string; category: string; value: number }[];
  growth: { level: number; xp: number; next: number; skillPoints: number } | null;
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  present: { id: string; name: string; rankLabel: string; look: string; conditionLabel: string | null }[];
  service: { merit: number; disobedience: number; daysServed: number; promotionMissing: string[] | null };
  mission: { title: string; briefing: string; deadlineLabel: string; requirements: string[] } | null;
  faction: { name: string; moraleLabel: string; rationLabel: string } | null;
  zone: { name: string; owner: string } | null;
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  relations: { id: string; name: string; trust: number; affection: number; respect: number }[];
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};

export type TraitKind = "positive" | "negative" | "personality";
