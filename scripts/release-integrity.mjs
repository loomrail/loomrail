import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const receiptSchemaVersion = "loomrail.release-integrity.v1";
const sourceRepository = "https://github.com/loomrail/loomrail";
const maxReceiptBytes = 1024 * 1024;
const maxTarballBytes = 64 * 1024 * 1024;
const maxUnpackedBytes = 256 * 1024 * 1024;
const maxEntryCount = 4096;
const maxPortablePathLength = 240;

const allowedExactFiles = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "fixtures/projects/api-service-b/README.md",
  "fixtures/projects/api-service-b/SAMPLE-WORKFLOWS.md",
  "fixtures/projects/api-service-b/loomrail-fixture.json",
  "fixtures/projects/api-service-b/package.json",
  "fixtures/projects/api-service-b/src/issues.mjs",
  "fixtures/projects/api-service-b/test/issues.test.mjs",
  "fixtures/projects/web-app-a/README.md",
  "fixtures/projects/web-app-a/SAMPLE-WORKFLOWS.md",
  "fixtures/projects/web-app-a/loomrail-fixture.json",
  "fixtures/projects/web-app-a/package.json",
  "fixtures/projects/web-app-a/src/server.mjs",
  "fixtures/projects/web-app-a/src/tasks.mjs",
  "fixtures/projects/web-app-a/test/server.test.mjs",
  "fixtures/projects/web-app-a/test/tasks.test.mjs",
]);
const allowedExactDirectories = new Set([
  "apps",
  "apps/cli",
  "apps/cli/dist",
  "apps/cli/migrations",
  "apps/web",
  "apps/web/dist",
  "fixtures",
  "fixtures/projects",
  "fixtures/projects/api-service-b",
  "fixtures/projects/api-service-b/src",
  "fixtures/projects/api-service-b/test",
  "fixtures/projects/web-app-a",
  "fixtures/projects/web-app-a/src",
  "fixtures/projects/web-app-a/test",
  "packages",
  "packages/plugin-sdk",
  "packages/plugin-sdk/dist",
]);
const allowedDirectoryPatterns = [
  /^apps\/cli\/dist\/[A-Za-z0-9._/-]+$/,
  /^apps\/web\/dist\/[A-Za-z0-9._/-]+$/,
  /^packages\/plugin-sdk\/dist\/[A-Za-z0-9._/-]+$/,
];
const allowedFilePatterns = [
  /^apps\/cli\/dist\/[A-Za-z0-9._/-]+\.js$/,
  /^apps\/cli\/migrations\/\d{4}_[a-z0-9_]+\.sql$/,
  /^apps\/web\/dist\/[A-Za-z0-9._/-]+\.(?:css|html|ico|jpeg|jpg|js|map|png|svg|webp|woff|woff2)$/,
  /^packages\/plugin-sdk\/dist\/[A-Za-z0-9._/-]+\.(?:d\.ts|js)(?:\.map)?$/,
];

const fail = (message) => {
  throw new Error(`release integrity: ${message}`);
};

const assertPlainObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
};

const assertExactKeys = (value, keys, label) => {
  const actual = Object.keys(assertPlainObject(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected fields`);
  }
};

const assertString = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
};

const assertInteger = (value, { label, min = 0, max = Number.MAX_SAFE_INTEGER }) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`);
  return value;
};

const assertPortableRelativePath = (value, label) => {
  const path = assertString(value, /^[\x20-\x7e]+$/, label);
  if (
    path.length > maxPortablePathLength ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label} is not a portable relative path`);
  }
  return path;
};

const assertSafePackageDirectoryPath = (value) => {
  const path = assertPortableRelativePath(value, "package directory path");
  if (!allowedExactDirectories.has(path) && !allowedDirectoryPatterns.some((pattern) => pattern.test(path))) {
    fail(`package directory is outside the release allowlist: ${path}`);
  }
  return path;
};

const assertSafePackagePath = (value) => {
  const path = assertPortableRelativePath(value, "package file path");
  if (!allowedExactFiles.has(path) && !allowedFilePatterns.some((pattern) => pattern.test(path))) {
    fail(`package file is outside the release allowlist: ${path}`);
  }
  return path;
};

const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

const sha1Hex = (bytes) => digest("sha1", bytes, "hex");
const sha256Hex = (bytes) => digest("sha256", bytes, "hex");
const sha512Integrity = (bytes) => `sha512-${digest("sha512", bytes, "base64")}`;

const readBoundedRegularFile = async (path, { label, maxBytes }) => {
  const file = await lstat(path);
  if (!file.isFile()) fail(`${label} is not a regular file`);
  if (file.size > maxBytes) fail(`${label} exceeds its byte limit`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== file.size) fail(`${label} changed while it was being read`);
  return bytes;
};

const compareFileLists = (expected, actual, label) => {
  if (expected.length !== actual.length) fail(`${label} file count does not match`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.size !== right.size || left.sha256 !== right.sha256) {
      fail(`${label} file does not match receipt: ${left.path}`);
    }
  }
};

const collectPackageFiles = async (root, { skipDependencies = false } = {}) => {
  const collected = [];
  let treeEntryCount = 0;
  let totalBytes = 0;

  const visit = async (relativeDirectory) => {
    const directory = relativeDirectory === "" ? root : join(root, ...relativeDirectory.split("/"));
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      treeEntryCount += 1;
      if (treeEntryCount > maxEntryCount) fail("package tree exceeds its entry limit");
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (skipDependencies && relativePath === "node_modules" && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        await visit(assertSafePackageDirectoryPath(relativePath));
        continue;
      }
      if (!entry.isFile()) fail(`package tree contains a non-regular entry: ${relativePath}`);
      const path = assertSafePackagePath(relativePath);
      const bytes = await readBoundedRegularFile(join(root, ...path.split("/")), {
        label: `package file ${path}`,
        maxBytes: maxUnpackedBytes,
      });
      totalBytes += bytes.byteLength;
      if (totalBytes > maxUnpackedBytes) fail("package tree exceeds its unpacked byte limit");
      collected.push({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) });
    }
  };

  await visit("");
  return collected.sort((left, right) => left.path.localeCompare(right.path));
};

export const verifyReleaseStagingFiles = async ({ packageDirectory }) => {
  await collectPackageFiles(packageDirectory);
};

const parsePackOutput = (output, expectedName, expectedVersion) => {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("npm pack did not return JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("npm pack must return exactly one package");
  const metadata = parsed[0];
  assertExactKeys(
    metadata,
    [
      "id",
      "name",
      "version",
      "size",
      "unpackedSize",
      "shasum",
      "integrity",
      "filename",
      "files",
      "entryCount",
      "bundled",
    ],
    "npm pack metadata",
  );
  if (metadata.id !== `${expectedName}@${expectedVersion}`) fail("npm pack package id does not match");
  if (metadata.name !== expectedName || metadata.version !== expectedVersion) {
    fail("npm pack package identity does not match");
  }
  if (metadata.filename !== `${expectedName}-${expectedVersion}.tgz`) {
    fail("npm pack filename does not match package identity");
  }
  assertInteger(metadata.size, { label: "npm pack size", min: 1, max: maxTarballBytes });
  assertInteger(metadata.unpackedSize, {
    label: "npm pack unpacked size",
    min: 1,
    max: maxUnpackedBytes,
  });
  assertString(metadata.shasum, /^[a-f0-9]{40}$/, "npm pack shasum");
  assertString(metadata.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, "npm pack integrity");
  if (!Array.isArray(metadata.files)) fail("npm pack files must be an array");
  assertInteger(metadata.entryCount, { label: "npm pack entry count", min: 1, max: maxEntryCount });
  if (metadata.entryCount !== metadata.files.length) fail("npm pack entry count does not match files");
  if (!Array.isArray(metadata.bundled) || metadata.bundled.length !== 0) {
    fail("release package must not bundle a dependency tree");
  }

  const seen = new Set();
  const files = metadata.files.map((file, index) => {
    assertExactKeys(file, ["path", "size", "mode"], `npm pack file ${index}`);
    const path = assertSafePackagePath(file.path);
    if (seen.has(path)) fail(`npm pack contains a duplicate file: ${path}`);
    seen.add(path);
    const size = assertInteger(file.size, {
      label: `npm pack file size for ${path}`,
      max: maxUnpackedBytes,
    });
    assertInteger(file.mode, { label: `npm pack file mode for ${path}`, max: 0o777 });
    return { path, size };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.reduce((total, file) => total + file.size, 0) !== metadata.unpackedSize) {
    fail("npm pack unpacked size does not match file sizes");
  }
  return { ...metadata, files };
};

const validateReceipt = (receipt, expectedName, expectedVersion) => {
  assertExactKeys(
    receipt,
    ["schemaVersion", "package", "source", "toolchain", "artifact", "contents"],
    "receipt",
  );
  if (receipt.schemaVersion !== receiptSchemaVersion) fail("receipt schema version is unsupported");

  assertExactKeys(receipt.package, ["name", "version"], "receipt package");
  if (receipt.package.name !== expectedName || receipt.package.version !== expectedVersion) {
    fail("receipt package identity does not match");
  }

  assertExactKeys(receipt.source, ["repository", "commit", "tree"], "receipt source");
  if (receipt.source.repository !== sourceRepository) fail("receipt source repository does not match");
  assertString(receipt.source.commit, /^[a-f0-9]{40}$/, "receipt source commit");
  if (!new Set(["CLEAN", "DIRTY"]).has(receipt.source.tree)) {
    fail("receipt source tree observation is invalid");
  }

  assertExactKeys(receipt.toolchain, ["node", "npm", "pnpm"], "receipt toolchain");
  assertString(receipt.toolchain.node, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "receipt Node version");
  assertString(receipt.toolchain.npm, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "receipt npm version");
  assertString(receipt.toolchain.pnpm, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "receipt pnpm version");

  assertExactKeys(
    receipt.artifact,
    ["filename", "size", "shasum", "sha256", "integrity"],
    "receipt artifact",
  );
  if (receipt.artifact.filename !== `${expectedName}-${expectedVersion}.tgz`) {
    fail("receipt artifact filename does not match");
  }
  assertInteger(receipt.artifact.size, {
    label: "receipt artifact size",
    min: 1,
    max: maxTarballBytes,
  });
  assertString(receipt.artifact.shasum, /^[a-f0-9]{40}$/, "receipt artifact shasum");
  assertString(receipt.artifact.sha256, /^[a-f0-9]{64}$/, "receipt artifact sha256");
  assertString(receipt.artifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, "receipt artifact integrity");

  assertExactKeys(receipt.contents, ["unpackedSize", "entryCount", "files"], "receipt contents");
  assertInteger(receipt.contents.unpackedSize, {
    label: "receipt unpacked size",
    min: 1,
    max: maxUnpackedBytes,
  });
  assertInteger(receipt.contents.entryCount, {
    label: "receipt entry count",
    min: 1,
    max: maxEntryCount,
  });
  if (!Array.isArray(receipt.contents.files)) fail("receipt files must be an array");
  if (receipt.contents.entryCount !== receipt.contents.files.length) {
    fail("receipt entry count does not match files");
  }
  const seen = new Set();
  let previousPath = "";
  const files = receipt.contents.files.map((file, index) => {
    assertExactKeys(file, ["path", "size", "sha256"], `receipt file ${index}`);
    const path = assertSafePackagePath(file.path);
    if (seen.has(path)) fail(`receipt contains a duplicate file: ${path}`);
    if (previousPath !== "" && previousPath.localeCompare(path) >= 0) {
      fail("receipt files are not strictly sorted");
    }
    seen.add(path);
    previousPath = path;
    return {
      path,
      size: assertInteger(file.size, { label: `receipt file size for ${path}`, max: maxUnpackedBytes }),
      sha256: assertString(file.sha256, /^[a-f0-9]{64}$/, `receipt file sha256 for ${path}`),
    };
  });
  if (files.reduce((total, file) => total + file.size, 0) !== receipt.contents.unpackedSize) {
    fail("receipt unpacked size does not match file sizes");
  }
  return receipt;
};

export const createReleaseReceipt = async ({
  packageDirectory,
  tarballPath,
  packOutput,
  name,
  version,
  source,
  toolchain,
}) => {
  const metadata = parsePackOutput(packOutput, name, version);
  const stagedFiles = await collectPackageFiles(packageDirectory);
  const metadataFiles = metadata.files.map((file) => ({
    ...file,
    sha256: stagedFiles.find((staged) => staged.path === file.path)?.sha256 ?? "",
  }));
  compareFileLists(stagedFiles, metadataFiles, "staged package");

  const tarball = await readBoundedRegularFile(tarballPath, {
    label: "release artifact",
    maxBytes: maxTarballBytes,
  });
  if (tarball.byteLength !== metadata.size) fail("tarball size does not match npm pack metadata");
  if (sha1Hex(tarball) !== metadata.shasum) fail("tarball SHA-1 does not match npm pack metadata");
  if (sha512Integrity(tarball) !== metadata.integrity) {
    fail("tarball SHA-512 does not match npm pack metadata");
  }

  const receipt = {
    schemaVersion: receiptSchemaVersion,
    package: { name, version },
    source,
    toolchain,
    artifact: {
      filename: metadata.filename,
      size: metadata.size,
      shasum: metadata.shasum,
      sha256: sha256Hex(tarball),
      integrity: metadata.integrity,
    },
    contents: {
      unpackedSize: metadata.unpackedSize,
      entryCount: stagedFiles.length,
      files: stagedFiles,
    },
  };
  return validateReceipt(receipt, name, version);
};

export const verifyReleaseReceipt = async ({
  receiptPath,
  tarballPath,
  name,
  version,
  requireCleanSource = false,
}) => {
  const receiptBytes = await readBoundedRegularFile(receiptPath, {
    label: "receipt",
    maxBytes: maxReceiptBytes,
  });
  let parsed;
  try {
    parsed = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    fail("receipt is not valid JSON");
  }
  const receipt = validateReceipt(parsed, name, version);
  if (requireCleanSource && receipt.source.tree !== "CLEAN") {
    fail("CI release receipt was built from a dirty source tree");
  }
  if (basename(tarballPath) !== receipt.artifact.filename) {
    fail("tarball path does not match receipt filename");
  }
  const tarball = await readBoundedRegularFile(tarballPath, {
    label: "release artifact",
    maxBytes: maxTarballBytes,
  });
  if (
    tarball.byteLength !== receipt.artifact.size ||
    sha1Hex(tarball) !== receipt.artifact.shasum ||
    sha256Hex(tarball) !== receipt.artifact.sha256 ||
    sha512Integrity(tarball) !== receipt.artifact.integrity
  ) {
    fail("tarball bytes do not match receipt");
  }
  return receipt;
};

export const verifyInstalledReleaseFiles = async ({ installedRoot, receipt }) => {
  const receiptObject = assertPlainObject(receipt, "receipt");
  const packageIdentity = assertPlainObject(receiptObject.package, "receipt package");
  const name = assertString(packageIdentity.name, /^[a-z0-9][a-z0-9-]*$/, "receipt package name");
  const version = assertString(
    packageIdentity.version,
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    "receipt package version",
  );
  const validReceipt = validateReceipt(receipt, name, version);
  const installedFiles = await collectPackageFiles(installedRoot, { skipDependencies: true });
  compareFileLists(validReceipt.contents.files, installedFiles, "installed package");
};
