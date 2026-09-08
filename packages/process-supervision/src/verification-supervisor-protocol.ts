const TARGET_ENVIRONMENT_MAX_ENTRIES = 256;
const TARGET_ENVIRONMENT_MAX_BYTES = 32_000;

export const SUPERVISOR_START_FRAME_MAX_BYTES = 48_000;

const validEnvironmentEntry = (entry: [string, unknown]): entry is [string, string] => {
  const [key, value] = entry;
  return (
    key.length > 0 &&
    key.length <= 1_024 &&
    !key.includes("=") &&
    !key.includes("\u0000") &&
    typeof value === "string" &&
    !value.includes("\u0000")
  );
};

const environmentEntries = (value: unknown): readonly (readonly [string, string])[] | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > TARGET_ENVIRONMENT_MAX_ENTRIES || !entries.every(validEnvironmentEntry)) {
    return null;
  }
  return entries;
};

export const encodeSupervisorStartFrame = (
  controlToken: string,
  environment: Readonly<Record<string, string>>,
): string => {
  const entries = environmentEntries(environment);
  if (entries === null) throw new TypeError("Target environment is invalid");
  const serialized = JSON.stringify(Object.fromEntries(entries));
  if (Buffer.byteLength(serialized, "utf8") > TARGET_ENVIRONMENT_MAX_BYTES) {
    throw new TypeError("Target environment exceeds the supervisor protocol limit");
  }
  const frame = `GO:${controlToken}:${Buffer.from(serialized, "utf8").toString("base64url")}\n`;
  if (Buffer.byteLength(frame, "utf8") > SUPERVISOR_START_FRAME_MAX_BYTES) {
    throw new TypeError("Supervisor start frame exceeds the protocol limit");
  }
  return frame;
};

export const parseSupervisorStartFrame = (
  frame: string,
  expectedControlToken: string,
): Readonly<Record<string, string>> | null => {
  const prefix = `GO:${expectedControlToken}:`;
  if (!frame.startsWith(prefix)) return null;
  const payload = frame.slice(prefix.length);
  if (payload.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
  const serialized = Buffer.from(payload, "base64url");
  if (serialized.byteLength > TARGET_ENVIRONMENT_MAX_BYTES || serialized.toString("base64url") !== payload) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const entries = environmentEntries(parsed);
  return entries === null ? null : Object.fromEntries(entries);
};
