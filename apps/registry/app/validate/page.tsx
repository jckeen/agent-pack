import { ValidateForm } from "./ValidateForm";

export default function ValidatePage() {
  return (
    <div className="container-page space-y-6">
      <header>
        <h1 className="h1">Validate an AgentPack manifest</h1>
        <p className="mt-2 max-w-2xl text-ink-600">
          Paste a <code className="font-mono">AGENTPACK.yaml</code> below. The
          validator runs the same schema and semantic checks as{" "}
          <code className="font-mono">agentpack validate</code> in the CLI.
        </p>
      </header>
      <ValidateForm />
    </div>
  );
}
