/**
 * Minimal fake Drizzle client for unit-testing the query layer.
 *
 * The real query helpers chain query-builder methods
 * (`db.select().from().where().limit()…`) and then `await` the chain, which
 * resolves to an array of rows. This fake records every method call (name +
 * args) and returns a thenable chain that resolves to a canned result.
 *
 * It is intentionally untyped at the boundary and cast to `Database` at the
 * call sites so the production functions run unchanged against it.
 */

import type { Database } from "../src/client.js";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeDb {
  /** Cast to `Database` for passing into query helpers. */
  db: Database;
  /** All method calls recorded across every chain, in order. */
  calls: RecordedCall[];
  /** Convenience: the args of the first recorded call with `method`. */
  argsOf(method: string): unknown[] | undefined;
  /** All recorded methods names, in call order. */
  methods(): string[];
}

/**
 * Build a fake db whose awaited query chains resolve to `result`.
 *
 * Every chainable method (`select`, `from`, `where`, `innerJoin`, `limit`,
 * `offset`, `orderBy`, `insert`, `values`, `returning`, `update`, `set`)
 * returns the same thenable so any call order resolves to `result`.
 */
export function makeFakeDb(result: unknown[]): FakeDb {
  const calls: RecordedCall[] = [];

  const chainMethods = [
    "select",
    "from",
    "where",
    "innerJoin",
    "leftJoin",
    "limit",
    "offset",
    "orderBy",
    "insert",
    "values",
    "returning",
    "update",
    "set",
    "delete",
  ];

  const chain: Record<string, unknown> = {};

  for (const m of chainMethods) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }

  // Make the chain awaitable: resolves to the canned result array.
  chain.then = (
    onFulfilled: (value: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);

  return {
    db: chain as unknown as Database,
    calls,
    argsOf(method: string) {
      return calls.find((c) => c.method === method)?.args;
    },
    methods() {
      return calls.map((c) => c.method);
    },
  };
}

/**
 * Build a fake db whose successive awaited chains resolve to the queued
 * results in order. Used by helpers that issue more than one query in a
 * single call (e.g. `listPacks` does a rows query then a count query).
 */
export function makeMultiResultFakeDb(results: unknown[][]): FakeDb {
  const calls: RecordedCall[] = [];
  let chainIndex = -1;

  const chainMethods = [
    "select",
    "from",
    "where",
    "innerJoin",
    "leftJoin",
    "limit",
    "offset",
    "orderBy",
    "insert",
    "values",
    "returning",
    "update",
    "set",
    "delete",
  ];

  // A new chain is started by an entry method (`select`/`insert`/`update`/
  // `delete`). Each chain resolves to the next queued result, in start order.
  const entryMethods = new Set(["select", "insert", "update", "delete"]);

  function makeChain(resultIndex: number): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of chainMethods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return chain;
      };
    }
    chain.then = (
      onFulfilled: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(results[resultIndex] ?? []).then(onFulfilled, onRejected);
    return chain;
  }

  // Root dispatcher: every entry method allocates the next queued result and
  // returns a fresh chain bound to it.
  const root: Record<string, unknown> = {};
  for (const m of chainMethods) {
    root[m] = (...args: unknown[]) => {
      if (entryMethods.has(m)) {
        chainIndex += 1;
      }
      calls.push({ method: m, args });
      return makeChain(chainIndex);
    };
  }

  return {
    db: root as unknown as Database,
    calls,
    argsOf(method: string) {
      return calls.find((c) => c.method === method)?.args;
    },
    methods() {
      return calls.map((c) => c.method);
    },
  };
}
