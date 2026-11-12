#!/bin/sh
# Claude Code 훅 (기획서 11.6 상태 화면의 턴 문): MCP 상태 화면을 플레이어 메시지 때 멈추고(start), 답변이 끝나면 푼다(end).
# 대화 기록에서 이 세션이 마지막으로 연 세계 id([trpg-world:ID])를 찾아, 켜져 있는 상태 서버(8790~8799)에 보낸다.
# 서버는 자기 세계 id와 같을 때만 따른다. 아무것도 출력하지 않고 언제나 성공으로 끝난다 (게임을 하지 않는 세션에도 영향이 없게).
action="$1"
input=$(cat)
path=$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$path" ] && [ -f "$path" ] || exit 0
world=$(tail -c 3000000 "$path" 2>/dev/null | grep -o 'trpg-world:[A-Za-z0-9_-]\{4,\}' | tail -n 1 | sed 's/trpg-world://')
[ -n "$world" ] || exit 0
port=${TRPG_STATUS_PORT:-8790}
last=$((port + 9))
while [ "$port" -le "$last" ]; do
  curl -s -m 0.5 -X POST "http://127.0.0.1:$port/api/turn/$action?world=$world" >/dev/null 2>&1 &
  port=$((port + 1))
done
wait
exit 0
