import { createProviderTestDouble } from "../apps/daemon/test/provider-double.js";
import {
  startDaemon as startProductionDaemon,
  type RunningDaemon,
  type StartDaemonOptions,
} from "../apps/daemon/dist/server.js";

export type { RunningDaemon };

/**
 * Browser tests use the production daemon with an explicit test-only provider seam. Tests that
 * exercise provider selection pass their own registry and therefore keep that exact boundary.
 */
export const startDaemon = (options: StartDaemonOptions): Promise<RunningDaemon> =>
  startProductionDaemon(
    options.providerAdapter !== undefined || options.providerRegistry !== undefined
      ? options
      : { ...options, providerAdapter: createProviderTestDouble() },
  );
