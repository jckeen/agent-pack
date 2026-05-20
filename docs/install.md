# Install, uninstall, verify, rollback

Phase 2 of the AgentPack standard ships the local install / uninstall flow:
the same `AGENTPACK.yaml` you can already export can now be **installed into a
project**, **verified** against drift, **rolled back**, and **uninstalled
precisely** — with a write-ahead log, per-file checksums, and hash-chained
history.

```bash
# Preview the diff. Nothing is written.
npx agentpack install examples/pr-quality --target claude-code --profile safe --dry-run

# Install for real. Prints a diff, prompts for [y/N], then writes.
npx agentpack install examples/pr-quality --target claude-code --profile safe

# Drift detection.
npx agentpack verify agentpack.pr-quality

# Undo.
npx agentpack uninstall agentpack.pr-quality

# Roll back the most recent install (idempotent).
npx agentpack rollback

# Show every install / uninstall / rollback this project has seen.
npx agentpack history --limit 20
```

## What gets written

When you `install` a pack into a project root, four things happen on disk:

| Path | Purpose | Committed? |
|---|---|---|
| `<project>/<adapter-files>` | The platform-native files (`CLAUDE.md`, `.claude/skills/...`, `AGENTS.md`, `.cursor/rules/*.mdc`, etc.) | Up to you |
| `<project>/AGENTPACK.lock` | Deterministic lockfile: per-atom + per-file SHA-256 checksums, no timestamps, no machine-specific values | **Yes** |
| `<project>/.agentpack/installed/<packId>.json` | Install manifest — authoritative source for uninstall | **No** (gitignore it) |
| `<project>/.agentpack/history.jsonl` | Hash-chained append-only audit log | **No** (gitignore it) |
| `<project>/.agentpack/backups/<packId>/<ts>.<nonce>/...` | Backups of files we overwrote | **No** (gitignore it) |

Recommended `.gitignore` snippet (printed after every install):

```
.agentpack/installed/
.agentpack/backups/
.agentpack/history.jsonl
.agentpack/.lock
```

Keep `AGENTPACK.lock` in git — it's the reproducibility primitive. Two clean
installs of the same pack at the same version with the same CLI produce
**byte-identical** lockfiles.

## The install flow

The CLI implements a write-ahead log (WAL) on top of `history.jsonl`. The
ordering is non-negotiable because it's the crash-recovery contract:

```
1. Plan       → diff every target path against current project state
2. Confirm    → [y/N] prompt, unless --yes or --dry-run
3. WAL begin  → append `install_begin` with plannedFiles[] (path + sha256)
4. Backup     → copy every overwritten file to .agentpack/backups/<pack>/<ts>.<nonce>/
5. Write      → atomic write (tmp + rename) of every adapter file
6. Lockfile   → write AGENTPACK.lock at project root
7. Manifest   → write .agentpack/installed/<pack>.json
8. WAL commit → append `install_commit` (last action)
```

If the process is killed between steps 3 and 8, the next CLI invocation runs
a recovery sweep. For every dangling `install_begin`:

- If every `plannedFiles[i]` exists on disk with matching SHA-256 → roll
  forward by writing the missing `install_commit`.
- Otherwise → delete the partial files and append
  `install_rollback_recovery`.

## Plan classification

`agentpack install` (and `diff`) classifies each target path into one of four
bins:

| Status | Meaning | Action |
|---|---|---|
| `create` | No file exists at this path | Write |
| `unchanged` | File exists, byte-identical | Skip |
| `modify` | File exists, has our `<!-- BEGIN AGENTPACK: <pack> -->` marker | Backup + overwrite |
| `conflict` | File exists, no marker (or marker belongs to another pack) | Refuse without `--force` |

Two-pack marker overlap is detected but not merged in Phase 2 — install
refuses with a clear error pointing at the other pack ID. Marker-aware merge
is Phase 3.

## Lockfile shape

`AGENTPACK.lock` is canonical JSON with sorted keys, pretty-printed for human
diffability:

```json
{
  "lockfileVersion": 1,
  "packId": "agentpack.pr-quality",
  "packVersion": "0.1.0",
  "target": "claude-code",
  "profile": "safe",
  "generator": { "cli": "0.2.0", "adapter": "0.2.0" },
  "manifestChecksum": "<sha256 of raw AGENTPACK.yaml bytes>",
  "canonicalization": {
    "algorithm": "sha256",
    "encoding": "utf-8",
    "lineEndings": "lf"
  },
  "atoms": [
    {
      "id": "code-review",
      "type": "skill",
      "sourceChecksum": "<sha256 of source atom files>",
      "contentChecksum": "<sha256 of rendered output bundle>",
      "outputs": [
        { "path": "skills/code-review/SKILL.md", "sha256": "...", "bytes": 1234, "action": "create" }
      ]
    }
  ],
  "dependencies": [],
  "signatures": {}
}
```

Important: there is **no `installedAt` field** in the lockfile. Timestamps
are non-deterministic and live in the install manifest only.

`signatures` and `dependencies` are reserved for Phase 4 (Sigstore/cosign)
and Phase 3 (transitive deps from a hosted registry). They're empty in
Phase 2 but the schema slot exists to avoid a v2 bump later.

## History format

Every install/uninstall/rollback emits a JSON line in `.agentpack/history.jsonl`:

```jsonc
{
  "id": "019e3d4555ef7d8014f2c0c59c",   // ulid-style monotonic
  "action": "install_commit",
  "timestamp": "2026-05-18T22:45:21.034Z",
  "packId": "agentpack.pr-quality",
  "packVersion": "0.1.0",
  "target": "claude-code",
  "profile": "safe",
  "manifestPath": ".agentpack/installed/agentpack.pr-quality.json",
  "actor": { "type": "cli" },
  "result": "success",
  "previousEntryId": "019e3d4555e8e0f579300b5bb5",
  "entryChecksum": "<sha256(canonicalJson(entry minus entryChecksum))>"
}
```

Each entry's `entryChecksum` covers every other field. `previousEntryId`
links to the prior entry's `id`, forming a hash chain. Tampering with any
entry is detectable by:

```bash
npx agentpack verify <pack> --chain
```

The chain is **not** rotated in Phase 2 — the file grows monotonically. Phase 3
will add `{ action: "rotate", archivedFile, archivedTipHash }` bridging entries.

## Rollback semantics

- `agentpack rollback` — undo the most recent `install_commit`.
- `agentpack rollback --to <historyId>` — undo every install_commit after
  the entry with that id, newest first.
- `agentpack rollback --pack <packId>` — limit to one pack.
- `agentpack rollback --cascade` — allow rollback to undo superseded
  installs of the same pack (e.g. install v1, install v2, rollback to before
  v1 needs `--cascade` because v2 supersedes v1).

Within a single install, rollback is **atomic** — all-or-nothing — because
the WAL guarantees you can always roll forward or back. Across the history,
rollback is **step-wise** to match the git/migration mental model.

## Anti-criteria (what install will NOT do)

- Install never writes outside `--project` (`realpath` check on every target).
- Install never auto-edits your `.gitignore` (advisory message only).
- Install never silently drops a hook atom under `safe` profile (still
  surfaced as `unsupportedAtoms` or in adapter `warnings`).
- Lockfile never embeds timestamps or absolute paths.
- Install manifest stores only project-relative paths.
- Uninstall never deletes a file it didn't create (compared against
  `created[]`).
- Uninstall never restores a backup over a user-edited file (refuses unless
  `--force-restore`).
- History never logs secret values; only structural keys (`packId`, `target`,
  `profile`).

## Phase 2 → Phase 3 boundary

What's in Phase 2:
- Local install / uninstall / diff / verify / rollback
- Lockfile with per-atom + per-file SHA-256
- Install manifest (per-machine)
- WAL-backed install via `history.jsonl`
- Hash-chained history with concurrency lock
- Recovery sweep for crashed installs
- `--chain` verification

What's deferred to Phase 3+ (requires external infrastructure):
- Remote `agentpack install publisher/pack` over a hosted registry
- Cryptographic signatures (Sigstore / cosign)
- Transitive dependency resolution
- Marker-aware merge across packs sharing an instruction file
- History rotation / compaction
- Enterprise: SSO, audit logs, allowlists, policy-as-code
