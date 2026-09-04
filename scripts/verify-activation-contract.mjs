import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = "packages/contracts/src/guided-activation.v1.json";
const documentationPaths = [
  "README.md",
  "docs/guides/GETTING-STARTED.md",
  "docs/guides/GETTING-STARTED.ru.md",
];
const installCommands = [
  "mkdir loomrail-evaluation",
  "cd loomrail-evaluation",
  "npm install --ignore-scripts loomrail@next",
  "npx playwright install chromium",
  "npx loomrail try",
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exactKeys = (value, expected, location) => {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${location} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${location} has unknown or missing fields`);
};

export const validateActivationContract = (contract) => {
  exactKeys(
    contract,
    ["schemaVersion", "id", "fixtureId", "createCommandId", "task", "policy", "install"],
    "contract",
  );
  exactKeys(
    contract.task,
    ["title", "description", "priority", "risk", "type", "acceptanceCriteria"],
    "contract.task",
  );
  exactKeys(
    contract.policy,
    ["maxEstimatedTokens", "agentRunMaxEstimatedTokensOverride", "modelTierOverride"],
    "contract.policy",
  );
  exactKeys(contract.install, ["commands"], "contract.install");

  assert(contract.schemaVersion === 1, "contract.schemaVersion must be 1");
  assert(contract.id === "guided-mock-v1", "contract.id must name the reviewed Mock mission");
  assert(contract.fixtureId === "web-app-a", "contract.fixtureId must use the reviewed Q10 web fixture");
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(contract.createCommandId), "createCommandId is invalid");
  assert(
    typeof contract.task.title === "string" &&
      contract.task.title.length > 0 &&
      contract.task.title.length <= 200,
    "task.title is invalid",
  );
  assert(
    typeof contract.task.description === "string" &&
      contract.task.description.length > 0 &&
      contract.task.description.length <= 20_000,
    "task.description is invalid",
  );
  assert(contract.task.type === "TASK", "the guided recipe must create a Task");
  assert(["LOW", "MEDIUM", "HIGH", "URGENT"].includes(contract.task.priority), "task.priority is invalid");
  assert(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(contract.task.risk), "task.risk is invalid");
  assert(
    Array.isArray(contract.task.acceptanceCriteria) &&
      contract.task.acceptanceCriteria.length > 0 &&
      contract.task.acceptanceCriteria.length <= 50,
    "acceptanceCriteria is invalid",
  );
  assert(
    new Set(contract.task.acceptanceCriteria).size === contract.task.acceptanceCriteria.length,
    "acceptanceCriteria must be unique",
  );
  assert(
    contract.task.acceptanceCriteria.every(
      (criterion) => typeof criterion === "string" && criterion.length > 0 && criterion.length <= 500,
    ),
    "an acceptance criterion is invalid",
  );
  assert(
    Number.isInteger(contract.policy.maxEstimatedTokens) &&
      contract.policy.maxEstimatedTokens >= 100 &&
      contract.policy.maxEstimatedTokens <= 10_000_000,
    "maxEstimatedTokens is outside the reviewed bound",
  );
  assert(
    Number.isInteger(contract.policy.agentRunMaxEstimatedTokensOverride) &&
      contract.policy.agentRunMaxEstimatedTokensOverride >= 100 &&
      contract.policy.agentRunMaxEstimatedTokensOverride <= contract.policy.maxEstimatedTokens,
    "the per-agent ceiling is invalid",
  );
  assert(
    ["FAST", "STANDARD", "DEEP"].includes(contract.policy.modelTierOverride),
    "modelTierOverride is invalid",
  );

  assert(
    JSON.stringify(contract.install.commands) === JSON.stringify(installCommands),
    "install.commands must exactly match the reviewed safe activation sequence",
  );
  return contract;
};

const markedInstallBlock = (commands) =>
  [
    "<!-- loomrail-guided-activation-v1:start -->",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "<!-- loomrail-guided-activation-v1:end -->",
  ].join("\n");

const occurrences = (text, needle) => text.split(needle).length - 1;

export const verifyActivationContract = async (root = repositoryRoot) => {
  const contract = validateActivationContract(
    JSON.parse(await readFile(resolve(root, contractPath), "utf8")),
  );
  const expectedBlock = markedInstallBlock(contract.install.commands);

  for (const path of documentationPaths) {
    const contents = await readFile(resolve(root, path), "utf8");
    assert(
      occurrences(contents, expectedBlock) === 1,
      `${path} must contain exactly one canonical guided install block`,
    );
  }

  const cliHelpSource = await readFile(resolve(root, "apps/cli/src/doctor.ts"), "utf8");
  assert(
    cliHelpSource.includes('import { guidedActivationContract } from "@loomrail/contracts";') &&
      cliHelpSource.includes("...guidedActivationContract.install.commands.map"),
    "CLI help must consume the validated guided activation contract directly",
  );

  const sample = (
    await readFile(resolve(root, "fixtures/projects/web-app-a/SAMPLE-WORKFLOWS.md"), "utf8")
  ).replace(/\s+/g, " ");
  assert(sample.includes(contract.task.title), "Q10 sample title drifted from the guided contract");
  assert(sample.includes(contract.task.description), "Q10 sample brief drifted from the guided contract");
  for (const criterion of contract.task.acceptanceCriteria) {
    assert(sample.includes(criterion), `Q10 sample criterion drifted: ${criterion}`);
  }

  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const verifyJobStart = workflow.indexOf("  verify:\n");
  const browserJobStart = workflow.indexOf("\n  browser:", verifyJobStart);
  assert(verifyJobStart >= 0 && browserJobStart > verifyJobStart, "CI must contain a bounded verify job");
  const verifyJob = workflow.slice(verifyJobStart, browserJobStart);
  assert(
    verifyJob.includes("os: [macos-latest, windows-latest]"),
    "the activation gate must run in the macOS/Windows verify matrix",
  );
  const activationGate = verifyJob.indexOf("run: pnpm test:activation");
  const repositoryGate = verifyJob.indexOf("run: pnpm verify");
  assert(
    activationGate >= 0 && repositoryGate > activationGate,
    "the named activation gate must run before repository-wide verification",
  );
  return { contract, documentationPaths };
};

const directInvocation =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directInvocation) {
  const result = await verifyActivationContract();
  process.stdout.write(
    `Guided activation contract verified across CLI help, ${result.documentationPaths.length.toString()} documentation surfaces and the Q10 recipe.\n`,
  );
}
