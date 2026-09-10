import { createServer, type RequestListener, type Server } from "node:http";

import type { LaunchMeasurementPlanConfiguration } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createPlaywrightLaunchMeasurementDriver, LaunchMeasurementDriverError } from "../src/index.js";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const startServer = async (handler: RequestListener): Promise<{ server: Server; origin: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture port unavailable");
  return { server, origin: `http://127.0.0.1:${address.port.toString()}` };
};

const configuration = (targetOrigin: string): LaunchMeasurementPlanConfiguration => ({
  verificationPlanId: "verification-plan-1",
  verificationPlanRevision: 1,
  verificationPlanContentHash: "a".repeat(64),
  startupRecipeId: "package-start",
  dependencyAuditRecipeId: "package-audit",
  targetOrigin,
  healthPath: "/health/ready",
  probePath: "/",
  privateRoutes: ["/private", "/настройки"],
  samples: 3,
  thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 1_048_576 },
  requiredHeaders: ["content-security-policy", "x-content-type-options"],
});

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .filter(({ listening }) => listening)
      .map(closeServer),
  );
});

describe("Playwright launch measurement", () => {
  it("returns only bounded typed projections for headers, routes, scripts and vitals", async () => {
    const secretCanary = ["s", "k-", "1234567890", "abcdefghijklmnop"].join("");
    const script = `globalThis.example=${JSON.stringify(secretCanary)};`;
    const fixture = await startServer((request, response) => {
      if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(script);
        return;
      }
      if (request.url === "/private") {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("not authenticated");
        return;
      }
      if (request.url === "/%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B8") {
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("forbidden");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "nosniff",
        "set-cookie": "private-cookie=must-not-persist; Path=/",
      });
      response.end(
        '<!doctype html><html><body><main><h1>Launch</h1><button>Focus</button></main><script src="/app.js"></script></body></html>',
      );
    });
    servers.push(fixture.server);

    const result = await createPlaywrightLaunchMeasurementDriver().measure(configuration(fixture.origin));

    expect(result.samples).toHaveLength(3);
    expect(result.samples.every(({ scriptBytes }) => scriptBytes === Buffer.byteLength(script))).toBe(true);
    expect(result.headers).toEqual([
      { name: "content-security-policy", present: true },
      { name: "x-content-type-options", present: true },
    ]);
    expect(result.privateRoutes).toEqual([
      { path: "/private", statusCode: 401 },
      { path: "/настройки", statusCode: 403 },
    ]);
    expect(result.secrets).toEqual([{ category: "API_KEY", count: 1 }]);
    expect(result.scannedScriptBytes).toBe(Buffer.byteLength(script));
    expect(result.browserName).toBe("CHROMIUM");
    const durable = JSON.stringify(result);
    expect(durable).not.toContain("default-src");
    expect(durable).not.toContain("private-cookie");
    expect(durable).not.toContain("1234567890abcdefghijklmnop");
    expect(result).not.toHaveProperty("rawBody");
  });

  it("fails closed on an off-origin redirect", async () => {
    const outside = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><h1>Outside</h1>");
    });
    const fixture = await startServer((_request, response) => {
      response.writeHead(302, { location: outside.origin });
      response.end();
    });
    servers.push(outside.server, fixture.server);

    await expect(
      createPlaywrightLaunchMeasurementDriver().measure(configuration(fixture.origin)),
    ).rejects.toMatchObject({ name: "LaunchMeasurementDriverError", code: "ORIGIN_FORBIDDEN" });
  });

  it("rejects hostile localhost resolution before Chromium receives the target", async () => {
    const localhostConfiguration = configuration("http://localhost:4317");
    await expect(
      createPlaywrightLaunchMeasurementDriver({
        resolveHostname: () =>
          Promise.resolve([
            { address: "127.0.0.1", family: 4 },
            { address: "203.0.113.42", family: 4 },
          ]),
      }).measure(localhostConfiguration),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "LaunchMeasurementDriverError",
        code: "ORIGIN_FORBIDDEN",
      }),
    );
  });

  it("cancels with a typed error and never exposes target content", async () => {
    const fixture = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><h1>CANARY_PRIVATE_PAGE</h1>");
      }, 1_000);
    });
    servers.push(fixture.server);
    const controller = new AbortController();
    const measured = createPlaywrightLaunchMeasurementDriver({ timeoutMs: 5_000 }).measure(
      configuration(fixture.origin),
      controller.signal,
    );
    controller.abort();
    const error = await measured.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LaunchMeasurementDriverError);
    expect(error).toMatchObject({ code: "CANCELLED" });
    expect(JSON.stringify(error)).not.toContain("CANARY_PRIVATE_PAGE");
  });
});
