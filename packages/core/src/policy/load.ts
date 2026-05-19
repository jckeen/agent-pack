import { promises as fs } from "node:fs";
import path from "node:path";

import { PolicyParseError } from "./errors.js";
import { policyConfigSchema, type PolicyConfig } from "./schema.js";

const POLICY_FILE_NAME = "workgraph.policy.json";

export async function loadPolicy(
  projectRoot: string
): Promise<PolicyConfig | null> {
  const filePath = path.join(projectRoot, POLICY_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const issue = err instanceof Error ? err.message : String(err);
    throw new PolicyParseError(
      [
        {
          code: "custom",
          path: [],
          message: `invalid JSON: ${issue}`,
        },
      ],
      filePath
    );
  }
  const result = policyConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new PolicyParseError(result.error.issues, filePath);
  }
  return result.data;
}
