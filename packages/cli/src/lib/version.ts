// CLI version constant. Imported by commands that stamp the version into
// generated artifacts (lockfiles). Bumped in lockstep with package.json.
//
// We hard-code it rather than reading package.json at runtime because:
// (a) bundling the CLI for distribution doesn't always carry package.json
//     into the dist tree;
// (b) the stamp must be deterministic across invocations of the same install,
//     and (a) plus a runtime read can subtly differ.

export const CLI_VERSION = "0.2.0";
