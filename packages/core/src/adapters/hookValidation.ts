export interface HookHandler {
  command: string;
  matcher?: string;
  script_path?: string;
  async?: boolean;
  timeout?: number;
  commandWindows?: string;
  statusMessage?: string;
}

export function parseHookHandler(value: unknown): {
  handler: HookHandler | null;
  invalidFields: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { handler: null, invalidFields: ["handler"] };
  }
  const raw = value as Record<string, unknown>;
  const allowedFields = new Set([
    "kind",
    "command",
    "matcher",
    "script_path",
    "async",
    "timeout",
    "commandWindows",
    "statusMessage",
  ]);
  const invalidFields = Object.keys(raw).filter((field) => !allowedFields.has(field));
  if (typeof raw["command"] !== "string" || raw["command"].trim().length === 0) {
    invalidFields.push("command");
  }
  if (raw["kind"] !== undefined && raw["kind"] !== "shell") invalidFields.push("kind");
  for (const field of ["matcher", "script_path", "commandWindows"]) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== "string" || raw[field].trim().length === 0)
    ) {
      invalidFields.push(field);
    }
  }
  if (raw["statusMessage"] !== undefined && typeof raw["statusMessage"] !== "string") {
    invalidFields.push("statusMessage");
  }
  if (raw["async"] !== undefined && typeof raw["async"] !== "boolean") {
    invalidFields.push("async");
  }
  if (
    raw["timeout"] !== undefined &&
    (typeof raw["timeout"] !== "number" ||
      !Number.isInteger(raw["timeout"]) ||
      raw["timeout"] < 0)
  ) {
    invalidFields.push("timeout");
  }
  if (invalidFields.length > 0) return { handler: null, invalidFields };
  return { handler: raw as unknown as HookHandler, invalidFields };
}

const UNSAFE_EVENT_KEYS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

function eventValueFromContainer(
  container: unknown,
  keys: readonly string[],
): { found: boolean; value: unknown } {
  if (container === undefined) return { found: false, value: undefined };
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return { found: true, value: container };
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(container, key)) {
      return { found: true, value: (container as Record<string, unknown>)[key] };
    }
  }
  return { found: false, value: undefined };
}

export function selectHookEventValue(
  lifecycleEvents: unknown,
  descriptorEvents: unknown,
  platform: string,
): unknown {
  const keys = [platform, "generic"];
  const lifecycle = eventValueFromContainer(lifecycleEvents, keys);
  if (lifecycle.found) return lifecycle.value;
  const descriptor = eventValueFromContainer(descriptorEvents, keys);
  return descriptor.found ? descriptor.value : undefined;
}

export function parseHookEvents(
  value: unknown,
  defaultEvents: readonly string[],
): string[] | null {
  const events = value === undefined ? [...defaultEvents] : value;
  if (!Array.isArray(events) || events.length === 0) return null;
  if (
    !events.every(
      (event): event is string =>
        typeof event === "string" &&
        event.trim().length > 0 &&
        !UNSAFE_EVENT_KEYS.has(event),
    )
  ) {
    return null;
  }
  return [...events];
}
