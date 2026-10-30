#!/usr/bin/env bash
# End-to-end run on a throwaway repo with the fake engine: init, ticket, spawn, wait, review, land, prune.
# Usage: test/smoke.sh [empty-dir]
set -euo pipefail
ORCH="node $(cd "$(dirname "$0")/.." && pwd)/bin/orch.mjs"
DIR="${1:-$(mktemp -d)}"
unset HERDR_ENV HERDR_PANE_ID
cd "$DIR"
git init -q -b main && git -c user.name=t -c user.email=t@l commit -q --allow-empty -m init
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@l GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@l
$ORCH init >/dev/null
TICKET=$($ORCH ticket new "fake file exists" --active)
git add -A && git commit -qm "orch init + F001"
ID=$($ORCH spawn --engine fake --label "fake file · F001" "Implement F001. Ticket: $TICKET" | tail -1)
$ORCH wait "$ID" > wake.out || { cat wake.out; exit 1; }
grep -q '^\[orch\] DONE' wake.out
grep -q 'open checks (1)' wake.out
test -f ".orch/jobs/$ID/note.md"
REV=$($ORCH review "$ID" --engine fake | tail -1)
$ORCH wait "$REV" | grep -q '^final message' 
grep -q '^PASS ' ".orch/jobs/$REV/result"
$ORCH land "$ID" >/dev/null
test -f fake.txt
ls spec/features/done/*/F001-*/ticket.md >/dev/null
grep -q '^landed: ' spec/features/done/*/F001-*/ticket.md
! git rev-parse --verify -q "orch/$ID" >/dev/null
$ORCH prune | grep -q 'read-only worktree'
test -z "$(git worktree list | grep -v "$DIR " || true)"
echo "smoke ok: $DIR"
