import process from "node:process";
import { setInterval } from "node:timers";

if (process.platform !== "win32") {
  process.on("SIGTERM", () => undefined);
}

setInterval(() => undefined, 1_000);
