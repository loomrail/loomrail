import { createServer } from "node:http";
import process from "node:process";

import { renderPage } from "./tasks.mjs";

const requestedPort = Number(process.env.LOOMRAIL_SAMPLE_PORT ?? "4173");
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("LOOMRAIL_SAMPLE_PORT must be an integer between 1 and 65535");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end('{"status":"ready"}\n');
    return;
  }
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderPage());
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

server.listen(requestedPort, "127.0.0.1", () => {
  process.stdout.write(`Loomrail web sample: http://127.0.0.1:${requestedPort.toString()}\n`);
});
