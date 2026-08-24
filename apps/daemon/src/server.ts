import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import {
  apiErrorResponseSchema,
  correlationIdSchema,
  createWorkItemRequestSchema,
  daemonStatusResponseSchema,
  eventsResponseSchema,
  healthResponseSchema,
  moveWorkItemRequestSchema,
  opaqueIdSchema,
  projectsResponseSchema,
  registerFixtureProjectRequestSchema,
  sessionExchangeRequestSchema,
  sessionExchangeResponseSchema,
  updateWorkItemRequestSchema,
  workItemResponseSchema,
  workItemsResponseSchema,
  workItemStateSchema,
  type ApiErrorResponse,
} from "@loomrail/contracts";
import { WorkItemDomainError } from "@loomrail/domain";
import { openLocalState, StateStoreError } from "@loomrail/persistence-sqlite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { FixtureResolutionError, resolveBundledFixture } from "./fixtures.js";

const API_VERSION = "v1" as const;
const DAEMON_VERSION = "0.0.0";
const SESSION_COOKIE = "loomrail_session";
const CSRF_HEADER = "x-loomrail-csrf";
const BOOTSTRAP_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

type Clock = () => Date;

type DaemonLoggerOption = boolean | { level: string };
type DaemonLoggerStream = { write: (message: string) => void };

export type StartDaemonOptions = {
  bootstrapToken: string;
  webRoot?: string;
  stateDatabasePath?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  now?: Clock;
  logger?: DaemonLoggerOption;
  loggerStream?: DaemonLoggerStream;
};

export type RunningDaemon = {
  app: FastifyInstance;
  baseUrl: string;
  bootstrapUrl: string;
  close: () => Promise<void>;
};

type Session = {
  csrfToken: string;
  expiresAt: Date;
};

type BootstrapGrant = {
  tokenHash: Buffer;
  expiresAt: Date;
  used: boolean;
};

const projectParamsSchema = z.object({ projectId: opaqueIdSchema }).strict();
const workItemParamsSchema = z.object({ workItemId: opaqueIdSchema }).strict();
const workItemsQuerySchema = z.object({ state: workItemStateSchema.optional() }).strict();
const eventsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    projectId: opaqueIdSchema.optional(),
    aggregateId: opaqueIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const hashSecret = (value: string): Buffer => createHash("sha256").update(value).digest();

const encodeSecret = (): string => randomBytes(32).toString("base64url");

const secretsEqual = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const normalizePlatform = (): "darwin" | "win32" | "linux" | "other" => {
  const value = platform();
  return value === "darwin" || value === "win32" || value === "linux" ? value : "other";
};

const createError = (
  code: string,
  message: string,
  correlationId: string,
  details?: Readonly<Record<string, string | number>>,
): ApiErrorResponse =>
  apiErrorResponseSchema.parse({
    error: {
      code,
      message,
      correlationId,
      ...(details === undefined ? {} : { details }),
    },
  });

const requestCorrelationId = (request: FastifyRequest): string => {
  const header = request.headers["x-correlation-id"];
  const parsed = correlationIdSchema.safeParse(header);
  return parsed.success ? parsed.data : randomUUID();
};

const sendOperationError = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: string,
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply
      .code(400)
      .send(createError("INVALID_REQUEST", "The request payload is invalid", correlationId));
  }
  if (error instanceof FixtureResolutionError) {
    return reply.code(400).send(createError(error.code, error.message, correlationId));
  }
  if (error instanceof WorkItemDomainError) {
    const status = error.code === "WORK_ITEM_NOT_FOUND" || error.code === "PARENT_NOT_FOUND" ? 404 : 409;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }
  if (error instanceof StateStoreError) {
    const status =
      error.code === "PROJECT_NOT_FOUND"
        ? 404
        : error.code === "COMMAND_ID_REUSED" || error.code === "PROJECT_ALREADY_REGISTERED"
          ? 409
          : error.code === "STATE_CLOSED"
            ? 503
            : 500;
    return reply.code(status).send(createError(error.code, error.message, correlationId, error.details));
  }

  request.log.error(
    { correlationId, errorName: error instanceof Error ? error.name : "UnknownError" },
    "Local state operation failed",
  );
  return reply
    .code(500)
    .send(createError("INTERNAL_ERROR", "The local operation could not be completed", correlationId));
};

export const startDaemon = async (options: StartDaemonOptions): Promise<RunningDaemon> => {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Loomrail local daemon can only bind to a loopback address");
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const bootstrap: BootstrapGrant = {
    tokenHash: hashSecret(options.bootstrapToken),
    expiresAt: new Date(startedAt.getTime() + BOOTSTRAP_TTL_MS),
    used: false,
  };
  const sessions = new Map<string, Session>();
  const localState = await openLocalState({
    databasePath: options.stateDatabasePath ?? ":memory:",
    now,
  });
  let allowedOrigin = "";
  let closing = false;

  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger:
      options.logger ??
      ({
        level: "info",
        redact: {
          paths: [
            "req.headers.cookie",
            "req.headers.authorization",
            `req.headers["${CSRF_HEADER}"]`,
            "res.headers.set-cookie",
          ],
          censor: "[REDACTED]",
        },
        ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
      } as const),
    genReqId: () => randomUUID(),
  });

  const sessionForRequest = (request: FastifyRequest): Session | undefined => {
    const sessionToken = request.cookies[SESSION_COOKIE];
    if (!sessionToken) return undefined;
    const key = hashSecret(sessionToken).toString("hex");
    const session = sessions.get(key);
    if (!session || session.expiresAt.getTime() <= now().getTime()) {
      sessions.delete(key);
      return undefined;
    }
    return session;
  };

  const requireSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    correlationId: string,
  ): Session | null => {
    const session = sessionForRequest(request);
    if (session) return session;
    void reply
      .code(401)
      .send(createError("SESSION_REQUIRED", "A valid local session is required", correlationId));
    return null;
  };

  const authorizeMutation = (
    request: FastifyRequest,
    reply: FastifyReply,
    correlationId: string,
  ): Session | null => {
    const session = requireSession(request, reply, correlationId);
    if (!session) return null;
    if (request.headers.origin !== allowedOrigin) {
      void reply
        .code(403)
        .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
      return null;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      void reply
        .code(415)
        .send(createError("JSON_REQUIRED", "Mutations require application/json", correlationId));
      return null;
    }
    const suppliedCsrf = request.headers[CSRF_HEADER];
    if (
      typeof suppliedCsrf !== "string" ||
      !secretsEqual(hashSecret(suppliedCsrf), hashSecret(session.csrfToken))
    ) {
      void reply
        .code(403)
        .send(createError("CSRF_REJECTED", "The CSRF token is missing or invalid", correlationId));
      return null;
    }
    return session;
  };

  try {
    await app.register(cookie);
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    });

    app.get("/health/live", () =>
      healthResponseSchema.parse({ status: "live", apiVersion: API_VERSION, timestamp: now().toISOString() }),
    );

    app.get("/health/ready", () =>
      healthResponseSchema.parse({
        status: "ready",
        apiVersion: API_VERSION,
        timestamp: now().toISOString(),
      }),
    );

    app.post("/api/session/exchange", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (request.headers.origin !== allowedOrigin) {
        return reply
          .code(403)
          .send(createError("ORIGIN_REJECTED", "The request origin is not allowed", correlationId));
      }

      const body = sessionExchangeRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .send(createError("INVALID_BOOTSTRAP_REQUEST", "The bootstrap request is invalid", correlationId));
      }

      const suppliedHash = hashSecret(body.data.bootstrapToken);
      const expired = bootstrap.expiresAt.getTime() <= now().getTime();
      if (bootstrap.used || expired || !secretsEqual(bootstrap.tokenHash, suppliedHash)) {
        return reply
          .code(401)
          .send(
            createError("BOOTSTRAP_REJECTED", "The bootstrap token is invalid or expired", correlationId),
          );
      }

      bootstrap.used = true;
      const sessionToken = encodeSecret();
      const csrfToken = encodeSecret();
      const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
      sessions.set(hashSecret(sessionToken).toString("hex"), { csrfToken, expiresAt });

      reply.setCookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1_000),
      });

      return sessionExchangeResponseSchema.parse({
        authenticated: true,
        csrfToken,
        expiresAt: expiresAt.toISOString(),
      });
    });

    app.get("/api/v1/status", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;

      return daemonStatusResponseSchema.parse({
        apiVersion: API_VERSION,
        authenticated: true,
        daemon: {
          status: "online",
          version: DAEMON_VERSION,
          mode: "local",
          startedAt: startedAt.toISOString(),
          platform: normalizePlatform(),
        },
        foundation: {
          phase: "phase-0",
          milestone: "M2",
          providers: "mock-only",
          persistence: "sqlite",
        },
      });
    });

    app.get("/api/v1/projects", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const result = localState.query({ type: "LIST_PROJECTS" });
        return projectsResponseSchema.parse({
          schemaVersion: 1,
          projects: result.type === "PROJECTS" ? result.projects : [],
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/projects/fixtures/register", async (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = registerFixtureProjectRequestSchema.parse(request.body);
        const fixture = await resolveBundledFixture(body.fixtureId);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "REGISTER_FIXTURE_PROJECT",
          payload: {
            id: fixture.projectId,
            fixtureId: fixture.fixtureId,
            name: fixture.name,
            repositoryPath: fixture.repositoryPath,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/projects/:projectId/work-items", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = projectParamsSchema.parse(request.params);
        const query = workItemsQuerySchema.parse(request.query);
        const project = localState.query({ type: "GET_PROJECT", projectId: params.projectId });
        if (project.type !== "PROJECT" || !project.project) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        const result = localState.query({
          type: "LIST_WORK_ITEMS",
          projectId: params.projectId,
          ...(query.state === undefined ? {} : { state: query.state }),
        });
        return workItemsResponseSchema.parse({
          schemaVersion: 1,
          workItems: result.type === "WORK_ITEMS" ? result.workItems : [],
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/work-items/:workItemId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const result = localState.query({ type: "GET_WORK_ITEM", workItemId: params.workItemId });
        if (result.type !== "WORK_ITEM" || !result.workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        return workItemResponseSchema.parse({ schemaVersion: 1, workItem: result.workItem });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const body = createWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CREATE_WORK_ITEM",
          payload: {
            projectId: body.projectId,
            parentId: body.parentId,
            type: body.type,
            title: body.title,
            description: body.description,
            priority: body.priority,
            risk: body.risk,
            acceptanceCriteria: body.acceptanceCriteria,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.patch("/api/v1/work-items/:workItemId", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = updateWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "UPDATE_WORK_ITEM",
          payload: {
            workItemId: params.workItemId,
            expectedVersion: body.expectedVersion,
            patch: body.patch,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.post("/api/v1/work-items/:workItemId/move", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!authorizeMutation(request, reply, correlationId)) return;
      try {
        const params = workItemParamsSchema.parse(request.params);
        const body = moveWorkItemRequestSchema.parse(request.body);
        return localState.execute({
          schemaVersion: 1,
          commandId: body.commandId,
          correlationId,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "MOVE_WORK_ITEM",
          payload: {
            workItemId: params.workItemId,
            expectedVersion: body.expectedVersion,
            targetState: body.targetState,
          },
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    app.get("/api/v1/events", (request, reply) => {
      const correlationId = requestCorrelationId(request);
      if (!requireSession(request, reply, correlationId)) return;
      try {
        const query = eventsQuerySchema.parse(request.query);
        const result = localState.query({
          type: "LIST_EVENTS",
          afterSequence: query.after,
          limit: query.limit,
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          ...(query.aggregateId === undefined ? {} : { aggregateId: query.aggregateId }),
        });
        return eventsResponseSchema.parse({
          schemaVersion: 1,
          events: result.type === "EVENTS" ? result.events : [],
          nextSequence: result.type === "EVENTS" ? result.nextSequence : query.after,
        });
      } catch (error: unknown) {
        return sendOperationError(error, request, reply, correlationId);
      }
    });

    if (options.webRoot) {
      const webRoot = resolve(options.webRoot);
      await access(webRoot);
      await app.register(fastifyStatic, { root: webRoot, wildcard: false });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
          return reply
            .code(404)
            .send(
              createError(
                "NOT_FOUND",
                "The requested endpoint does not exist",
                requestCorrelationId(request),
              ),
            );
        }
        return reply.sendFile("index.html");
      });
    }

    const address = await app.listen({ host, port: options.port ?? 0 });
    const baseUrl = address.replace("[::1]", "127.0.0.1");
    allowedOrigin = baseUrl;
    const bootstrapUrl = `${baseUrl}/#bootstrap=${encodeURIComponent(options.bootstrapToken)}`;

    return {
      app,
      baseUrl,
      bootstrapUrl,
      close: async () => {
        if (closing) return;
        closing = true;
        try {
          await app.close();
        } finally {
          localState.close();
        }
      },
    };
  } catch (error: unknown) {
    localState.close();
    await app.close();
    throw error;
  }
};
