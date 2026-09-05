import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { VerificationPlan } from "@loomrail/contracts";

import {
  parseMarkerBoundVerificationPlan,
  verificationPlanContentHash,
  verificationPlanFileContent,
} from "./plan-file.js";
import { verificationRecipeAuthorityIsCurrent } from "./verification.js";

const TARGET_DIRECTORY = ".loomrail";
const TARGET_FILENAME = "verification-plan.json";
const MAX_TARGET_BYTES = 512 * 1024;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const errorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

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
  for (const recipe of plan.recipes) {
    const canonicalCwd = await realpath(join(root, recipe.cwd)).catch(() => null);
    const relativeCwd = canonicalCwd === null ? ".." : relative(root, canonicalCwd);
    if (
      canonicalCwd === null ||
      relativeCwd === ".." ||
      relativeCwd.startsWith(`..${sep}`) ||
      isAbsolute(relativeCwd) ||
      !(await verificationRecipeAuthorityIsCurrent({
        canonicalCwd,
        canonicalWorktree: root,
        recipe,
      }))
    ) {
      throw new ProjectVerificationPublicationError(
        "PROPOSAL_CHANGED",
        "package.json no longer matches the owner preview",
      );
    }
  }
};

type TargetDirectory = { path: string; canonicalPath: string; device: number; inode: number };
type CurrentTarget = { digest: string | null; content: string | null };

const requireStableTargetDirectory = async (directory: TargetDirectory): Promise<void> => {
  const metadata = await lstat(directory.path).catch(() => null);
  const canonicalPath = await realpath(directory.path).catch(() => null);
  if (
    metadata === null ||
    canonicalPath === null ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== directory.device ||
    metadata.ino !== directory.inode ||
    !samePath(canonicalPath, directory.canonicalPath)
  ) {
    throw new ProjectVerificationPublicationError(
      "TARGET_CHANGED",
      "The .loomrail target directory changed during publication",
    );
  }
};

const currentTarget = async (path: string, directory: TargetDirectory): Promise<CurrentTarget> => {
  try {
    await requireStableTargetDirectory(directory);
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
      await requireStableTargetDirectory(directory);
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

const requireTargetDirectory = async (root: string): Promise<TargetDirectory> => {
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
  const metadata = await lstat(path).catch(() => null);
  const canonicalPath = await realpath(path).catch(() => null);
  if (
    metadata === null ||
    canonicalPath === null ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !samePath(canonicalPath, path)
  ) {
    throw new ProjectVerificationPublicationError(
      "TARGET_OUTSIDE_REPOSITORY",
      "The .loomrail target directory does not resolve inside the Project repository",
    );
  }
  return { path, canonicalPath, device: metadata.dev, inode: metadata.ino };
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
  // Disabling removes execution authority and must remain possible even after the repository
  // manifest changes. Active Plans, in contrast, publish only while every reviewed script byte is current.
  if (input.plan.status === "ACTIVE") await requireCurrentManifest(root, input.plan);
  const directory = await requireTargetDirectory(root);
  const target = join(directory.path, TARGET_FILENAME);
  const before = await currentTarget(target, directory);
  if (before.content === content) return;
  if (before.digest !== input.expectedTargetDigest) {
    throw new ProjectVerificationPublicationError(
      "TARGET_CHANGED",
      "The verification plan target changed after the owner preview",
    );
  }

  const temporary = join(directory.path, `.verification-plan-${randomUUID()}.tmp`);
  try {
    await requireStableTargetDirectory(directory);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await requireStableTargetDirectory(directory);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const rechecked = await currentTarget(target, directory);
    if (rechecked.digest !== before.digest) {
      throw new ProjectVerificationPublicationError(
        "TARGET_CHANGED",
        "The verification plan target changed before publication",
      );
    }
    await requireStableTargetDirectory(directory);
    await rename(temporary, target);
    await requireStableTargetDirectory(directory);
    const published = await currentTarget(target, directory);
    if (published.content !== content) {
      throw new ProjectVerificationPublicationError(
        "TARGET_CHANGED",
        "The verification plan target changed during publication",
      );
    }
  } catch (error: unknown) {
    await requireStableTargetDirectory(directory)
      .then(() => unlink(temporary))
      .catch(() => undefined);
    if (error instanceof ProjectVerificationPublicationError) throw error;
    throw new ProjectVerificationPublicationError(
      "WRITE_FAILED",
      "The approved verification plan could not be written atomically",
      { cause: error },
    );
  }
};
