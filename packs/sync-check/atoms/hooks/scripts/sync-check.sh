#!/bin/sh
# agentpack.sync-check — SessionStart update nudge (sync S4, docs/sync-design.md §5).
#
# Contract: READ-ONLY and OFFLINE-SILENT. `agentpack update --check` never
# writes anything; every failure path here — missing agentpack binary, no
# network, no packs installed, hung server, unexpected exit code — produces
# NO output and exits 0. A nudge that errors on every session start is worse
# than no nudge. The ONLY thing that ever prints is the one-line nudge when
# a check exits 10 ("update available").

command -v agentpack >/dev/null 2>&1 || exit 0

# Bounded runtime so a slow network can never stall session start. `timeout`
# is absent on stock macOS — degrade to an unbounded run rather than erroring
# (the host tool's own hook timeout still applies).
run_check() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${AGENTPACK_SYNC_CHECK_TIMEOUT:-10}" agentpack "$@" >/dev/null 2>&1
  else
    agentpack "$@" >/dev/null 2>&1
  fi
}

nudge=0

# Project scope: exit 10 = update available; anything else stays silent.
run_check update --check --quiet --project "${CLAUDE_PROJECT_DIR:-.}"
[ $? -eq 10 ] && nudge=1

# User scope (~/.claude, sync S3) — only when a user-scope install exists.
if [ -d "${HOME:-/nonexistent}/.claude/.agentpack" ]; then
  run_check update --check --quiet --scope user
  [ $? -eq 10 ] && nudge=1
fi

if [ "$nudge" -eq 1 ]; then
  echo "AgentPack updates available — run: agentpack update"
fi
exit 0
