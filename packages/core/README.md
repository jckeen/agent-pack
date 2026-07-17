# @agentpack/core

The engine behind [AgentPack](https://github.com/jckeen/agent-pack): schema and
zod validation for `AGENTPACK.yaml`, the manifest parser, permission/risk
computation, the install planner and WAL-protected apply/uninstall/update
pipeline, per-target adapters (Claude Code, Codex, Cursor, ChatGPT, generic),
lockfile + drift verification, and Sigstore signing/verification.

```bash
npm i @agentpack/core
```

```ts
import { planInstall, applyInstall } from "@agentpack/core";
```

Most users want the CLI instead: [`@agentpack/cli`](https://www.npmjs.com/package/@agentpack/cli)
(`npm i -g @agentpack/cli`). This package is for building on the engine —
registries, bots, or custom install surfaces.

- Repository and project README: <https://github.com/jckeen/agent-pack>
- Spec and guides: [`docs/`](https://github.com/jckeen/agent-pack/tree/master/docs)

License: MIT
