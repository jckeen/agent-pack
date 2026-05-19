import type { z } from "zod";

export class PolicyParseError extends Error {
  override name = "PolicyParseError";
  constructor(
    public readonly issues: z.ZodIssue[],
    public readonly filePath: string
  ) {
    super(
      `policy file is invalid (${filePath}): ${issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
}
