import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureProjectIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  type FixtureProjectId,
} from "@loomrail/contracts";
import { z } from "zod";

const fixtureManifestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    fixtureId: fixtureProjectIdSchema,
    projectId: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export type ResolvedFixtureProject = {
  fixtureId: FixtureProjectId;
  projectId: string;
  name: string;
  repositoryPath: string;
};

export class FixtureResolutionError extends Error {
  readonly code: "FIXTURE_PATH_ESCAPE" | "FIXTURE_MANIFEST_INVALID";

  constructor(code: FixtureResolutionError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FixtureResolutionError";
    this.code = code;
  }
}

const bundledFixturesRoot = fileURLToPath(new URL("../../../fixtures/projects", import.meta.url));

const isContainedPath = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

export const resolveBundledFixture = async (
  fixtureId: FixtureProjectId,
  fixturesRoot = bundledFixturesRoot,
): Promise<ResolvedFixtureProject> => {
  try {
    const canonicalRoot = await realpath(resolve(fixturesRoot));
    const canonicalProject = await realpath(resolve(canonicalRoot, fixtureId));
    if (!isContainedPath(canonicalRoot, canonicalProject)) {
      throw new FixtureResolutionError(
        "FIXTURE_PATH_ESCAPE",
        "The fixture Project resolves outside the bundled fixture directory",
      );
    }

    const canonicalManifest = await realpath(resolve(canonicalProject, "loomrail-fixture.json"));
    if (!isContainedPath(canonicalProject, canonicalManifest)) {
      throw new FixtureResolutionError(
        "FIXTURE_PATH_ESCAPE",
        "The fixture manifest resolves outside its bundled Project directory",
      );
    }

    const manifestText = await readFile(canonicalManifest, "utf8");
    const manifestValue: unknown = JSON.parse(manifestText) as unknown;
    const manifest = fixtureManifestSchema.parse(manifestValue);
    if (manifest.fixtureId !== fixtureId) {
      throw new FixtureResolutionError(
        "FIXTURE_MANIFEST_INVALID",
        "The fixture manifest ID does not match its catalog entry",
      );
    }

    return {
      fixtureId,
      projectId: manifest.projectId,
      name: manifest.name,
      repositoryPath: canonicalProject,
    };
  } catch (error: unknown) {
    if (error instanceof FixtureResolutionError) throw error;
    throw new FixtureResolutionError(
      "FIXTURE_MANIFEST_INVALID",
      "The bundled fixture Project could not be validated",
      { cause: error },
    );
  }
};
