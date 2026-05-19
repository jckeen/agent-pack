/**
 * @agentpack/db — AgentPack Registry database layer.
 *
 * Stub committed by the protocol-commit phase. The Foundation worktree (W1)
 * fills in the Drizzle schema, queries, and migrations against the column
 * names pinned in `Plans/PROTOCOL.md` § 4.
 *
 * Other worktrees import from this stub to typecheck against the names; the
 * concrete Drizzle table objects land in `./schema/*` and concrete query
 * helpers land in `./queries/*`.
 */

export * from "./schema/index.js";
export * from "./queries/index.js";
export { getDb, type Database } from "./client.js";
