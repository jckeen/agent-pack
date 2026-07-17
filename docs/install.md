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

| Path                                                     | Purpose                                                                                                  | Committed?            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| `<project>/<adapter-files>`                              | The platform-native files (`CLAUDE.md`, `.claude/skills/...`, `AGENTS.md`, `.cursor/rules/*.mdc`, etc.)  | Up to you             |
| `<project>/AGENTPACK.lock`                               | Deterministic lockfile: per-atom + per-file SHA-256 checksums, no timestamps, no machine-specific values | **Yes**               |
| `<project>/.agentpack/installed/<packId>.json`           | Install manifest — authoritative source for uninstall                                                    | **No** (gitignore it) |
| `<project>/.agentpack/history.jsonl`                     | Hash-chained append-only audit log                                                                       | **No** (gitignore it) |
| `<project>/.agentpack/backups/<packId>/<ts>.<nonce>/...` | Backups of files we overwrote                                                                            | **No** (gitignore it) |

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

- If every `plannedFiles[i]` exists on disk with matching SHA-256 **and the
  install manifest was written** → roll forward by writing the missing
  `install_commit`. (Files-on-disk alone is not a durable install — without
  the manifest, verify/uninstall/rollback couldn't see it.)
- Otherwise → delete the partial files, **restore any backed-up user files**
  from the backup dir recorded in the begin entry, and append
  `install_rollback_recovery`.

A failed install's own cleanup follows the same rule: files that overwrote
existing content are restored from their backups, never deleted.

## Plan classification and merge semantics

`agentpack install` (and `diff`) classifies each target path:

| Status      | Meaning                                                          | Action                   |
| ----------- | ---------------------------------------------------------------- | ------------------------ |
| `create`    | No file exists at this path                                      | Write                    |
| `unchanged` | File exists; the merged result would be byte-identical           | Skip                     |
| `modify`    | Mergeable file, or a file carrying only our marker               | Backup + write merged    |
| `conflict`  | Non-mergeable file with foreign content, or a JSON key collision | Refuse without `--force` |

**Marker-block merge.** Shared instruction files (`CLAUDE.md`, `AGENTS.md`,
`project-instructions.md`) are wrapped in
`<!-- BEGIN AGENTPACK: <pack> --> … <!-- END AGENTPACK: <pack> -->` markers,
and the installer treats them as _shared surfaces_, not owned files:

- A pre-existing user file gets the pack's block **appended** — user content
  is preserved, byte for byte.
- Multiple packs coexist in one file, each inside its own marker span.
- Re-install replaces only the pack's own span, in place.
- Uninstall removes only the pack's span; if nothing else remains and the
  pack created the file, the file is deleted.

**JSON config merge.** `.claude/settings.json`, `.mcp.json`,
`.cursor/mcp.json`, and `.codex/hooks.json` are deep-merged: the pack's hook
entries are appended to the matching event arrays and its MCP servers are
added by name, while user entries (permissions, other hooks, other servers)
are untouched. A same-name MCP server with different content is a
`json-collision` conflict. Uninstall removes only the pack's entries.

**Fragment-level verify.** For merged files, `agentpack verify` checks that
the _pack's contribution_ is intact — the marker span hash or the JSON
entries — so the user editing their own sections of a shared file is not
drift, while tampering inside the pack's span is.

Non-mergeable outputs (skill folders, agents, commands) keep whole-file
ownership: a foreign file at one of those paths is a conflict, exactly as
before.

## Lockfile shape

`AGENTPACK.lock` is canonical JSON with sorted keys, pretty-printed for human
diffability. Since #114 it is **multi-pack** (`lockfileVersion: 2`): every
installed pack has its own entry under `packs`, keyed by packId, and each
entry carries exactly the fields the old single-pack document had:

```json
{
  "lockfileVersion": 2,
  "packs": {
    "agentpack.pr-quality": {
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
            {
              "path": "skills/code-review/SKILL.md",
              "sha256": "...",
              "bytes": 1234,
              "action": "create"
            }
          ]
        }
      ],
      "dependencies": [],
      "signatures": {}
    }
  }
}
```

Install **merges** its entry into the document: installing pack B preserves
pack A's entry; re-installing or updating pack A replaces only A's entry.
Uninstall removes only the pack's own entry and deletes the file when the
last entry goes — the lockfile describes the currently installed set, while
`.agentpack/history.jsonl` keeps the audit trail.

**v1 migration.** A `lockfileVersion: 1` file written by an older CLI (a
single-pack document with the entry fields at top level) is read everywhere —
install-over, verify, update, uninstall — as a single-pack v2 in memory. The
first write after that (next install/update) persists the file as v2. Per-pack
checksums recorded in install manifests hash the entry rendered as a
standalone v1 document, which for a v1 file is the whole file — so manifests
written by older CLIs stay valid across the migration.

Important: there is **no `installedAt` field** in the lockfile. Timestamps
are non-deterministic and live in the install manifest only.

Git- and registry-sourced installs additionally record an optional `source`
provenance block per entry (sync S1 — [`sync-design.md`](./sync-design.md)),
e.g.
`{ "kind": "github", "id": "github:owner/repo#subpath", "requestedRef": "main",
"resolvedSha": "<40-hex pin>", "channel": "branch" }` — every field is a
function of the install inputs, so determinism holds. It is what
`agentpack update --check` re-resolves. Local-path installs omit the field
entirely. The install manifest mirrors the same block (it remains the
per-machine record for update).

`signatures` and `dependencies` are reserved for Phase 4 (Sigstore/cosign)
and Phase 3 (transitive deps from a hosted registry). They're empty in
Phase 2 but the schema slot exists.

## History format

Every install/uninstall/rollback emits a JSON line in `.agentpack/history.jsonl`:

```jsonc
{
  "id": "019e3d4555ef7d8014f2c0c59c", // ulid-style monotonic
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
  "entryChecksum": "<sha256(canonicalJson(entry minus entryChecksum))>",
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

## Upgrading: re-install IS the upgrade path

There is no separate `upgrade` command, by design. Installing a newer version
of a pack over an existing install is the supported upgrade path:

```bash
npx agentpack install publisher/pack@2.0.0 --target claude-code --profile safe
```

The apply step carries ownership and backups across the re-install — files the
previous version created are recognized via the install manifest and AgentPack
markers, replaced in place, and backed up to `.agentpack/backups/` before being
overwritten. The new install manifest takes full ownership (including files
that happen to be byte-identical across versions), so a later `uninstall`
removes the pack cleanly.

One caveat: marker-aware classification only works for files that carry the
AgentPack `BEGIN`/`END` markers (markdown instruction files). Marker-less
outputs whose content changes between versions (e.g. a generated
`agentpack.json` or `.claude/settings.json`) classify as conflicts, so an
upgrade that touches them needs `--force`.

For status and recovery around an upgrade:

- `agentpack verify <packId>` — confirm what's on disk matches the installed
  version (before upgrading) or the new version (after).
- `agentpack history` — every install is logged, so the upgrade shows up as a
  new `install_begin` / `install_commit` pair.
- `agentpack rollback` — undoes the upgrade install, but it does **not**
  restore the previous version as an installed pack. Rollback runs a full
  `uninstall` of the latest install: files the manifest **created** —
  including files carried over byte-identical from the previous version — are
  deleted; files the manifest **modified** (it overwrote pre-existing content
  and kept a backup) are restored in place from backup, not deleted; and the
  install manifest is removed. You end up with the pack untracked: restored
  pre-upgrade content may remain on disk, but the pack is no longer
  installed.
- To actually return to the previous version, re-install it:
  `agentpack install publisher/pack@1.x.x`. After a rollback this recreates
  the deleted files, adopts what is already on disk, and `verify` reports
  clean again.

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
