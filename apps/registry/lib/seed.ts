// Re-export the canonical seed packs from @workgraph/core so the registry has
// a single source of truth for seed metadata.
export {
  SEED_PACKS,
  getSeedPack,
  getSeedPackById,
  allTags,
  type SeedPack,
} from "@workgraph/core";
