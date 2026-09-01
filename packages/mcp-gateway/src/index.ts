import type { McpConsent, McpProfileCandidate, McpProfileRevision } from "@loomrail/contracts";

import { recoverMcpOrphans, type McpOrphanRecoveryReport } from "./process-registry.js";
import { McpGatewayError, resolveMcpProfileCandidate } from "./preflight.js";
import { probeMcpRevision, type McpProbeObservation } from "./probe.js";
import {
  createMcpRuntime,
  type McpGatewayLease,
  type McpGatewayRuntimeOptions,
  type McpGatewaySessionBinding,
} from "./runtime.js";

export type McpGateway = {
  /** Resolve and validate exact local paths without spawning a process. */
  resolveCandidate: (candidate: McpProfileCandidate) => Promise<McpProfileCandidate>;
  /** Spawn a consented revision for one bounded discovery pass, then always close it. */
  probe: (revision: McpProfileRevision, consent: McpConsent) => Promise<McpProbeObservation>;
  /** Kill identity-matched process trees whose durable supervisor record survived a crash. */
  recoverOrphans: () => Promise<McpOrphanRecoveryReport[]>;
  /** Open daemon-owned servers and expose only session-scoped local proxy connectors. */
  open: (bindings: readonly McpGatewaySessionBinding[]) => Promise<McpGatewayLease>;
  /** Reject new calls through every live connector backed by this durable grant. */
  revoke: (grantId: string) => void;
  close: (providerSessionId: string) => Promise<void>;
  shutdown: () => Promise<void>;
};

export const createMcpGateway = (options: McpGatewayRuntimeOptions = {}): McpGateway => {
  const activeProbes = new Set<string>();
  const runtime = createMcpRuntime(options);
  return {
    resolveCandidate: resolveMcpProfileCandidate,
    async probe(revision, consent) {
      if (activeProbes.has(revision.id)) {
        throw new McpGatewayError(
          "PROBE_ALREADY_RUNNING",
          "A capability probe is already running for this MCP revision",
        );
      }
      activeProbes.add(revision.id);
      try {
        return await probeMcpRevision(revision, consent, options);
      } finally {
        activeProbes.delete(revision.id);
      }
    },
    recoverOrphans: () => recoverMcpOrphans(options.registryDirectory),
    open: runtime.open,
    revoke: runtime.revoke,
    close: runtime.close,
    shutdown: runtime.shutdown,
  };
};

export { assertMcpRevisionExecutable, McpGatewayError } from "./preflight.js";
export { mcpProbeEnvironment, probeMcpRevision } from "./probe.js";
export type { McpGatewayErrorCode } from "./preflight.js";
export type { McpProbeObservation } from "./probe.js";
export type { McpOrphanRecoveryReport } from "./process-registry.js";
export type {
  McpGatewayLease,
  McpGatewayRuntimeOptions,
  McpGatewaySessionBinding,
  McpProxyConnector,
  McpToolCallTerminalOutcome,
} from "./runtime.js";
