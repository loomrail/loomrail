import type { Project, ProviderAllowanceSnapshot, RecordProviderAllowanceCommand } from "@loomrail/contracts";

export type ProviderAllowanceDomainErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROVIDER_ALLOWANCE_ACTOR_FORBIDDEN"
  | "PROVIDER_ALLOWANCE_MOCK_FORBIDDEN"
  | "PROVIDER_ALLOWANCE_STALE";

export class ProviderAllowanceDomainError extends Error {
  readonly code: ProviderAllowanceDomainErrorCode;

  constructor(code: ProviderAllowanceDomainErrorCode, message: string) {
    super(message);
    this.name = "ProviderAllowanceDomainError";
    this.code = code;
  }
}

export type ProviderAllowanceRecordedIntent = {
  type: "PROVIDER_ALLOWANCE_RECORDED";
  data: { snapshot: ProviderAllowanceSnapshot };
};

export const decideRecordProviderAllowance = (
  command: RecordProviderAllowanceCommand,
  context: { project?: Project; current?: ProviderAllowanceSnapshot },
): { snapshot: ProviderAllowanceSnapshot; event: ProviderAllowanceRecordedIntent } => {
  if (command.actor.type !== "SYSTEM") {
    throw new ProviderAllowanceDomainError(
      "PROVIDER_ALLOWANCE_ACTOR_FORBIDDEN",
      "Only the daemon may record provider allowance observations",
    );
  }
  if (command.payload.snapshot.provider === "MOCK") {
    throw new ProviderAllowanceDomainError(
      "PROVIDER_ALLOWANCE_MOCK_FORBIDDEN",
      "Mock has no external provider allowance to record",
    );
  }
  const project = context.project;
  if (project === undefined) {
    throw new ProviderAllowanceDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (project.status !== "ACTIVE") {
    throw new ProviderAllowanceDomainError(
      "PROJECT_NOT_ACTIVE",
      "Provider allowance can be observed only for an active Project",
    );
  }
  if (
    context.current !== undefined &&
    Date.parse(command.payload.snapshot.observedAt) <= Date.parse(context.current.observedAt)
  ) {
    throw new ProviderAllowanceDomainError(
      "PROVIDER_ALLOWANCE_STALE",
      "An older or duplicate provider allowance observation cannot replace the current one",
    );
  }
  return {
    snapshot: command.payload.snapshot,
    event: { type: "PROVIDER_ALLOWANCE_RECORDED", data: { snapshot: command.payload.snapshot } },
  };
};
