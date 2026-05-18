#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerValidate } from "./commands/validate.js";
import { registerInspect } from "./commands/inspect.js";
import { registerPlan } from "./commands/plan.js";
import { registerPack } from "./commands/pack.js";
import { registerDoctor } from "./commands/doctor.js";

const program = new Command();

program
  .name("workgraph")
  .description("AgentPack CLI — validate, inspect, plan, and export agent packs.")
  .version("0.1.0", "-v, --version", "Show CLI version")
  .showHelpAfterError(true);

registerInit(program);
registerValidate(program);
registerInspect(program);
registerPlan(program);
registerPack(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
