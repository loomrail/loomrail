import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseReceipt,
  verifyInstalledReleaseFiles,
  verifyReleaseReceipt,
  verifyReleaseStagingFiles,
} from "./release-integrity.mjs";
import { releaseDependencies } from "./release-manifest.mjs";

const identity = { name: "loomrail", version: "0.1.0-alpha.5" };
const source = {
  repository: "https://github.com/loomrail/loomrail",
  commit: "0123456789abcdef0123456789abcdef01234567",
  tree: "CLEAN",
};
const toolchain = { node: "v24.19.0", npm: "10.9.3", pnpm: "11.21.0" };

const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "loomrail-integrity-"));
  const packageDirectory = join(root, "package");
  await mkdir(join(packageDirectory, "apps", "cli", "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), '{"name":"loomrail"}\n', "utf8");
  await writeFile(join(packageDirectory, "apps", "cli", "dist", "index.js"), "export {};\n", "utf8");
  const tarballPath = join(root, `${identity.name}-${identity.version}.tgz`);
  const tarballBytes = Buffer.from("synthetic tarball bytes", "utf8");
  await writeFile(tarballPath, tarballBytes);
  const packageJsonBytes = await readFile(join(packageDirectory, "package.json"));
  const entrypointBytes = await readFile(join(packageDirectory, "apps", "cli", "dist", "index.js"));
  const files = [
    { path: "apps/cli/dist/index.js", size: entrypointBytes.byteLength, mode: 420 },
    { path: "package.json", size: packageJsonBytes.byteLength, mode: 420 },
  ];
  const packOutput = JSON.stringify([
    {
      id: `${identity.name}@${identity.version}`,
      ...identity,
      size: tarballBytes.byteLength,
      unpackedSize: files.reduce((total, file) => total + file.size, 0),
      shasum: hash("sha1", tarballBytes, "hex"),
      integrity: `sha512-${hash("sha512", tarballBytes, "base64")}`,
      filename: `${identity.name}-${identity.version}.tgz`,
      files,
      entryCount: files.length,
      bundled: [],
    },
  ]);
  const receipt = await createReleaseReceipt({
    packageDirectory,
    tarballPath,
    packOutput,
    ...identity,
    source,
    toolchain,
  });
  const receiptPath = join(root, `${identity.name}-${identity.version}.receipt.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { root, packageDirectory, tarballPath, receiptPath, receipt, packOutput };
};

test("creates and verifies a closed receipt and installed file manifest", async () => {
  const fixture = await createFixture();
  try {
    const receipt = await verifyReleaseReceipt({
      receiptPath: fixture.receiptPath,
      tarballPath: fixture.tarballPath,
      ...identity,
      requireCleanSource: true,
    });
    assert.equal(receipt.schemaVersion, "loomrail.release-integrity.v1");
    assert.equal(receipt.contents.entryCount, 2);
    await verifyInstalledReleaseFiles({ installedRoot: fixture.packageDirectory, receipt });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("publishes only registry semver runtime dependencies", () => {
  const dependencies = releaseDependencies();
  assert.ok(Object.keys(dependencies).length > 0);
  for (const range of Object.values(dependencies)) {
    assert.match(range, /^\^?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }
});

test("rejects unknown receipt fields and dirty CI source observations", async () => {
  const fixture = await createFixture();
  try {
    const unknown = { ...fixture.receipt, unexpected: true };
    await writeFile(fixture.receiptPath, JSON.stringify(unknown), "utf8");
    await assert.rejects(
      verifyReleaseReceipt({
        receiptPath: fixture.receiptPath,
        tarballPath: fixture.tarballPath,
        ...identity,
      }),
      /receipt has unexpected fields/,
    );

    const dirty = { ...fixture.receipt, source: { ...fixture.receipt.source, tree: "DIRTY" } };
    await writeFile(fixture.receiptPath, JSON.stringify(dirty), "utf8");
    await assert.rejects(
      verifyReleaseReceipt({
        receiptPath: fixture.receiptPath,
        tarballPath: fixture.tarballPath,
        ...identity,
        requireCleanSource: true,
      }),
      /built from a dirty source tree/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a traversal path reported by npm pack", async () => {
  const fixture = await createFixture();
  try {
    const metadata = JSON.parse(fixture.packOutput);
    metadata[0].files[0].path = "../owner-secret";
    await assert.rejects(
      createReleaseReceipt({
        packageDirectory: fixture.packageDirectory,
        tarballPath: fixture.tarballPath,
        packOutput: JSON.stringify(metadata),
        ...identity,
        source,
        toolchain,
      }),
      /not a portable relative path/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects staged paths outside the release allowlist before packing", async () => {
  const fixture = await createFixture();
  try {
    const unexpectedDirectory = join(fixture.packageDirectory, "owner-private");
    await mkdir(unexpectedDirectory);
    await assert.rejects(
      verifyReleaseStagingFiles({ packageDirectory: fixture.packageDirectory }),
      /directory is outside the release allowlist/,
    );
    await rm(unexpectedDirectory, { recursive: true });

    await writeFile(join(fixture.packageDirectory, "owner-secret.txt"), "must not be packed\n", "utf8");
    await assert.rejects(
      verifyReleaseStagingFiles({ packageDirectory: fixture.packageDirectory }),
      /outside the release allowlist/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects tarball bytes changed after the receipt was written", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.tarballPath, "tampered tarball", "utf8");
    await assert.rejects(
      verifyReleaseReceipt({
        receiptPath: fixture.receiptPath,
        tarballPath: fixture.tarballPath,
        ...identity,
      }),
      /tarball bytes do not match receipt/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects installed package bytes changed after extraction", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.packageDirectory, "apps", "cli", "dist", "index.js"), "tampered\n", "utf8");
    await assert.rejects(
      verifyInstalledReleaseFiles({
        installedRoot: fixture.packageDirectory,
        receipt: fixture.receipt,
      }),
      /installed package file does not match receipt/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
