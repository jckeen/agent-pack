-- Issue #35 — full-artifact signing.
--
-- The Sigstore bundle historically covered only the manifest digest. v2
-- envelopes sign a canonical release descriptor (manifest hash + every
-- installable file digest). Persist that descriptor so the registry can serve
-- it to installers, which verify downloaded bytes against the SIGNED digest set
-- rather than registry-served per-file metadata.
--
-- Nullable: existing (v1, manifest-only) signature rows leave it NULL.

ALTER TABLE pack_signatures
  ADD COLUMN IF NOT EXISTS release_descriptor jsonb;
