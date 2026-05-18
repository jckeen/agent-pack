"use server";

import { validateRawYaml } from "@/lib/manifest";
import type { ValidationResult } from "@workgraph/core";

export interface ValidatePayload {
  parseError: string | null;
  result: ValidationResult | null;
}

export async function runValidation(yaml: string): Promise<ValidatePayload> {
  const { parseError, result } = await validateRawYaml(yaml);
  return { parseError, result };
}
