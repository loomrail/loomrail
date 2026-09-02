import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumFileBytes = 96 * 1024;
const privateSecurityUrl = "https://github.com/loomrail/loomrail/security/advisories/new";
const issueChooserUrl = "https://github.com/loomrail/loomrail/issues/new/choose";

const formContracts = {
  "bug.yml": {
    title: "[Bug]: ",
    ids: [
      "public_data",
      "duplicate_search",
      "version",
      "operating_system",
      "install_route",
      "provider_route",
      "current_behavior",
      "reproduction",
      "expected_behavior",
      "additional_context",
      "conduct",
    ],
    required: [
      "public_data",
      "duplicate_search",
      "version",
      "operating_system",
      "install_route",
      "provider_route",
      "current_behavior",
      "reproduction",
      "expected_behavior",
      "conduct",
    ],
  },
  "feature.yml": {
    title: "[Proposal]: ",
    ids: [
      "public_data",
      "existing_scope",
      "problem",
      "outcome",
      "proposal",
      "acceptance",
      "security_privacy",
      "alternatives",
      "conduct",
    ],
    required: [
      "public_data",
      "existing_scope",
      "problem",
      "outcome",
      "proposal",
      "acceptance",
      "security_privacy",
      "conduct",
    ],
  },
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sameValues = (actual, expected) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

const readBoundedRegularFile = async (path, label) => {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  assert(metadata.size > 0 && metadata.size <= maximumFileBytes, `${label} must be non-empty and bounded`);
  return readFile(path, "utf8");
};

const parseFormBlocks = (text, fileName) => {
  const segments = text.split("\n  - type: ");
  assert(segments.length > 1, `${fileName} must define body elements`);
  const blocks = segments.slice(1).map((segment) => {
    const lineBreak = segment.indexOf("\n");
    assert(lineBreak > 0, `${fileName} has an incomplete body element`);
    const type = segment.slice(0, lineBreak);
    const body = segment.slice(lineBreak + 1);
    assert(
      ["checkboxes", "dropdown", "input", "markdown", "textarea"].includes(type),
      `${fileName} uses unsupported element type ${type}`,
    );
    const id = /^ {4}id: ([a-z0-9_-]+)$/m.exec(body)?.[1];
    if (type === "markdown") {
      assert(id === undefined, `${fileName} markdown must not have an id`);
      return { type, body };
    }
    assert(id !== undefined, `${fileName} ${type} element is missing an id`);
    assert(/^ {4}attributes:$/m.test(body), `${fileName} field ${id} is missing attributes`);
    assert(/^ {6}label: .+$/m.test(body), `${fileName} field ${id} is missing a label`);
    return { type, id, body };
  });
  assert(
    blocks.filter(({ type }) => type === "markdown").length === 1,
    `${fileName} needs one safety preface`,
  );
  return blocks;
};

const verifyIssueForm = (text, fileName, contract) => {
  const topLevelKeys = [...text.matchAll(/^([a-z][a-z_]*)[ ]*:/gm)].map((match) => match[1]);
  assert(
    sameValues(topLevelKeys, ["body", "description", "name", "title"]),
    `${fileName} has unexpected or missing top-level fields`,
  );
  const name = /^name: (.+)$/m.exec(text)?.[1] ?? "";
  assert(name.replaceAll('"', "").length > 3, `${fileName} name is too short`);
  assert(/^description: .+$/m.test(text), `${fileName} description is missing`);
  assert(text.includes(`title: "${contract.title}"`), `${fileName} title prefix changed`);
  assert(/^body:$/m.test(text), `${fileName} body is missing`);
  assert(text.includes(privateSecurityUrl), `${fileName} is missing the private security route`);
  assert(text.includes("Do not include"), `${fileName} is missing the public-data warning`);
  assert(text.includes("CODE_OF_CONDUCT.md"), `${fileName} is missing the Code of Conduct link`);
  assert(!text.includes("type: upload"), `${fileName} must not request public artifact uploads`);

  const blocks = parseFormBlocks(text, fileName);
  const fields = blocks.filter(({ id }) => id !== undefined);
  const ids = fields.map(({ id }) => id);
  assert(new Set(ids).size === ids.length, `${fileName} field IDs must be unique`);
  assert(sameValues(ids, contract.ids), `${fileName} field contract changed`);

  const requiredIds = fields.filter(({ body }) => /^\s+required: true$/m.test(body)).map(({ id }) => id);
  assert(sameValues(requiredIds, contract.required), `${fileName} required-field contract changed`);
};

const verifyTemplateConfig = (text) => {
  assert(/^blank_issues_enabled: false$/m.test(text), "public blank issues must remain disabled");
  assert(!/^blank_issues_enabled: true$/m.test(text), "public blank issues must not be enabled");
  assert(
    (text.match(/^ {2}- name: /gm) ?? []).length === 2,
    "template chooser must have exactly two contact links",
  );
  assert(text.includes(privateSecurityUrl), "template chooser is missing the private security route");
  assert(
    text.includes("https://github.com/loomrail/loomrail/blob/main/ROADMAP.md"),
    "template chooser is missing the public roadmap",
  );
};

const verifyRoadmap = (text) => {
  for (const heading of [
    "## Now — prove the first stable local delivery loop",
    "## Next — connect the proven loop to normal repository delivery",
    "## Later — broaden collaboration after local trust is earned",
    "## Not planned before stable",
    "## How priorities change",
  ]) {
    assert(text.includes(heading), `ROADMAP.md is missing ${heading}`);
  }
  assert(text.includes("not a schedule"), "ROADMAP.md must disclaim calendar authority");
  assert(text.includes(issueChooserUrl), "ROADMAP.md is missing the structured issue chooser");
  assert(text.includes("private reporting route"), "ROADMAP.md is missing the private security route");
  assert(
    !/\b(?:20\d{2}[-/]\d{1,2}|Q[1-4][ ]+20\d{2})\b/i.test(text),
    "ROADMAP.md must not contain a calendar commitment",
  );
};

const verifyLinkedPublicFiles = async (root) => {
  const contracts = [
    ["README.md", ["ROADMAP.md", issueChooserUrl, "SECURITY.md"]],
    ["CONTRIBUTING.md", ["ROADMAP.md", issueChooserUrl, "SECURITY.md"]],
    ["SECURITY.md", [privateSecurityUrl, issueChooserUrl]],
    [join("docs", "README.md"), ["../ROADMAP.md", issueChooserUrl]],
  ];
  for (const [relativePath, requiredText] of contracts) {
    const text = await readBoundedRegularFile(join(root, relativePath), relativePath);
    for (const value of requiredText) assert(text.includes(value), `${relativePath} is missing ${value}`);
  }
};

export const verifyCommunityFiles = async (root = repositoryRoot) => {
  const templateRoot = join(root, ".github", "ISSUE_TEMPLATE");
  const entries = await readdir(templateRoot, { withFileTypes: true });
  assert(
    entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "issue template directory must contain regular files only",
  );
  const fileNames = entries.map(({ name }) => name);
  const expectedFiles = [...Object.keys(formContracts), "config.yml"];
  assert(sameValues(fileNames, expectedFiles), "issue template file set changed");

  for (const [fileName, contract] of Object.entries(formContracts)) {
    const text = await readBoundedRegularFile(join(templateRoot, fileName), fileName);
    verifyIssueForm(text, fileName, contract);
  }
  verifyTemplateConfig(await readBoundedRegularFile(join(templateRoot, "config.yml"), "config.yml"));
  verifyRoadmap(await readBoundedRegularFile(join(root, "ROADMAP.md"), "ROADMAP.md"));
  await verifyLinkedPublicFiles(root);
  return { forms: Object.keys(formContracts).length, contactLinks: 2 };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  const result = await verifyCommunityFiles(root);
  process.stdout.write(
    `Community gate passed: ${result.forms.toString()} closed forms and ${result.contactLinks.toString()} safe routes.\n`,
  );
}
