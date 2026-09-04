import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { VerificationPlan } from "@loomrail/contracts";

import {
  parseMarkerBoundVerificationPlan,
  verificationPlanContentHash,
  verificationPlanFileContent,
} from "./plan-file.js";

const MANIFEST_PATH = "package.json";
const TARGET_DIRECTORY = ".loomrail";
const TARGET_FILENAME = "verification-plan.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TARGET_BYTES = 512 * 1024;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const errorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

export type ProjectVerificationPublicationErrorCode =
  | "REPOSITORY_UNAVAILABLE"
  | "TARGET_OUTSIDE_REPOSITORY"
  | "TARGET_UNREADABLE"
  | "TARGET_UNRECOGNIZED"
  | "TARGET_CHANGED"
  | "PROPOSAL_CHANGED"
  | "CONTENT_HASH_MISMATCH"
  | "WRITE_FAILED";

export class ProjectVerificationPublicationError extends Error {
  readonly code: ProjectVerificationPublicationErrorCode;

  constructor(code: ProjectVerificationPublicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectVerificationPublicationError";
    this.code = code;
  }
}

const requireCurrentManifest = async (root: string, plan: VerificationPlan): Promise<void> => {
  const expected = new Set(plan.recipes.map((recipe) => recipe.provenance.manifestContentHash));
  if (expected.size !== 1) {
    throw new ProjectVerificationPublicationError(
      "PROPOSAL_CHANGED",
      "The adopted recipes do not share one exact manifest snapshot",
    );
  }
  const path = join(root, MANIFEST_PATH);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
      throw new ProjectVerificationPublicationError(
        "PROPOSAL_CHANGED",
        "package.json no longer matches the owner preview",
      );
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_MANIFEST_BYTES || !expected.has(sha256(bytes))) {
      throw new ProjectVerificationPublicationError(
        "PROPOSAL_CHANGED",
        "package.json changed after the owner preview",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ProjectVerificationPublicationError) throw error;
    throw new ProjectVerificationPublicationError(
      "PROPOSAL_CHANGED",
      "package.json could not be matched to the owner preview",
      { cause: error },
    );
  }
};

type CurrentTarget = { digest: string | null; content: string | null };

const currentTarget = async (path: string): Promise<CurrentTarget> => {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ProjectVerificationPublicationError(
        "TARGET_OUTSIDE_REPOSITORY",
        "The verification plan target is not a regular Project file",
      );
    }
    if (metadata.size > MAX_TARGET_BYTES) {
      throw new ProjectVerificationPublicationError(
        "TARGET_UNREADABLE",
        "The verification plan target exceeds the comparison limit",
      );
    }
    const handle = await open(path, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new ProjectVerificationPublicationError(
          "TARGET_CHANGED",
          "The verification plan target changed during inspection",
        );
      }
      const bytes = await handle.readFile();
      const content = bytes.toString("utf8");
      if (bytes.byteLength > MAX_TARGET_BYTES) {
        throw new ProjectVerificationPublicationError(
          "TARGET_UNREADABLE",
          "The verification plan target exceeds the comparison limit",
        );
      }
      if (parseMarkerBoundVerificationPlan(content) === null) {
        throw new ProjectVerificationPublicationError(
          "TARGET_UNRECOGNIZED",
          "The existing verification plan is not marker-bound Loomrail content",
        );
      }
      return { digest: sha256(bytes), content };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (error instanceof ProjectVerificationPublicationError) throw error;
    if (errorCode(error) === "ENOENT") return { digest: null, content: null };
    throw new ProjectVerificationPublicationError(
      "TARGET_UNREADABLE",
      "The verification plan target could not be inspected",
      { cause: error },
    );
  }
};

const requireTargetDirectory = async (root: string): Promise<string> => {
  const path = join(root, TARGET_DIRECTORY);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ProjectVerificationPublicationError(
        "TARGET_OUTSIDE_REPOSITORY",
        "The .loomrail target is not a regular Project directory",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ProjectVerificationPublicationError) throw error;
    if (errorCode(error) === "ENOENT") {
      try {
        await mkdir(path, { recursive: false, mode: 0o700 });
      } catch (cause: unknown) {
        throw new ProjectVerificationPublicationError(
          "WRITE_FAILED",
          "The .loomrail target directory could not be created",
          { cause },
        );
      }
    } else {
      throw new ProjectVerificationPublicationError(
        "TARGET_UNREADABLE",
        "The .loomrail target directory could not be inspected",
        { cause: error },
      );
    }
  }
  return path;
};

export const publishVerificationPlan = async (input: {
  repositoryPath: string;
  expectedTargetDigest: string | null;
  plan: VerificationPlan;
}): Promise<void> => {
  if (verificationPlanContentHash(input.plan) !== input.plan.contentHash) {
    throw new ProjectVerificationPublicationError(
      "CONTENT_HASH_MISMATCH",
      "The verification plan does not match its approved content hash",
    );
  }
  let content: string;
  try {
    content = verificationPlanFileContent(input.plan);
  } catch (error: unknown) {
    throw new ProjectVerificationPublicationError(
      "CONTENT_HASH_MISMATCH",
      "The verification plan is not valid marker-bound content",
      { cause: error },
    );
  }

  const root = await realpath(input.repositoryPath).catch(() => null);
  if (root === null) {
    throw new ProjectVerificationPublicationError(
      "REPOSITORY_UNAVAILABLE",
      "The Project repository is unavailable",
    );
  }
  await requireCurrentManifest(root, input.plan);
  const directory = await requireTargetDirectory(root);
  const target = join(directory, TARGET_FILENAME);
  const before = await currentTarget(target);
  if (before.content === content) return;
  if (before.digest !== input.expectedTargetDigest) {
    throw new ProjectVerificationPublicationError(
      "TARGET_CHANGED",
      "The verification plan target changed after the owner preview",
    );
  }

  const temporary = join(directory, `.verification-plan-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const rechecked = await currentTarget(target);
    if (rechecked.digest !== before.digest) {
      throw new ProjectVerificationPublicationError(
        "TARGET_CHANGED",
        "The verification plan target changed before publication",
      );
    }
    await rename(temporary, target);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof ProjectVerificationPublicationError) throw error;
    throw new ProjectVerificationPublicationError(
      "WRITE_FAILED",
      "The approved verification plan could not be written atomically",
      { cause: error },
    );
  }
};
