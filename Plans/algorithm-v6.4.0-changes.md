# Proposed Algorithm v6.4.0 doctrine changes

> Scratchpad from the 2026-05-19 agent-pack /max session, task D4 (agent-stall investigation). The primary lands these into `~/.claude/PAI/ALGORITHM/v6.4.0.md` if/when they survive review. Source memo: `~/.claude/PAI/MEMORY/KNOWLEDGE/Research/agent-stall-investigation.md`.

---

## Why these changes

The agent-pack-iter4 session (2026-05-18T22:25 ET) planned 3 parallel Forge worktree agents under /max but landed almost all the work inline by the primary because the Forge agents silently stalled. Investigation confirmed 5 of 7 codex sessions in the iter4 window ended without `task_complete`, and the root cause is **context-window starvation amplified by the codex CLI's mandatory AGENTS.md auto-prepend on every turn**. A ~3000-word Forge prompt becomes ~8000+ words per turn after the AGENTS.md prepend, and after 10-30 tool-call rounds on a medium codebase, cumulative input tokens cross 1M and the model emits one summary message then silently stops — no error, no timeout, no `task_complete`. The orchestrator sees a clean stream end and assumes done.

The doctrine changes below add a **canary-first dispatch rule** for any agent whose only observability surface is a final completion event, and a **fallback ladder** for handling stalls without silently re-dispatching the same monolithic prompt.

---

## Change 1 — Add to PLAN phase: agent-dispatch shape preflight

In the PLAN phase, when a planned EXECUTE step dispatches to `Forge`, `Cato`, or any other subagent that wraps `codex exec`, the Algorithm MUST evaluate dispatch shape against the **stall-risk gate**:

> **Stall-risk gate.** If the planned dispatch satisfies BOTH:
> - The wrapped prompt sent to the subagent exceeds **1,500 words** (count the full wrapper, not just the user's request).
> - The target codebase has **>100 source files** OR the working directory is a non-empty git repo.
>
> Then the Algorithm MUST insert a canary ISC before the substantive dispatch:
>
> ```
> - [ ] ISC-N.canary: Dispatch ≤50-LOC canary task to <agent> with slug "<base-slug>-canary".
>   Verify: forge-events.jsonl contains a task_complete event within 60s AND forge-final.txt is non-empty.
>   If canary stalls: skip the substantive dispatch and proceed via the Forge-stall fallback ladder below.
> ```
>
> The canary task must touch the same repo / sandbox / model / reasoning-effort as the planned dispatch. A "list the files in src/" canary is acceptable.

**Rationale:** Five of seven Forge dispatches in iter4 stalled silently. The canary catches the stall before the primary commits to a fan-out it can't recover from. Cost is one extra ~$0.05 codex call per dispatch class; benefit is no silent failure modes.

---

## Change 2 — Add to EXECUTE/VERIFY phase: Forge-stall fallback ladder

When VERIFY detects a stalled subagent dispatch (defined as: `forge-final.txt` is empty OR no `task_complete` event appears in `forge-events.jsonl` after the 300s helper timeout), the Algorithm MUST follow this ladder rather than silently re-dispatching the same prompt:

1. **Chunk.** Split the original prompt at section boundaries (use the six-section Forge wrapper as the natural seam — Objective / Completeness / Quality / Constraints / Verification / Deliverable are independent enough to send separately). Re-dispatch each chunk as a separate Forge call with `--ignore-rules --ignore-user-config` (strips the AGENTS.md auto-prepend, removes the per-turn ~8K-token amplification).
2. **Confirm chunk progress.** Each chunked call must emit at least one `function_call` event within 90s of dispatch. If a chunked call also stalls at this threshold, move to step 3 for that chunk only — do not abandon the whole task.
3. **Inline fallback.** Complete the stalled chunk inline with the primary model. Log the fallback in the LEARN phase reflection's `reflection_q3` so the doctrine has empirical evidence about which prompt shapes the canary missed.

**Anti-pattern (explicit):** Never silently re-dispatch the same monolithic prompt that just stalled. The iter4 session's 7 sequential rollouts in the same 40-minute window (v060-pass1, pass2, pass2b, pass2c, pass3, pass3b, schema-hardening) shows the failure mode of "try again with the same prompt."

---

## Change 3 — Wire FeedbackMemoryConsult to grep dispatch-class failures

When `FeedbackMemoryConsult` is selected in CAPABILITY SELECTION at E2+, it MUST grep `feedback_*.md` for **dispatch-class failure terms** BEFORE the dispatch is committed, not after the work runs. Specifically:

```bash
# Existing FeedbackMemoryConsult run
grep -li "forge\|codex.*stall\|codex.*hang\|subagent.*stuck\|cato.*deviation" \
  ~/.claude/projects/-home-jckee-dev/memory/feedback_*.md
```

If matches return, the Algorithm MUST quote the matched feedback in the PLAN phase output before committing to the dispatch. The cost of this grep is <100ms; the benefit is that the May 7 "Forge sub-agent spawn was sandbox-blocked", May 8 "fall back to direct codex exec faster with shorter prompts", and May 8 "Cato also unable to run due to codex CLI absence" reflections — all of which predicted the iter4 stall — would have surfaced before the iter4 dispatch was issued.

---

## Change 4 — Update ForgeProgress.ts default flags (optional, not doctrine)

This is an implementation tweak rather than a doctrine change, but it's the cleanest mechanical fix for H1:

> Consider passing `--ignore-rules --ignore-user-config` by default in `ForgeProgress.ts`'s spawned `codex exec` call. This strips the AGENTS.md / AGENTS.local.md / MEMORY.md auto-prepend (~30KB / ~8K tokens per turn) for the Forge path specifically, closing H1's amplification mechanism without affecting interactive codex use. Tradeoff: Forge loses the "private memory" context that AGENTS.local.md / MEMORY.md provide. Net: Forge prompts are already wrapped in a six-section Forge doctrine by the agent definition, so the loss of AGENTS.md context is small. Worth A/B-ing against the canary rule alone.

Not a doctrine change because it's invisible to the Algorithm and lives in `~/.claude/PAI/TOOLS/ForgeProgress.ts`. Listed here for the primary's awareness.

---

## Reach claim — apply to other subagents

The canary rule and the stall-fallback ladder are NOT Forge-specific. They apply to:

- **Cato** (read-only codex audit) — same AGENTS.md amplification, same starvation curve.
- **Anvil** (if/when it ships codex-backed code production) — inherits everything.
- **Browser / Interceptor automation** — page-load-without-DOM-event looks identical from the orchestrator's perspective.
- **MCP subagents that buffer output until completion** — same observability gap, same fix.
- **Future Anthropic Routines / Bedrock subagents** — same principle: dispatch is hope; observability is evidence; canary replaces the former with the latter.

The v6.4.0 doctrine should phrase the rule generically: *Any subagent whose only observability surface is a final completion event requires a small-task liveness probe before being given a large task.*

---

## What v6.4.0 does NOT do

- Does NOT build a new ForgeCanary.ts wrapper. The canary is just a small dispatch; no new tool is needed. (Violates BitterPillEngineering if added.)
- Does NOT impose the canary on every E1/E2 dispatch. The gate is shape-based: large prompt + non-empty repo. Small dispatches and clean-room repros are exempt.
- Does NOT replace Advisor or FeedbackMemoryConsult. It wires them to a more specific question (dispatch shape) and runs the canary BEFORE committing to the dispatch.

---

## Verification once landed

After v6.4.0 lands, the next /max session that plans a Forge fan-out should show:

1. A canary ISC in the ISA before the substantive Forge ISCs.
2. A FeedbackMemoryConsult grep result quoted in the PLAN output that mentions this very investigation memo.
3. Zero silent stalls in the post-v6.4.0 reflection JSONL (or, if a stall does occur, the fallback ladder fires and the LEARN reflection records which chunk needed inline completion).
