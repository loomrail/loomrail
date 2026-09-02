import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const maximumFileBytes = 128 * 1024;

const catalog = {
  "api-service-b": {
    projectId: "project-fixture-api-service-b",
    packageName: "loomrail-api-service-sample",
    files: [
      "README.md",
      "SAMPLE-WORKFLOWS.md",
      "loomrail-fixture.json",
      "package.json",
      "src/issues.mjs",
      "test/issues.test.mjs",
    ],
    scripts: { test: "node --test" },
  },
  "web-app-a": {
    projectId: "project-fixture-web-app-a",
    packageName: "loomrail-web-app-sample",
    files: [
      "README.md",
      "SAMPLE-WORKFLOWS.md",
      "loomrail-fixture.json",
      "package.json",
      "src/server.mjs",
      "src/tasks.mjs",
      "test/server.test.mjs",
      "test/tasks.test.mjs",
    ],
    scripts: { start: "node src/server.mjs", test: "node --test" },
  },
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value, expected, label) => {
  assert(isPlainObject(value), `${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} has unexpected fields`);
};

const readBounded = async (path, label) => {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  assert(metadata.size > 0 && metadata.size <= maximumFileBytes, `${label} must be non-empty and bounded`);
  return readFile(path, "utf8");
};

const collectFiles = async (root, current = root) => {
  const output = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    assert(!entry.isSymbolicLink(), `sample catalog contains a symbolic link: ${relative(root, path)}`);
    assert(
      entry.isDirectory() || entry.isFile(),
      `sample catalog contains a non-portable entry: ${relative(root, path)}`,
    );
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(root, path)));
    } else {
      output.push(relative(root, path).split(sep).join("/"));
    }
  }
  return output.sort();
};

const validateSample = async (samplesRoot, fixtureId, expected) => {
  const root = join(samplesRoot, fixtureId);
  const actualFiles = await collectFiles(root);
  assert(
    JSON.stringify(actualFiles) === JSON.stringify([...expected.files].sort()),
    `${fixtureId} has an unexpected file set: ${actualFiles.join(", ")}`,
  );

  const fixtureText = await readBounded(join(root, "loomrail-fixture.json"), `${fixtureId} fixture manifest`);
  const fixture = JSON.parse(fixtureText);
  exactKeys(fixture, ["fixtureId", "name", "projectId", "schemaVersion"], `${fixtureId} fixture manifest`);
  assert(fixture.schemaVersion === 1, `${fixtureId} fixture schema version is unsupported`);
  assert(fixture.fixtureId === fixtureId, `${fixtureId} fixture identity does not match its directory`);
  assert(
    fixture.projectId === expected.projectId,
    `${fixtureId} project identity is not the allowlisted value`,
  );
  assert(typeof fixture.name === "string" && fixture.name.length > 0, `${fixtureId} fixture name is missing`);

  const manifestText = await readBounded(join(root, "package.json"), `${fixtureId} package manifest`);
  const manifest = JSON.parse(manifestText);
  exactKeys(manifest, ["name", "private", "scripts", "type", "version"], `${fixtureId} package manifest`);
  assert(manifest.name === expected.packageName, `${fixtureId} package name is not the allowlisted value`);
  assert(manifest.version === "1.0.0", `${fixtureId} package version must be 1.0.0`);
  assert(manifest.private === true && manifest.type === "module", `${fixtureId} package must be private ESM`);
  exactKeys(manifest.scripts, Object.keys(expected.scripts), `${fixtureId} scripts`);
  for (const [name, command] of Object.entries(expected.scripts)) {
    assert(manifest.scripts[name] === command, `${fixtureId} script ${name} changed`);
  }

  const recipes = await readBounded(join(root, "SAMPLE-WORKFLOWS.md"), `${fixtureId} workflow recipes`);
  assert(
    (recipes.match(/^## Recipe [12] — /gm) ?? []).length === 2,
    `${fixtureId} must carry exactly two recipes`,
  );
  assert(
    (recipes.match(/^\*\*Acceptance criteria\*\*$/gm) ?? []).length === 2,
    `${fixtureId} recipes need acceptance criteria`,
  );
  assert(
    !recipes.includes("/Users/") && !recipes.includes("C:\\Users\\"),
    `${fixtureId} recipes contain an absolute personal path`,
  );

  for (const file of actualFiles) await readBounded(join(root, ...file.split("/")), `${fixtureId}/${file}`);
  return root;
};

export const verifySamples = async (samplesRoot = resolve(repositoryRoot, "fixtures/projects")) => {
  const directoryEntries = await readdir(samplesRoot, { withFileTypes: true });
  assert(
    directoryEntries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()),
    "sample root must contain only regular directories",
  );
  const fixtureIds = directoryEntries.map(({ name }) => name).sort();
  const expectedIds = Object.keys(catalog).sort();
  assert(
    JSON.stringify(fixtureIds) === JSON.stringify(expectedIds),
    `sample catalog must contain exactly ${expectedIds.join(", ")}`,
  );

  const validated = [];
  for (const fixtureId of expectedIds) {
    validated.push(await validateSample(samplesRoot, fixtureId, catalog[fixtureId]));
  }
  for (const sampleRoot of validated) {
    const result = spawnSync(process.execPath, ["--test"], {
      cwd: sampleRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 4_000);
      throw new Error(`sample baseline failed in ${sampleRoot}:\n${detail}`);
    }
  }
  return { samples: expectedIds.length, tests: validated.length };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const samplesRoot = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  const result = await verifySamples(samplesRoot);
  process.stdout.write(
    `Sample gate passed: ${result.samples.toString()} repositories are closed, dependency-free and tested.\n`,
  );
}
