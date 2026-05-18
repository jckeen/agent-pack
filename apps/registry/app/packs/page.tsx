import { SEED_PACKS, allTags } from "@/lib/seed";
import { PacksBrowser } from "./PacksBrowser";

export default function PacksPage() {
  return (
    <div className="container-page space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="h1">Registry</h1>
        <p className="text-ink-600">
          {SEED_PACKS.length} AgentPacks. Filter by tag, risk, or platform compatibility.
        </p>
      </header>
      <PacksBrowser packs={SEED_PACKS} tags={allTags()} />
    </div>
  );
}
