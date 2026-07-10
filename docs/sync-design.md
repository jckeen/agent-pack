# Continuous sync — design

> Design plan (2026-07-09) for keeping installs current as their source evolves and
> carrying one person's agent configuration across machines and into cloud/web
> sessions. Drafted by a planning agent against the shipped code, reviewed by the
> operator. Build phases are tracked as GitHub issues (see "Phasing" below);
> update this doc as phases land.

**Goal:** make an AgentPack install stay current as its source evolves, and make one
person's agent configuration follow them across machines and into cloud/web sessions —
without a daemon, without a required SaaS account, and without ever silently updating
executable content.

**One-sentence architecture:** git remains the transport; the lockfile grows a `source`
provenance block so an install remembers where it came from; a new `agentpack update`
command re-resolves that source, three-way-reconciles against local state using the
existing merge/verify machinery, and re-runs every governance gate on the delta;
propagation across machines and into the web is the same primitive pointed at a
personal config repo and the project repo respectively.

---

## 0. What exists today (and the one missing fact)

The building blocks are nearly all shipped:

| Capability                                                                             | Where                                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Pin a ref to a commit SHA and fetch a pack at it                                       | `packages/core/src/git-source/index.ts` (`fetchGitPack` returns `{ tmpRoot, resolvedSha, requestedRef }`) |
| Deterministic lockfile with per-file sha256                                            | `packages/core/src/install/lockfile.ts`, `LockfileV1` in `packages/core/src/install/types.ts`             |
| Per-machine install record (created/modified/backups/merges)                           | `InstallManifestV1`, `packages/core/src/install/types.ts`                                                 |
| Re-install classification (create/modify/unchanged/conflict, prior-manifest awareness) | `packages/core/src/install/plan.ts`                                                                       |
| Fragment-level drift detection for merged files                                        | `packages/core/src/install/verify.ts`                                                                     |
| Surgical uninstall + backups + hash-chained history                                    | `packages/core/src/install/{uninstall,recovery,history}.ts`                                               |
| Exec gate, signature gate, policy file                                                 | `packages/cli/src/commands/install.ts`, `docs/policy.md`                                                  |
| Whole-config import                                                                    | `agentpack import --from claude-code` (`packages/cli/src/commands/import.ts`)                             |
| Plugin/chat/mcpb compile targets                                                       | `packages/cli/src/commands/pack.ts`, `docs/integration-roadmap.md`                                        |

**The missing fact was provenance.** `fetchGitPack` pins and returns `resolvedSha` and
`requestedRef`, and the CLI _printed_ them — then threw them away. Neither `LockfileV1`
nor `InstallManifestV1` recorded where the pack came from. An installed project literally
could not answer "where would an update come from?" **Fixed in S1 (#110):** both now
carry the `source` block below.

A second wrinkle to design around: `AGENTPACK.lock` is single-pack (top-level `packId`),
and `applyInstall` backs up and replaces any prior lockfile. The per-pack source of truth
for update must therefore be `.agentpack/installed/<packId>.json`, with the lockfile
consulted only when its `packId` matches.

---

## 1. The update primitive: `agentpack update`

### 1.1 Data model changes

**Lockfile (additive, stays `lockfileVersion: 1` with an optional field):**

```jsonc
// LockfileV1.source? — absent on local-path installs
"source": {
  "kind": "github",                          // later: "gitlab", "registry", "local"
  "id": "github:jckeen/agent-pack#examples/pr-quality",  // canonical re-fetchable id, no ref
  "requestedRef": "master",                  // what the user typed; null = default branch
  "resolvedSha": "e188eea…40hex",            // the pin actually installed
  "channel": "branch"                        // derived: "pinned" | "tag" | "branch"
}
```

Determinism holds: all five fields are functions of the install inputs, not the machine.
`channel` is derived at install time: a 40-hex ref or tag means `pinned`/`tag` (never
auto-moves); a branch or omitted ref means `branch` (trackable). Registry installs record
`kind: "registry"` with a `requestedVersion` range (e.g. `^1.2.0`) instead of
`requestedRef`.

**Install manifest (per-machine):** mirror the same `source` block, plus
`updatedAt?: string` and `previousPackVersion?: string` so `agentpack history` can
narrate updates.

**History:** two new `HistoryAction` values, `update_begin` / `update_commit`, using the
same WAL discipline as install (planned files in `begin`, `requiredBackups`,
`backupDir`) so the existing crash-recovery sweep in `recovery.ts` covers interrupted
updates for free.

### 1.2 Command surface

```
agentpack update [packId] [--project <dir>]
  --check              # read-only: report available update + risk/exec delta; exit 0 up-to-date / 10 update-available
  --to <ref>           # explicit target ref (overrides channel; also how a "pinned" install moves)
  --yes                # skip interactive confirm (same semantics as install)
  --allow-exec         # re-consent for exec-bearing delta (same flag as install, same separation from --yes)
  --require-sig        # registry sources: re-verify signature on the new version
  --keep-local <glob>  # on conflict: keep the local edit for matching paths, skip updating them
  --theirs <glob>      # on conflict: take the pack's new content (local edit backed up first)
  --dry-run            # full plan + diff, zero writes (same guarantee as install --dry-run)
```

With no `packId`, iterate every manifest under `.agentpack/installed/`. `agentpack sync`
is _not_ a separate command — reserve the word for the workflow docs (section 2); one
verb that changes files is enough.

### 1.3 The update algorithm (three-way reconcile)

Inputs: **BASE** = what the pack wrote at install time (old lockfile hashes +
`merges[].fragment` from the install manifest), **LOCAL** = on-disk now, **NEW** = the
freshly fetched pack's staged output.

1. **Resolve.** Read `source` from the install manifest. `channel: branch` re-resolves
   the ref; `pinned`/`tag` is a no-op unless `--to` is given. If `resolvedSha` is
   unchanged: "up to date", exit 0.
2. **Fetch + plan.** `fetchGitPack` at the new SHA, then run the existing `planInstall`
   against the project — it already classifies against disk and reads the prior
   manifest.
3. **Reclassify with BASE knowledge.** The one real change to plan semantics. Today
   `classify` treats "file has our marker, content differs" as _modified — safe to
   overwrite_. Correct for install, wrong for update: it can't tell "pack moved" from
   "user edited inside our span." Update distinguishes per file:
   - LOCAL == BASE, NEW != BASE → **clean update**, apply.
   - LOCAL != BASE, NEW == BASE → **local edit, pack unchanged** — leave alone, report
     as retained drift.
   - LOCAL != BASE, NEW != BASE → **conflict.** Default: refuse and list paths with
     diffs (same posture as install conflicts); `--theirs`/`--keep-local` resolve
     per-glob; every overwritten local edit is backed up via the existing backup
     machinery.
   - Marker-merged files (CLAUDE.md/AGENTS.md): BASE comparison runs on the extracted
     span, so user content _around_ the span never conflicts — coexistence survives by
     construction. JSON merges: remove the old fragment's entries (uninstall already
     knows how), deep-merge the new fragment; a user edit _inside_ our fragment keys is
     a conflict.
4. **Removals.** Any path in BASE's atom outputs absent from NEW's plan is surgically
   removed via the per-file uninstall logic — the thing plain "reinstall over the top"
   gets wrong (orphaned files from deleted atoms).
5. **Gates (section 4), confirm, apply.** Atomic writes, rewrite lockfile with the new
   `resolvedSha`, update install manifest, append `update_begin`/`update_commit` to
   history.

### 1.4 Verify grows two small flags

`agentpack verify` gains `--all` (iterate installed manifests; today it demands a
packId) and `--quiet` (exit code only) — both needed by the trigger model (section 5).
Exit-code taxonomy extends with `10 = update available` for `update --check`.

---

## 2. Machine-to-machine: "my ~/.claude everywhere"

The backbone already exists; the loop needs one adapter gap closed and one convention
documented.

**Canonical flow (pack repo is the source of truth; live config is a build artifact):**

1. **Seed once:** `agentpack import --from claude-code ~/.claude --id me.dotfiles --out
~/dev/my-agentpack` — already carries skills, agents, commands, hooks (scripts
   bundled), and MCP servers. Commit and push the pack repo.
2. **Install everywhere:** `agentpack install github:me/my-agentpack --scope user
--target claude-code`.
3. **Evolve:** edit atoms in the pack repo, commit, push. Every other machine runs
   `agentpack update` (or is nudged by the SessionStart check, section 5) and gets a
   gated, diffed, backed-up update. Local drift is caught by `verify`; a deliberate
   local improvement gets edited back into the pack repo and pushed.

**Gap 1 — user scope.** The claude-code adapter emits project layout (`CLAUDE.md`,
`.claude/…`). User-level config lives at `~/.claude/CLAUDE.md`, `~/.claude/settings.json`,
`~/.claude/skills/…`. Today `--project ~` would write `~/CLAUDE.md` — wrong. Add
`--scope user` to install/update: a path-mapping layer in the claude-code adapter
(project paths → `~/.claude/*` equivalents), with `.agentpack/` state at
`~/.claude/.agentpack/`. Everything else (lockfile, verify, backups, uninstall, update)
works unchanged because it's all projectRoot-relative.

**Gap 2 — closing the loop from the live side.** When you _did_ edit the live config
directly: add `agentpack import --into <existing-pack-dir> --diff` — re-runs the
claude-code importer against the live directory, shows what changed relative to the
pack's current atoms, updates atom bodies in place rather than scaffolding a new pack.
The user reviews and commits — git remains the sync channel; AgentPack is the
differ/compiler on both ends. Deliberately not automatic: a human commit is the consent
point for content that propagates to every machine.

**Not needed:** any AgentPack-owned transport, state server, or conflict CRDT. Git
already does distributed sync with history; AgentPack's job is compiling in both
directions and gating the apply.

---

## 3. Machine-to-web: Claude Code on the web / cloud sandboxes

Three lanes with honest ceilings (`packages/core/src/portability.ts`; table in
`docs/integration-roadmap.md`):

**Lane 1 — the project repo (free, already works).** Web/cloud sessions git-clone the
project, so _committed_ project-scope output travels with zero new machinery:
`CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/settings.json` (including
project hooks), `.mcp.json`, and — importantly — `AGENTPACK.lock` +
`agentpack.policy.json`. Committing the lockfile means every clone (teammate, CI, cloud
sandbox) carries the provenance to run `verify`/`update --check` if the CLI is present.
Doc recommendation: install project packs with compiled output committed; the git repo
is the sync mechanism to the web, and `agentpack update` on any machine + push is how a
web session gets the new version on next clone.

**Lane 2 — plugins (account-level, travels to web).** `agentpack pack plugin` compiles a
pack to a Claude Code plugin + marketplace.json. An account-level plugin follows the
_user_ into web sessions — the only lane carrying user-scope config into ephemeral
sandboxes. Its update story is Claude Code's marketplace mechanism, not `agentpack
update`; AgentPack's job is regenerating and re-tagging the plugin on pack release (a
`pack plugin` step in the personal repo's CI, section 5). Version-stamp the plugin from
the pack version so drift is diagnosable.

**Lane 3 — what does not cross, stated plainly.** User-level `~/.claude` (memory, user
settings, user-scope hooks) does not travel to web sandboxes except via Lane 2's plugin
subset. Per the portability ceilings: ambient instructions downgrade to on-invoke skills
off the terminal; user hooks and terminal-only surfaces have no web home. `update
--check` output and docs should show per-atom reach the same way `pack plugin` already
prints ceiling groups.

---

## 4. Governance under sync — must not regress

Silent auto-update of executable content is the exact supply-chain hazard the exec gate
exists for. Rules:

1. **Update is install-grade, always.** Every install gate runs on the update delta:
   policy enforcement (exit 6), exec gate, signature gate. No "approved once" bypass.
2. **Exec re-consent on delta.** Diff atom sets between old and new lockfiles. If any
   exec-bearing atom (`hook`, `mcp_server` — the set the install gate keys on) is
   _added_ or has a changed `sourceChecksum`, an unsigned update refuses without
   `--allow-exec`, exactly like install, printing the atom-level diff (which script
   changed, which MCP command/URL changed). A signature-verified update
   (`--require-sig`, registry source) substitutes for `--allow-exec`, mirroring install.
   Non-exec deltas (instructions, skills, rules) update under `--yes` alone.
3. **Channels are the pinning policy.** `pinned`/`tag` installs never move implicitly —
   `update` says "pinned at v1.2.0; v1.4.0 available (use --to)". `branch` installs move
   on `update`. No `latest`-with-auto-apply channel in phases S1–S2; "auto" only ever
   exists as the CI PR bot (section 5), where the PR is the consent surface.
4. **Signatures.** Registry sources: re-verify on every update; a previously-signed pack
   whose new version is unsigned is a hard refusal (downgrade attack). Git sources:
   `--require-sig` stays the honest deferral (`docs/git-source.md`) until cosign-on-tag
   lands; until then policy can forbid exec-bearing updates from unsigned git sources
   entirely.
5. **Policy surface** (additive to `agentpack.policy.json` v1, `docs/policy.md`):

```jsonc
"update": {
  "channel": "pinned" | "tag" | "branch",             // ceiling: installs may not track looser than this
  "requireReconsent": "exec" | "always" | "never",    // default "exec"; "never" still requires signature-verified
  "maxRiskEscalation": "none" | "one-level" | "any"   // refuse updates whose computed risk exceeds the installed version's by more
}
```

6. **Audit chain.** `update_begin`/`update_commit` history entries record old SHA → new
   SHA, the atom delta, and which consent flags were passed — so `agentpack history`
   answers "when did this hook change and who approved it," the governance story
   enterprise buyers actually ask for.

---

## 5. Trigger model — no daemons

| Trigger                   | Verdict                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual `agentpack update` | **Always the primitive.** Everything else is a notifier.                                                                                                                                                                                                                                                                                                          |
| SessionStart hook         | **Recommended notifier.** Ship a first-party `agentpack.sync-check` pack with one SessionStart hook: `agentpack update --check --quiet \|\| echo "AgentPack updates available — run: agentpack update"`. Read-only, fast on the cached-SHA path, degrades silently offline, never applies anything. Bonus: the sync feature ships _as a pack_.              |
| CI in the pack repo       | **Recommended for the push direction, phase S4.** GitHub Action on push/tag: validate, re-emit the plugin (`pack plugin`), optionally open dependabot-style PRs against registered consumer repos running `agentpack update` — lockfile + compiled output as the diff, PR review as the consent gate. The only sanctioned "auto" path, because a human merges it. |
| git post-merge hook       | Not default — per-repo installed hook (chicken-and-egg with governance) duplicating SessionStart. Document as an option; build nothing.                                                                                                                                                                                                                           |
| Daemon / file-watcher     | **Not building.** Violates no-daemon, adds a resident attack surface to a supply-chain-sensitive tool, and saves nothing: config changes matter at session start, not mid-session.                                                                                                                                                                                |

---

## 6. Risks

- **Conflict-resolution UX is the failure mode to fear.** If `update` ever clobbers a
  local edit without a backup and a loud report, trust in the governance story dies.
  Mitigation: BASE-aware classification (1.3), backups on every overwrite, explicit
  `--theirs`/`--keep-local`, default = refuse.
- **`plan.ts` classify semantics are shared with install.** The BASE-aware pass must be
  an update-mode layer over `classify`, not a rewrite; existing snapshot/determinism
  tests must stay green.
- **Single-pack lockfile.** Multi-pack projects have a latent last-install-wins on
  `AGENTPACK.lock`. Update sidesteps it by keying on install manifests, but a
  lockfile-v2 multi-pack shape is the eventual fix — out of scope; tracked as its own
  issue.
- **Branch-channel + unsigned git = moving executable target.** Mitigated by exec
  re-consent on delta and the policy channel ceiling; fully solved only by cosign-on-tag
  (existing v0.5.1 roadmap item — sync raises its priority).
- **`--scope user` writes into `~/.claude`,** the user's live config. Realpath
  containment, backup, and dry-run guarantees must be verified against a throwaway
  `HOME` before shipping — a dry-run that mutates real config is worse than none.

---

## 7. Phasing (tool-verifiable gates, roadmap style)

**Phase S1 — Provenance + `update --check`** (small; one session) — **SHIPPED 2026-07-09 (#110)**
Lockfile/manifest `source` block on git + registry installs; `update --check`;
`verify --all --quiet`. Gate met by `packages/cli/tests/update.cli.test.ts`
(CI-runnable: local mock GitHub server via `AGENTPACK_GITHUB_API_URL` /
`AGENTPACK_GITHUB_RAW_URL` env overrides).
_Gate:_ scripted e2e — install `github:<fixture>@main` into a temp project, push a new
commit to the fixture, `agentpack update --check` exits 10 printing old SHA → new SHA;
re-run at same SHA exits 0. Lockfile snapshots byte-stable for local-path installs (no
`source` field).

**Phase S2 — Apply path: three-way reconcile + removals + gates** (the core; 1–2
sessions) — **SHIPPED 2026-07-10 (#111)**
Full 1.3 algorithm, `update_begin/commit` history, exec re-consent on delta, policy
`update` section. Gate met by `packages/cli/tests/update-apply.cli.test.ts` (all four
scenarios, CI-runnable on the S1 mock-GitHub harness) + the crash-recovery kill test in
`packages/core/tests/update-engine.test.ts`. Notes vs. the plan: exec re-consent keys
off manifest atom-ids + file-level exec surfaces (the v1 lockfile's atoms collapse to a
synthetic `*pack` entry, so per-atom `sourceChecksum` diffing isn't possible); the
channel is re-derived live at update time, never trusted from the stored block (#111
security note); the registry apply path is deferred until live-smoke (the check path
works; `update` prints the exact signed `install` command).
_Gate:_ four scripted scenarios: (a) clean update applies, verify clean; (b) local edit
inside a marker span → refusal listing the path, `--theirs` applies with restorable
backup; (c) atom deleted upstream → its files removed, user files untouched; (d)
upstream adds a hook → unsigned update refuses without `--allow-exec` even with `--yes`.
Crash-recovery: kill between begin and commit, recovery sweep restores.

**Phase S3 — User scope + the personal-config loop** (1 session)
`--scope user` path mapping for claude-code; `import --into <pack> --diff`;
`docs/sync.md` documenting the machine-to-machine loop and web lanes/ceilings.
_Gate:_ round-trip on throwaway `HOME`s: import fixture `~/.claude` → pack → `install
--scope user` onto a second `HOME` → `verify` clean; edit pack, `update`; hook-script
change refused without `--allow-exec`. Diff the `HOME` before/after `--dry-run` — zero
mutations.

**Phase S4 — Triggers** (1 session)
`agentpack.sync-check` pack (SessionStart notifier); GitHub Action for pack-repo CI
(validate → `pack plugin` → optional update-PRs).
_Gate:_ hook exits 0 silently when current, prints the nudge when the fixture moves; the
Action opens a PR against a fixture consumer repo whose diff is exactly the update
plan's files + lockfile.

**Not building, with reasons:** real-time sync daemon / file-watcher (resident attack
surface, no-daemon constraint, no benefit over SessionStart); auto-apply of exec-bearing
updates under any flag combination (consent is `--allow-exec` at a terminal or a PR
review, never absent); an AgentPack-owned sync transport/state server (git already is
one); registry push notifications (pull-based `--check` suffices and keeps the registry
optional).

---

**First commit:** the single highest-leverage change was tiny and unblocked everything —
persist `resolvedSha`/`requestedRef` from `fetchGitPack` into the lockfile and install
manifest in `packages/cli/src/commands/install.ts`, where they were printed and
dropped. Shipped as phase S1 (#110).
