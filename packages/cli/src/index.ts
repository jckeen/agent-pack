#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerValidate } from "./commands/validate.js";
import { registerInspect } from "./commands/inspect.js";
import { registerPlan } from "./commands/plan.js";
import { registerPack } from "./commands/pack.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerInstall } from "./commands/install.js";
import { registerUninstall } from "./commands/uninstall.js";
import { registerDiff } from "./commands/diff.js";
import { registerHistory } from "./commands/history.js";
import { registerRollback } from "./commands/rollback.js";
import { registerVerify } from "./commands/verify.js";
import { registerLogin } from "./commands/login.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerTokens } from "./commands/tokens.js";
import { registerPublish } from "./commands/publish.js";
import { registerCache } from "./commands/cache.js";
import { CLI_VERSION } from "./lib/version.js";

const program = new Command();

program
  .name("agentpack")
  .description(
    "AgentPack CLI — validate, inspect, plan, export, install, verify, publish, and authenticate against the AgentPack Registry.",
  )
  .version(CLI_VERSION, "-v, --version", "Show CLI version")
  .showHelpAfterError(true);

registerInit(program);
registerValidate(program);
registerInspect(program);
registerPlan(program);
registerPack(program);
registerDoctor(program);
registerInstall(program);
registerUninstall(program);
registerDiff(program);
registerHistory(program);
registerRollback(program);
registerVerify(program);
// Phase 3 + Phase 5 commands.
registerLogin(program);
registerWhoami(program);
registerTokens(program);
registerPublish(program);
registerCache(program);

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
