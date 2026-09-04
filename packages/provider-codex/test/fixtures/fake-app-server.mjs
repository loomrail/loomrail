/* eslint-disable no-undef -- spawned directly by Node outside the TypeScript test runtime. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [, , mode = "success", logPath = ""] = process.argv;
const writeLog = (message) => {
  if (logPath.length > 0) appendFileSync(logPath, `${JSON.stringify(message)}\n`, "utf8");
};
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rateLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: "Codex",
    primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_788_560_000 },
    secondary: { usedPercent: 51, windowDurationMins: 10_080, resetsAt: 1_789_000_000 },
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  account: { email: "sensitive-canary@example.test" },
  credits: { balance: "sensitive-canary" },
};

const currentRateLimits = {
  ...rateLimits,
  rateLimits: {
    ...rateLimits.rateLimits,
    limitId: null,
    credits: { balance: "nested-sensitive-canary" },
    individualLimit: { amount: "nested-sensitive-canary" },
    planType: "pro",
    spendControlReached: null,
  },
  rateLimitsByLimitId: {
    codex: {
      ...rateLimits.rateLimits,
      limitId: null,
      credits: { balance: "nested-sensitive-canary" },
      individualLimit: null,
      planType: "pro",
      spendControlReached: false,
    },
  },
};

if (mode === "timeout-stubborn") process.on("SIGTERM", () => undefined);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  writeLog(message);

  if (message.id === 1) {
    if (mode === "premature-exit") process.exit(0);
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    if (mode === "overlong") {
      process.stdout.write(`${"x".repeat(40_000)}\n`);
      return;
    }
    emit({ id: 1, result: { userAgent: "fake" } });
    return;
  }

  if (message.id !== 2) return;
  if (mode === "timeout" || mode === "timeout-stubborn") return;
  if (mode === "wrong-id") {
    emit({ id: 999, result: rateLimits });
    return;
  }
  if (mode === "error") {
    emit({ id: 2, error: { code: -32_000, message: "unavailable" } });
    return;
  }
  if (mode === "notification") {
    emit({ method: "account/rateLimits/updated", params: rateLimits });
    return;
  }
  if (mode === "current-shape") {
    emit({ id: 2, result: currentRateLimits });
    return;
  }
  if (mode === "incomplete-window") {
    emit({
      id: 2,
      result: {
        ...currentRateLimits,
        rateLimitsByLimitId: {
          codex: {
            ...currentRateLimits.rateLimitsByLimitId.codex,
            primary: { usedPercent: 24, windowDurationMins: null, resetsAt: null },
          },
        },
      },
    });
    return;
  }
  emit({ id: 2, result: rateLimits });
});
