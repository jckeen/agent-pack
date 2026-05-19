import type { Atom, RiskLevel } from "@agentpack/core";
import { RiskBadge } from "./RiskBadge";

const TYPE_LABEL: Record<string, string> = {
  instruction: "Instruction",
  rule: "Rule",
  skill: "Skill",
  hook: "Hook",
  command: "Command",
  subagent: "Subagent",
  mcp_server: "MCP server",
  plugin: "Plugin",
  workflow: "Workflow",
  context_pack: "Context pack",
  template: "Template",
  eval: "Eval",
};

export function AtomList({ atoms }: { atoms: Atom[] }) {
  if (atoms.length === 0) {
    return <p className="text-sm text-ink-400">No atoms in this pack.</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-ink-100">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-xs uppercase tracking-wider text-ink-400">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Atom</th>
            <th className="px-4 py-2 text-left font-medium">Type</th>
            <th className="px-4 py-2 text-left font-medium">Risk</th>
            <th className="px-4 py-2 text-left font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {atoms.map((atom) => (
            <tr key={atom.id} className="border-t border-ink-100">
              <td className="px-4 py-2 font-mono text-xs text-ink-900">
                {atom.id}
              </td>
              <td className="px-4 py-2 text-ink-600">
                {TYPE_LABEL[atom.type] ?? atom.type}
              </td>
              <td className="px-4 py-2">
                <RiskBadge level={atom.risk_level as RiskLevel} />
              </td>
              <td className="px-4 py-2 text-ink-600">{atom.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
