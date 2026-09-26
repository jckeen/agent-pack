import { Argument, type Command } from "commander";

const STARTER = "examples/portable-workflow";
const PROFILE = ["--profile", "safe"];
const SETUP =
  "Build AgentPack from source first (see README quickstart). Commands below run from the repository root; replace the example path with your pack path. Exports create local files; account installation is manual.";

const ROUTES = [
  {
    id: "chatgpt",
    name: "ChatGPT plugin",
    description:
      "Export native skills in a portable plugin for a plugin-enabled ChatGPT client.",
    commands: [
      ["validate", STARTER],
      ["pack", "agent-plugin", STARTER, ...PROFILE, "--out", "dist/chatgpt-plugin"],
    ],
    artifacts: [
      "plugin.json",
      "skills/research-brief/SKILL.md",
      "skills/decision-memo/SKILL.md",
    ],
    nextSteps: [
      "Follow the official local marketplace instructions linked below to register the exported directory, then install through ChatGPT desktop's Plugins Directory and test in a new chat.",
      "Invoke research-brief with source material, then decision-memo with the result. Review evidence, missing information, and the proposed next step.",
    ],
    limitations: [
      "Export does not register a marketplace, publish a plugin, or install into your account. Local marketplace access depends on the client and workspace policy.",
      "Instructions become on-invoke guidance; they are not automatically Project instructions. Non-portable plugin extensions are not guaranteed to run in ChatGPT.",
    ],
    sources: ["https://developers.openai.com/plugins/build/plugins"],
  },
  {
    id: "chatgpt-project",
    name: "ChatGPT Project instructions",
    description: "Copy the starter's shared workflow guidance into a ChatGPT Project.",
    commands: [
      ["validate", STARTER],
      [
        "pack",
        "export",
        STARTER,
        "--target",
        "chatgpt",
        ...PROFILE,
        "--out",
        "dist/chatgpt-project",
      ],
    ],
    artifacts: ["project-instructions.md"],
    nextSteps: [
      "Open project-instructions.md, review it, and paste it into your Project instructions. Attach the source material you want to work with.",
      "Ask for a research brief or decision memo. Check the evidence and uncertainty before acting.",
    ],
    limitations: [
      "This adapter does not carry skill bodies into Project instructions. The starter includes a separate instruction atom containing a useful shared workflow.",
      "Other generated files are experimental app scaffolding, not a runnable ChatGPT app. Export does not create or update a Project.",
    ],
    sources: ["https://learn.chatgpt.com/docs/projects"],
  },
  {
    id: "claude",
    name: "Claude skills and Project instructions",
    description: "Export uploadable skill ZIPs and optional Project guidance.",
    commands: [
      ["validate", STARTER],
      ["pack", "chat", STARTER, ...PROFILE, "--out", "dist/claude-skills"],
    ],
    artifacts: [
      "skills/research-brief.zip",
      "skills/decision-memo.zip",
      "project-instructions.md",
      "README.md",
    ],
    nextSteps: [
      "Enable code execution if required by your account. In Customize > Skills, create a skill and upload each native skill ZIP. Consult the current official guide if your menus differ.",
      "Optionally paste project-instructions.md into a Claude Project. Invoke research-brief with source material, then decision-memo with the result.",
    ],
    limitations: [
      "This command exports files; uploads and Project setup are manual. Account and organization controls determine feature access.",
      "pack chat is a Claude exporter. It does not install ChatGPT skills, resolve target variants, or carry executable hooks and subagents into chat.",
    ],
    sources: ["https://support.claude.com/en/articles/12512180-use-skills-in-claude"],
  },
  {
    id: "claude-plugin",
    name: "Claude plugin",
    description: "Bundle the starter skills for a Claude client with plugin support.",
    commands: [
      ["validate", STARTER],
      ["pack", "plugin", STARTER, ...PROFILE, "--out", "dist/claude-plugin"],
    ],
    artifacts: [
      ".claude-plugin/plugin.json",
      "skills/research-brief/SKILL.md",
      "skills/decision-memo/SKILL.md",
    ],
    nextSteps: [
      "Use the official custom plugin installation instructions for your Claude client. The export is a directory; package or register it as that client requires.",
      "Install the plugin, invoke research-brief with source material, then decision-memo. Confirm the expected skills appear before relying on them.",
    ],
    limitations: [
      "Export is not account installation or Directory publication. Plugin access depends on your plan, client, and organization controls.",
      "Skills can work in chat; hooks and subagents require a compatible execution surface such as Cowork or Claude Code. The starter contains neither.",
    ],
    sources: ["https://support.claude.com/en/articles/13837440-use-plugins-in-claude"],
  },
];

export function registerGuide(program: Command): void {
  program
    .command("guide")
    .description(
      "Choose a ChatGPT or Claude export route and show manual setup steps (read-only).",
    )
    .addArgument(
      new Argument("[surface]", "destination surface").choices(
        ROUTES.map((route) => route.id),
      ),
    )
    .option("--json", "emit structured routes and command argument arrays", false)
    .action((surface: string | undefined, options: { json: boolean }) => {
      const routes = surface ? ROUTES.filter((route) => route.id === surface) : ROUTES;
      if (options.json) {
        console.log(JSON.stringify({ setup: SETUP, routes }, null, 2));
        return;
      }
      console.log(SETUP);
      for (const route of routes) {
        console.log(`\n${route.id} — ${route.name}\n${route.description}`);
        for (const args of route.commands) console.log(`  agentpack ${args.join(" ")}`);
        console.log(`Artifacts: ${route.artifacts.join(", ")}`);
        for (const step of route.nextSteps) console.log(`Next: ${step}`);
        for (const limitation of route.limitations) console.log(`Limit: ${limitation}`);
        for (const source of route.sources) console.log(`Official guide: ${source}`);
      }
    });
}
