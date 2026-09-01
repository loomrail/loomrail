import { createHash } from "node:crypto";

import type { ScaffoldRecipeId } from "./types.js";

export type RenderedScaffoldFile = {
  content: string;
  path: string;
};

export type ScaffoldRecipe = {
  id: ScaffoldRecipeId;
  render: (input: { packageName: string; projectName: string }) => readonly RenderedScaffoldFile[];
  version: number;
};

const MAX_FILES = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const WINDOWS_RESERVED_NAME = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

const readLifecycleScripts = (content: string): readonly string[] => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("A recipe package.json must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A recipe package.json must be an object");
  }
  const scripts = (value as Record<string, unknown>)["scripts"];
  if (scripts === undefined) return [];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("A recipe package.json scripts field must be an object");
  }
  return Object.keys(scripts as Record<string, unknown>).filter((name) =>
    /^(?:pre|post)(?:install|pack|publish|prepare)$/u.test(name),
  );
};

const validateRecipePath = (path: string): void => {
  if (path.length === 0 || path.length > 240 || path.includes("\\") || path.includes("\0")) {
    throw new Error("A recipe file path must be a bounded slash-separated relative path");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !PORTABLE_SEGMENT.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment) ||
        segment.endsWith("."),
    )
  ) {
    throw new Error("A recipe file path is not portable");
  }
};

/** Validates every immutable built-in recipe before it can be proposed or published. */
export const validateScaffoldRecipe = (
  recipe: ScaffoldRecipe,
  files: readonly RenderedScaffoldFile[],
): readonly RenderedScaffoldFile[] => {
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1) {
    throw new Error("A scaffold recipe version must be a positive integer");
  }
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error("A scaffold recipe must contain a bounded number of files");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    validateRecipePath(file.path);
    if (file.path === ".loomrail/scaffold.json" || seen.has(file.path)) {
      throw new Error("A scaffold recipe cannot duplicate or replace a reserved file");
    }
    seen.add(file.path);
    if (file.content.includes("\r")) {
      throw new Error("A scaffold recipe must use LF line endings");
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes === 0 || bytes > MAX_FILE_BYTES) {
      throw new Error("A scaffold recipe file must have bounded non-empty UTF-8 content");
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("A scaffold recipe exceeds the total content limit");
  }

  const packageFile = files.find((file) => file.path === "package.json");
  if (packageFile === undefined) throw new Error("A scaffold recipe must contain package.json");
  const lifecycleScripts = readLifecycleScripts(packageFile.content);
  if (lifecycleScripts.length > 0) {
    throw new Error("A scaffold recipe cannot contain package lifecycle scripts");
  }

  return Object.freeze(
    [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => Object.freeze({ ...file })),
  );
};

const renderTypescriptNode = ({
  packageName,
  projectName,
}: {
  packageName: string;
  projectName: string;
}): readonly RenderedScaffoldFile[] => [
  {
    path: ".gitignore",
    content: "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.DS_Store\n",
  },
  {
    path: "README.md",
    content: `# ${projectName}\n\nA small TypeScript and Node.js project created from Loomrail's built-in baseline.\n\n## Start\n\n\`\`\`sh\npnpm install\npnpm test\n\`\`\`\n\nLoomrail intentionally did not install dependencies, create a commit, add a remote, or push this repository.\n`,
  },
  {
    path: "package.json",
    content: `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "node --test test/*.test.ts",
          typecheck: "tsc -p tsconfig.json --noEmit",
        },
        devDependencies: {
          "@types/node": "^24.0.0",
          typescript: "^6.0.0",
        },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: "src/index.ts",
    content:
      'export const greeting = (name: string): string => `Hello, ${name}!`;\n\nif (import.meta.main) {\n  process.stdout.write(`${greeting("world")}\\n`);\n}\n',
  },
  {
    path: "test/index.test.ts",
    content:
      'import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport { greeting } from "../src/index.ts";\n\ntest("greets by name", () => {\n  assert.equal(greeting("Loomrail"), "Hello, Loomrail!");\n});\n',
  },
  {
    path: "tsconfig.json",
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          lib: ["ES2024"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowImportingTsExtensions: true,
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "test/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  },
];

const recipes: Readonly<Record<ScaffoldRecipeId, ScaffoldRecipe>> = Object.freeze({
  "typescript-node": Object.freeze({
    id: "typescript-node",
    version: 1,
    render: renderTypescriptNode,
  }),
});

export const renderScaffoldRecipe = (
  recipeId: ScaffoldRecipeId,
  input: { packageName: string; projectName: string },
): { files: readonly RenderedScaffoldFile[]; version: number } => {
  const recipe = recipes[recipeId];
  return {
    files: validateScaffoldRecipe(recipe, recipe.render(input)),
    version: recipe.version,
  };
};

export const digestContent = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");
