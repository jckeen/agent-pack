-- Phase 4 — Sigstore keyless signatures.
--
-- Each row carries a full Sigstore Bundle (cert + signature + Rekor proof)
-- attached to a published pack version. A version may have zero rows
-- (unsigned), one row (signed once), or many rows (re-signed).
--
-- The bundle column is the source of truth for cryptographic verification;
-- the surface columns are denormalized for fast UI filtering ("show me all
-- packs signed by https://github.com/jckee").

create table if not exists pack_signatures (
  id                uuid primary key default gen_random_uuid(),
  pack_version_id   uuid not null references pack_versions(id) on delete cascade,

  bundle_b64        text not null,

  signer_san        text not null,
  signer_issuer     text not null,

  rekor_log_index   bigint not null,
  rekor_log_id      text not null,
  rekor_log_url     text not null,

  manifest_sha256   text not null,
  envelope_version  integer not null default 1,

  signed_at         timestamptz not null,
  inserted_at       timestamptz not null default now()
);

create index if not exists pack_signatures_pack_version_idx
  on pack_signatures (pack_version_id);

create index if not exists pack_signatures_rekor_log_index_idx
  on pack_signatures (rekor_log_index);

create index if not exists pack_signatures_signer_san_idx
  on pack_signatures (signer_san);
