// Re-export the canonical seed packs from @agentpack/core so the registry has
// a single source of truth for seed metadata.
export {
  SEED_PACKS,
  getSeedPack,
  getSeedPackById,
  allTags,
  type SeedPack,
} from "@agentpack/core";
