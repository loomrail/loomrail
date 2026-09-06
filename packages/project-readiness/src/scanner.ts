import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, normalize } from "node:path";

import {
  readinessCheckDraftSchema,
  type ReadinessCheckDraft,
  type SecurityFindingDraft,
} from "@loomrail/contracts";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CI_FILES = 32;
const MAX_CI_FILE_BYTES = 256 * 1024;
const MAX_CI_TOTAL_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

type BoundedGitResult = {
  exitCode: number;
  output: Buffer;
  overflowed: boolean;
};

export type ProjectReadinessAssessmentDraft = {
  repositoryHead: string | null;
  sourceDigest: string;
  workingTreeDirty: boolean;
  checks: readonly ReadinessCheckDraft[];
};

export type ProjectReadinessScanErrorCode = "REPOSITORY_UNAVAILABLE" | "GIT_UNAVAILABLE";

export class ProjectReadinessScanError extends Error {
  readonly code: ProjectReadinessScanErrorCode;

  constructor(code: ProjectReadinessScanErrorCode, message: string) {
    super(message);
    this.name = "ProjectReadinessScanError";
    this.code = code;
  }
}

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const runBoundedGit = (args: readonly string[], cwd: string): Promise<BoundedGitResult> =>
  new Promise((resolve, reject) => {
    const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    const child = spawn("git", ["-c", `core.hooksPath=${hooksPath}`, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    const timer = setTimeout(() => {
      overflowed = true;
      child.kill();
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= MAX_GIT_OUTPUT_BYTES) chunks.push(chunk);
      else {
        overflowed = true;
        child.kill();
      }
    });
    child.on("error", (_cause: unknown) => {
      clearTimeout(timer);
      reject(new ProjectReadinessScanError("GIT_UNAVAILABLE", "Git is unavailable for the readiness check"));
    });
    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, output: Buffer.concat(chunks), overflowed });
    });
  });

const outputText = (result: BoundedGitResult): string => result.output.toString("utf8").trim();

const splitNullPaths = (result: BoundedGitResult): readonly string[] =>
  result.output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"));

const isSecretLikePath = (path: string): boolean => {
  const name = basename(path).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(name) && !/(?:example|sample|template|dist)$/.test(name)) return true;
  return [
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "id_rsa",
    "id_dsa",
    "id_ed25519",
    "private.pem",
    "private.key",
  ].includes(name);
};

const ROOT_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
] as const;

export const lockfileFindings = (trackedPaths: readonly string[] | null): readonly SecurityFindingDraft[] => {
  if (trackedPaths === null) {
    return [
      finding(
        "DEPENDENCY_INPUT_UNVERIFIABLE",
        "HIGH",
        null,
        "Tracked paths exceeded the safe inspection bound, so lockfile coverage was not checked.",
      ),
    ];
  }
  const rootPaths = new Set(trackedPaths.filter((path) => !path.includes("/")));
  if (!rootPaths.has("package.json")) return [];
  const present = ROOT_LOCKFILES.filter((name) => rootPaths.has(name));
  if (present.length === 0) {
    return [
      finding(
        "LOCKFILE_MISSING",
        "HIGH",
        "package.json",
        "A tracked manifest has no tracked lockfile, so installed versions are not reproducible.",
      ),
    ];
  }
  if (present.length === 1) return [];
  return present.map((name) =>
    finding(
      "LOCKFILE_AMBIGUOUS",
      "MEDIUM",
      name,
      "More than one package manager lockfile is tracked, so the installed tree is ambiguous.",
    ),
  );
};

const finding = (
  code: SecurityFindingDraft["code"],
  severity: SecurityFindingDraft["severity"],
  path: string | null,
  message: string,
): SecurityFindingDraft => ({ code, severity, path, message });

const automatedCheck = (
  key: ReadinessCheckDraft["key"],
  category: ReadinessCheckDraft["category"],
  passedSummary: string,
  requiredSummary: string,
  findings: readonly SecurityFindingDraft[],
): ReadinessCheckDraft =>
  readinessCheckDraftSchema.parse({
    key,
    category,
    mode: "AUTOMATED",
    status: findings.length === 0 ? "PASSED" : "ACTION_REQUIRED",
    summary: findings.length === 0 ? passedSummary : requiredSummary,
    findings,
  });

const ownerCheck = (
  key: ReadinessCheckDraft["key"],
  category: ReadinessCheckDraft["category"],
  summary: string,
): ReadinessCheckDraft =>
  readinessCheckDraftSchema.parse({
    key,
    category,
    mode: "OWNER",
    status: "ACTION_REQUIRED",
    summary,
    findings: [],
  });

const ignoredByGit = async (repositoryPath: string, path: string): Promise<boolean | null> => {
  const result = await runBoundedGit(["check-ignore", "--no-index", "--quiet", "--", path], repositoryPath);
  if (result.overflowed) return null;
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
};

const pathExists = async (repositoryPath: string, path: string): Promise<boolean> => {
  try {
    await lstat(join(repositoryPath, path));
    return true;
  } catch {
    return false;
  }
};

const licensePresent = async (repositoryPath: string): Promise<boolean> => {
  const accepted = new Set(["license", "license.md", "license.txt", "copying", "copying.md", "copying.txt"]);
  try {
    for (const entry of await readdir(repositoryPath, { withFileTypes: true })) {
      if (!accepted.has(entry.name.toLowerCase()) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const metadata = await lstat(join(repositoryPath, entry.name));
      if (metadata.isFile() && !metadata.isSymbolicLink()) return true;
    }
  } catch {
    return false;
  }
  return false;
};

type CiWorkflowFile = { path: string; content: string };

const readBoundedCiWorkflows = async (
  repositoryPath: string,
): Promise<{ files: readonly CiWorkflowFile[]; unverifiable: readonly SecurityFindingDraft[] }> => {
  const directory = join(repositoryPath, ".github", "workflows");
  let entries: readonly import("node:fs").Dirent[];
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return {
        files: [],
        unverifiable: [
          finding(
            "CI_INPUT_UNVERIFIABLE",
            "HIGH",
            ".github/workflows",
            "The CI workflow directory is not a regular directory and was not inspected.",
          ),
        ],
      };
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { files: [], unverifiable: [] };
  }

  const candidates = entries
    .filter((entry) => /\.ya?ml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: CiWorkflowFile[] = [];
  const unverifiable: SecurityFindingDraft[] = [];
  if (candidates.length > MAX_CI_FILES) {
    unverifiable.push(
      finding(
        "CI_INPUT_UNVERIFIABLE",
        "HIGH",
        ".github/workflows",
        "The CI workflow file limit was exceeded, so the full workflow set was not inspected.",
      ),
    );
  }

  let totalBytes = 0;
  for (const entry of candidates.slice(0, MAX_CI_FILES)) {
    const relativePath = `.github/workflows/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    let metadata: import("node:fs").Stats;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      unverifiable.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be inspected."),
      );
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CI_FILE_BYTES) {
      unverifiable.push(
        finding(
          "CI_INPUT_UNVERIFIABLE",
          "HIGH",
          relativePath,
          "The CI workflow is not a bounded regular file and was not inspected.",
        ),
      );
      continue;
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_CI_TOTAL_BYTES) {
      unverifiable.push(
        finding(
          "CI_INPUT_UNVERIFIABLE",
          "HIGH",
          relativePath,
          "The CI workflow byte limit was exceeded, so remaining workflows were not inspected.",
        ),
      );
      break;
    }
    let content: string;
    try {
      content = (await readFile(absolutePath)).toString("utf8");
    } catch {
      unverifiable.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be read safely."),
      );
      continue;
    }
    files.push({ path: relativePath, content });
  }
  return { files, unverifiable };
};

const ciFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    if (/^\s*pull_request_target\s*:/m.test(file.content)) {
      findings.push(
        finding(
          "CI_PULL_REQUEST_TARGET",
          "HIGH",
          file.path,
          "The workflow uses pull_request_target and requires an explicit trust-boundary review.",
        ),
      );
    }
    if (/^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im.test(file.content)) {
      findings.push(
        finding("CI_WRITE_ALL_PERMISSIONS", "HIGH", file.path, "The workflow grants write-all permissions."),
      );
    }
    const actionPattern = /^\s*-?\s*uses\s*:\s*["']?([^\s"'#]+)@([^\s"'#]+)["']?/gim;
    for (const match of file.content.matchAll(actionPattern)) {
      const target = match[1];
      const reference = match[2];
      if (
        target?.startsWith("./") ||
        target?.startsWith("docker://") ||
        /^[0-9a-f]{40}$/i.test(reference ?? "")
      ) {
        continue;
      }
      findings.push(
        finding(
          "CI_ACTION_NOT_PINNED",
          "MEDIUM",
          file.path,
          `The action ${target ?? "unknown"} is not pinned to a full commit SHA.`,
        ),
      );
    }
  }
  return findings;
};

// The line reader below admits `-` inside a name (`[A-Za-z_][A-Za-z0-9_-]*`), because a hyphen is the
// ordinary separator in an action input. `aws-secret-access-key`, the documented input of
// `aws-actions/configure-aws-credentials`, matched no name at all under the underscore-only shape, so
// a literal parked there was invisible to every version of this check. A name still has to start with
// `[A-Za-z_]`, so the leading `-?` that eats a YAML list dash cannot be followed by a second one:
// `- --token=x`, `--token: x` and `-  -token: x` match nothing.
//
// This pattern's own inner separators accept either, so the two spellings of a multi-word name
// behave alike. `private-key` is the documented input of `actions/create-github-app-token`,
// `ssh-private-key` of `webfactory/ssh-agent` and `aws-access-key-id` of
// `aws-actions/configure-aws-credentials`; under the underscore-only shape a literal parked in any
// of them was reported in the `_` spelling and clean in the `-` one. `aws-secret-access-key` is
// still caught by the `SECRET` alternative, not by `ACCESS[_-]KEY`.
//
// What the widening admits is exactly a name containing `api-key`, `access-key` or `private-key`,
// and nothing else. On this repository it admits no name at all: 0 of the 37 distinct names its
// workflows assign a value to, and 0 of the 385 across every `.yml`/`.yaml` file in the checkout
// outside `node_modules`. 207 of those 385 are hyphenated, 190 of them package names in
// `pnpm-lock.yaml`, the largest hyphenated-name corpus available here. `cache-key`, `path-key`,
// `deploy-key`, `signing-key` and `public-key` stay out, because the qualifying word is still
// required. So do `apiKey`, `accessKey` and `privateKey`: a camel-case name carries no separator
// for `[_-]` to match, and that gap is unchanged and not addressed here.
//
// The cost is the modifier forms, which name a setting about a credential rather than the
// credential -- `api-key-header: X-Custom-Api-Key`, `api-key-location: querystring` and
// `private-key-algorithm: rsa-sha256` are all reported. That is not a new class: the underscore
// spellings `API_KEY_HEADER`, `API_KEY_LOCATION` and `PRIVATE_KEY_ALGORITHM` are reported by the
// pattern as it stood, so widening the separators makes the two spellings agree rather than
// accepting a cost this file had not already accepted. The modifier forms that cost nothing are
// held by rules already in the chain: `api-key-required: false` and `private-key-format: PKCS8` by
// MIN_LITERAL_SECRET_LENGTH, `api-key-name: my-app-prod-key` by REFERENCE_NAME_PATTERN, and
// `private-key-path: ~/.ssh/id_rsa`, `private-key-file: /run/secrets/app.pem` and
// `api-keys-url: https://vault.example.com/keys` by LOCATION_VALUE_PATTERN.
//
// Admitting the hyphen brings GitHub's own hyphenated keys to this test: every workflow key and
// action input whose name carries `token` or `credentials`. MIN_LITERAL_SECRET_LENGTH is the whole
// protection for that class, deliberately, and the argument for it is about the class and not about
// any file: these keys are switches and scopes rather than data, so the values they take are a short
// fixed vocabulary (`read`, `write`, `none`, `true`, `false`) that no bound of eight can reach, while
// a name allowlist would have to be maintained against every action that ever names an input
// `*-token` or `*-credentials` and would be wrong again with the next one. Where the bound sits is
// exact and it is the class's cost -- `id-token: write` and `persist-credentials: false` are clean,
// `id-token: write-all` is nine characters and is reported. This repository's YAML is one sample of
// that class and it agrees: three such names across every `.yml`/`.yaml` file outside `node_modules`
// -- `id-token` (a `permissions` scope), `persist-credentials` (an `actions/checkout` input) and
// `js-tokens` (a lockfile package, which never reaches this function because only
// `.github/workflows/*.yml` and `*.yaml` are read), valued `write`, `false` and `4.0.0`. That is
// evidence the bound holds here, not an argument that it holds in a user's project.
const SECRET_NAME_PATTERN = /TOKEN|SECRET|PASSWORD|API[_-]KEY|ACCESS[_-]KEY|PRIVATE[_-]KEY|CREDENTIALS/i;
// A name that says what a credential is called, or lists where the workflow will find one, rather
// than holding the credential itself. Both separators are accepted so the two spellings behave
// alike: `SECRET_NAME: my-app-prod-secret` and `secret-name: my-app-prod-secret` are both clean, and
// nothing else in the chain excuses either.
//
// Admitting the hyphen brought a documented class of such names into view for the first time. They
// are action inputs that name a store entry or list a mapping, and none can carry a secret value:
// `secret-ids: prod/db/credentials` and `secret-id: mysecret` are inputs of
// `aws-actions/aws-secretsmanager-get-secrets`; `secret-files: MY_SECRET=./secret.txt` and
// `secret-envs: MY_SECRET=MY_ENV_VAR` are inputs of `docker/build-push-action`. None was reachable
// in the underscore spelling, so each is a new false positive rather than an inherited one, and each
// is an unclearable READY block. No value rule reaches them: `MY_SECRET=MY_ENV_VAR` holds no `/`, no
// `\` and no dotted extension, so NAMED_LOCATION_VALUE_PATTERN sees no location, and
// `prod/db/credentials` sits under a name LOCATION_NAME_PATTERN does not end-match.
//
// The added arms are anchored on the credential word, and the one arm that is not is the one that
// was already generic before this rule grew.
//  * The plural-location arm is `SECRET[_-](?:FILES|ENVS)$`, not `[_-](?:FILES|ENVS)$`. Both cover
//    the two documented inputs the finding named -- `secret-files: MY_SECRET=./secret.txt` and
//    `secret-envs: MY_SECRET=MY_ENV_VAR`, both of `docker/build-push-action` -- but the generic form
//    excused a literal under every credential word there is, and did so silently:
//    `TOKEN_FILES: ghp_16C7e42F292c6912E77`, `PASSWORD_FILES: kx7Qm2ZpLr9TvWs4`,
//    `API_KEY_ENVS: kx7Qm2ZpLr9TvWs4` and `PRIVATE_KEY_FILES: kx7Qm2ZpLr9TvWs4` are all reported
//    under the anchored form and were all clean under the generic one. What anchoring costs is a
//    plural mapping under some other credential word: `TOKEN_FILES: MY_TOKEN=./token.txt` is
//    reported and holds no secret. That is a report on a spelling no documented action input uses,
//    against four kinds of line that do hold a credential. The arm's own remaining cost is a literal
//    parked under the anchored plural anyway -- `SECRET_FILES: kx7Qm2ZpLr9TvWs4` is clean. The
//    singular is untouched and still needs the value half -- `SECRET_FILE: kx7Qm2ZpLr9TvWs4` is
//    reported, and `secret-file: kx7Qm2ZpLr9TvWs4.pem` is clean by LOCATION_NAME_PATTERN, not by
//    this rule.
//  * `[_-]NAMES?$` stays generic across every credential word, because `[_-]NAME$` was generic
//    before any of this and `NAMES` is its plural, carrying the same cost one plural further:
//    `TOKEN_NAMES: kx7Qm2ZpLr9TvWs4` is clean, exactly as `TOKEN_NAME: kx7Qm2ZpLr9TvWs4` is and was.
//    That is inherited, not new, so narrowing it belongs to a change that narrows the singular too.
//  * The identifier arm is anchored on the credential word (`SECRET[_-]IDS?$`) instead of excusing
//    `_ID` after any of them, because an id is reliably not the credential only when the thing it
//    identifies is a secret held in a store. `aws-access-key-id: AKIAIOSFODNN7EXAMPLE` is the
//    counter-example that forbids the generic form: an access key id is one half of a credential
//    pair, not a handle to one, and it stays reported. `client-secret-id` is covered by this arm and
//    is meant to be -- the OAuth credential is `client-secret`, and the `-id` form names the record.
//    `secret-manager-project` is not covered and stays reported: it ends in neither an identifier
//    nor a location word, and admitting `-PROJECT` would open the ecosystem-shaped name list this
//    file refuses everywhere else, wrong again with the next provider's spelling.
const REFERENCE_NAME_PATTERN = /[_-]NAMES?$|SECRET[_-](?:FILES|ENVS|IDS?)$/i;
// `secrets` is a workflow keyword, not a variable: it introduces a mapping, or carries the managed
// literal `inherit`. Entries nested under it are still read as lines of their own. Matched
// case-sensitively, because the keyword is lowercase and `SECRETS` is an ordinary variable name that
// keeps its report. `inherit` is below the length bound and would pass without this rule; what needs
// it is the same key used as an action input, such as a `hashicorp/vault-action` step listing store
// paths.
//
// This test sits inside the name-gated branch, after USERINFO_AUTHORITY_PATTERN has already
// run -- not before it, the way USES_KEYWORD_NAME_PATTERN below sits for `uses`. A `secrets:` value
// is `inherit` or a mapping by schema, never a scalar URL, but this scanner is line-based and does
// not check that a key sits where the schema puts it, so that argument would excuse an action input
// merely named `secrets` on the same terms it excuses the keyword. Moving this test ahead of the
// trigger, the way `uses` needs, would also excuse `secrets: postgres://u:secret@db.example.com/app`
// -- an ordinary stored credential, not a hypothetical one -- so it stays here instead: that line
// reaches USERINFO_AUTHORITY_PATTERN first and is reported.
const WORKFLOW_KEYWORD_NAME_PATTERN = /^secrets$/;
// `uses` is a workflow keyword too, holding an action or image reference rather than a variable.
// Matched case-sensitively and anchored, because the keyword is lowercase and `USES` and
// `uses-token` are ordinary variable names that keep their reports.
//
// Unlike `secrets` above, this test runs before USERINFO_AUTHORITY_PATTERN, because that
// trigger does not consult the name at all and would otherwise report a digest-pinned Docker action
// on a ported registry: `- uses: docker://registry.example.com:5000/image@sha256:0123456789abcdef`
// -- the registry port supplies the colon and the digest supplies the at-sign. A `uses:` value holds
// an action or image reference by definition, so that report carried no credential -- a pure false
// positive, and an unclearable READY block for any project pinning a Docker action on a self-hosted
// registry. The trigger's host rule now reaches every digest-pinned spelling as well, because the
// digest supplies the value's last at-sign and the algorithm before its colon (`sha256`) is a single
// label: `MY_IMAGE: docker://registry.example.com:5000/image@sha256:0123456789abcdef` and
// `MY_IMAGE: docker://user:hunter2@registry.example.com/image@sha256:0123456789abcdef` are both
// clean under a name this exemption does not cover. What the exemption still holds alone is the
// tag-pinned spelling, where the last at-sign is the authority's:
// `MY_IMAGE: docker://user:hunter2@registry.example.com/image:3.18` is reported and
// `- uses: docker://user:hunter2@registry.example.com/image:3.18` is clean. It is also what keeps
// the keyword out of the trigger's reach whatever a future digest algorithm or registry spelling
// looks like, rather than relying on `sha256` staying dotless.
//
// The exemption does not look at the value, and that is its cost, stated plainly: it excuses a
// userinfo-bearing value under this keyword too --
// `- uses: docker://user:hunter2@registry.example.com/image:3.18` is clean. The
// scanner does not check that a `uses:` key sits in a step, so an action input that happened to be
// named `uses` would be excused on the same terms -- the same structural gap `secrets` above is not
// given. The two are treated differently because a `uses:` value is `{owner}/{repo}@{ref}`,
// `./path` or `docker://{host}/{image}`, none of which has a userinfo field, while
// `secrets: postgres://u:secret@db.example.com/app` is the ordinary shape of a stored credential and
// earns no exemption from this pattern.
const USES_KEYWORD_NAME_PATTERN = /^uses$/;
// A braced reference -- `${{ … }}` or `${VAR}` -- means the value is interpolated at run time rather
// than stored here, so a suffix such as `/gcp.json` does not make the assignment a literal. It is
// honoured at the start of the value or after any character outside `[A-Za-z0-9]`, which is what the
// leading `(?:^|[^A-Za-z0-9])` requires: `pre-${{ … }}`, `pre_${{ … }}` and `.${VAULT_PATH}` are
// clean, but a reference glued straight onto an alphanumeric prefix is not read as one, so
// `DB_PASSWORD: prefix${{ secrets.PW }}`, `DB_PASSWORD: v2${{ secrets.PW }}` and
// `TOKEN: ghp${{ secrets.X }}` are all reported. That error points at a false positive, so it ships
// no credential -- but it is a permanent READY block, and a reader should not be surprised by it.
// A bare `$VAR` has no closing delimiter, so it is honoured in exactly two places: as the entire
// value, and where a `/` follows it. Both arms are knowingly open and neither can be closed. On the
// whole-value arm a literal made only of `[A-Za-z0-9_]` after a leading `$` --
// `$ecretPassword`, `$uper_Secret_1` -- is indistinguishable from `$DB_PASSWORD`, which has to stay
// clean. The `/` arm is open in the same way and just as wide, not narrower: the `/` ends this
// pattern's inspection, so whatever follows it is never read, and the prefix before it may be a
// single letter. `$a/hunter2hunter2`, `$ecret/Password1`, `$Kx7Qm/2ZpLr9TvWs4` and
// `$x/ghp_16C7e42F292c6912E77` are all excused here, and nothing in their shape separates them from
// `$RUNNER_TEMP/gcp.json`, which has to stay clean. What this pattern does not excuse is a `$`-led
// value holding no `/` and no braced reference that carries any character outside `[A-Za-z0-9_]`
// after that `$`; `$tr0ngP@ssw0rd!` under `DB_PASSWORD` is reported.
const MANAGED_REFERENCE_PATTERN =
  /(?:^|[^A-Za-z0-9])\$(?:\{\{.*?\}\}|\{[^}]+\})|^\$[A-Za-z_][A-Za-z0-9_]*(?:$|\/)/;
// A value whose own shape is a location: home-relative, explicitly relative, absolute, or an http(s)
// URL. Only a leading match counts. `~/`, `./` and `../` need no further evidence, because base64
// contains neither `~` nor `.`. A bare leading `/` does: it is read as a path only when a second
// separator follows. That test is deliberately partial. It reports a base64 secret that begins with
// `/` and holds no other `/` -- for a 40-character key about 54% of those that begin with `/` --
// and excuses the remaining ~46% as paths. Nothing in the shape of a value separates those two
// cases, so the class stays open rather than being closed by a guess in either direction.
const LOCATION_VALUE_PATTERN = /^(?:~\/|\.{1,2}\/|\/[^\s]*\/|https?:\/\/)/i;
// A name ending `FILE`, `PATH`, `DIR` or `URL` after a `_` or a `-` says the value is where a
// credential lives. Both separators are accepted so the two spellings behave alike; underscore-only
// here would have made admitting the hyphen a new false positive rather than a regression --
// `credentials-file: kx7Qm2ZpLr9TvWs4.pem` matched no name at all before the hyphen was admitted, so
// it was clean by being invisible, and an underscore-only suffix rule would have begun reporting it
// while `CREDENTIALS_FILE:` with the same value stayed clean. Each half alone is wrong: the name alone excuses any literal parked under it, and shape alone cannot
// read a store-relative path such as `secret/data/ci/deploy` or `gs://bucket/creds.json`. Required
// together, they are decisive. The value half reads: contains a `/` or a `\` anywhere, or is a bare
// filename with a dotted extension. `\` is accepted alongside `/` so a Windows path such as
// `C:\Users\runneradmin\id_rsa` is recognised the same way a POSIX one already is, and it carries
// the same accepted cost as `/`, not a smaller one. Neither character has to sit where a separator
// would -- one anywhere in the value is enough -- so `API_TOKEN_PATH: \ghp_16C7e42F292c6912E77` and
// `PRIVATE_KEY_DIR: kx7Qm2ZpLr9TvWs4\` both pass, exactly as the already-excused
// `API_TOKEN_PATH: /ghp_16C7e42F292c6912E77` does. The base64 alphabet (`A-Za-z0-9+/=`) has no
// backslash, so no raw base64 secret carries one, but that does not close the arm: `storedScalar`
// leaves YAML escapes uninterpreted, so a double-quoted scalar arrives with its `\n` escapes intact,
// and a PEM key flattened onto one line passes on the `\` arm even when its base64 body holds no
// `/`. The `/` arm's own cost is unchanged: base64 does contain `/`, so
// `AWS_SECRET_ACCESS_KEY_FILE: wJalrXUtnFEMI/K7MDENG/b` passes. Both are accepted for the same
// reason -- a location-suffixed name over a separator-bearing value is overwhelmingly a location,
// and the false positives this prevents block READY permanently while these misses do not.
const LOCATION_NAME_PATTERN = /[_-](?:FILE|PATH|DIR|URL)$/i;
const NAMED_LOCATION_VALUE_PATTERN = /[/\\]|^[^\s/\\]+\.[A-Za-z0-9]{1,8}$/;
// The one trigger that does not consult the name at all. A URL whose authority carries a
// `user:password` pair before an `@` is not a location and not a reference; it is a credential with a
// hostname attached, and that is true whatever the variable is called.
// `DATABASE_URL: postgres://u:secret@db.example.com/app` and
// `REDIS_URL: redis://:hunter2@cache.internal.example.com:6379/0` carry a live password under names
// holding no token from SECRET_NAME_PATTERN, and are the most ordinary spelling of exactly what this
// check exists to report. The alternative -- adding `DATABASE|REDIS|DSN|MONGO|AMQP` to the name
// pattern -- is an unbounded list that is wrong again with the next driver, so the value's own shape
// carries this instead.
//
// The password test requires a character after the colon, so a pair needs a password to be one. An
// empty password position declares that there is none and stores nothing, so
// `REDIS_URL: redis://:@localhost:6379`, `MYSQL_URL: mysql://root:@127.0.0.1:3306/test` and
// `POSTGRES_URL: postgres://user:@db/app` are clean. Those three wear hosts the rule below would also
// excuse, so the probe that isolates this arm is a dotted, public one:
// `POSTGRES_URL: postgres://user:@db.example.com/app` is clean and
// `POSTGRES_URL: postgres://user:x@db.example.com/app` is reported, one password character apart.
// The username side has no such requirement, because an empty username is the ordinary spelling of a
// Redis or AMQP DSN and the password after it is the whole credential:
// `REDIS_URL: redis://:hunter2@cache.internal.example.com:6379/0` is reported.
//
// The scheme prefix admits three levels. A JDBC URL nests a driver scheme inside `jdbc:`, and that
// nesting is the spelling the frameworks require, not a variant of it: `spring.datasource.url` takes
// `jdbc:mysql://root:hunter2@db.example.com:3306/app`, and `JDBC_DATABASE_URL` and
// `QUARKUS_DATASOURCE_JDBC_URL` take `jdbc:postgresql://u:hunter2@db.example.com:5432/app`. Under a
// one-level grammar the whole JDBC family escaped, and it escaped under names carrying no token from
// SECRET_NAME_PATTERN -- exactly the class this trigger exists to cover, so the escape was total
// rather than partial. Two levels still left the pooled and gateway forms out, and those are
// ordinary rather than exotic: `spring.r2dbc.url` takes
// `r2dbc:pool:postgresql://u:hunter2@db.example.com:5432/app`, and the jTDS driver spells its URL
// `jdbc:jtds:sqlserver://u:hunter2@db.example.com:1433/app`. Both are reported at three.
//
// Three is a choice about how deep to look, not a claim about how deep a URL can nest. The grammar
// has no depth limit and neither does any registry of driver spellings, so a fourth level escapes and
// nothing here would notice it: `MY_URL: a:b:c:d://u:hunter2@db.example.com/app` is clean, and so is
// any real spelling that ever wraps a nested driver URL one more time. The bound exists because an
// unbounded run would read any number of leading `word:` segments as scheme -- turning every
// colon-separated prefix in front of a `//` into a scheme, a much wider claim than the two nestings
// anyone can name -- so the number is set where the known spellings stop and is honest about being
// arbitrary one step past them. Each level costs what the first costs, one nesting further in: a
// `word:word:word://` value carrying a userinfo colon before an at-sign is read as an authority too.
//
// It sits after the length bound and MANAGED_REFERENCE_PATTERN and before everything else. Both
// halves of that placement are load-bearing.
//  * After MANAGED_REFERENCE_PATTERN, because the span below runs straight through `{`, `}` and `$`:
//    `DATABASE_URL: postgres://u:${{ secrets.PW }}@db.example.com/app` and
//    `DATABASE_URL: postgres://u:${DB_PASSWORD}@db.example.com/app` hand it a `:` and a later `@` for
//    free while storing nothing, and reporting either would be an unclearable READY block on a
//    correct line. A bare `$PASSWORD` in that position has no closing delimiter for
//    MANAGED_REFERENCE_PATTERN to find, so `DATABASE_URL: postgres://u:$PASSWORD@db.example.com/app`
//    is reported. That is the same open arm the whole-value and `$VAR/` cases already carry, and it
//    is not narrowed here.
//  * Before the name gate and before LOCATION_VALUE_PATTERN, because otherwise
//    `MY_SERVICE_ENDPOINT: https://u:secret@host.example.com/app` is excused twice over -- once for a
//    name that sounds like nothing, once for an `https://` scheme -- and a credential is a credential
//    whatever scheme it wears. An `https://` or bare-`//` value with no userinfo keeps its excuse:
//    `TOKEN_URL: https://auth.example.com/token` and `TOKEN_URL: //auth.example.com/token` stay clean.
//
// Placing it before the name gate makes the `_URL`-scoped form of this rule redundant, and that form
// is gone: any value matching this pattern is reported before the location-name arm is reached, so
// `PASSWORD_FILE: postgres://u:secret@db.example.com/app`,
// `PASSWORD_FILE: postgres://app:aB3/xYz9pQ@db.example.com:5432/app` and
// `DB_PASSWORD_URL: https://u:secret@db.example.com/app` -- all three clean before this change -- are
// now reported.
//
// The span searched for the pair begins after `//` and ends at the first `?` or `#`. Inside that
// span the split follows the URL grammar: the userinfo is everything before the *last* `@`, and the
// host begins right after it. A value with no `//` has no span to inspect, which is why
// `TOKEN_URL: auth.example.com/token` stays clean, and a span holding no `@` is no match, which is
// why `TOKEN_URL: https://auth.example.com/token` stays clean.
//
// The span is wider than RFC 3986's authority in exactly one way: RFC 3986 ends the authority at the
// first `/`, and this one runs through `/` to the `?` or `#`. That is deliberate. An unencoded
// password containing a `/` would otherwise put the `@` past the authority and go unreported, and `/`
// is in the base64 alphabet (`A-Za-z0-9+/=`), so `openssl rand -base64` puts one in roughly every
// second password it generates. `POSTGRES_PASSWORD_URL: postgres://app:aB3/xYz9pQ@db.example.com:5432/app`,
// `PASSWORD_URL: redis://:hun/ter2@cache.example.com:6379/0` and
// `DATABASE_CREDENTIALS_URL: mysql://root:pa/ss@db.example.com:3306/app` are all reported, as is the
// same password percent-encoded (`aB3%2FxYz9pQ`) and one holding several slashes
// (`postgres://u:a/b/c/d@db.example.com:5432/app`).
//
// Taking the *last* `@` rather than the first is what makes the widened span safe. An `@` is an
// ordinary character in a human-chosen password, and under a first-`@` split the fragment after it
// was read as the host: `postgres://u:p@ss/word@db.example.com/app` gave `ss`,
// `postgres://u:p@ss:word@db.example.com:5432/app` gave `ss`, and
// `postgres://u:P@w0rd/x@prod-db.example.com:5432/app` gave `w0rd` -- three dotless fragments, each
// excused by the single-label arm below while the real host was public and the password real. All
// three are reported now, and so is `postgres://u:p@ss@db.example.com/app`, whose host reads
// `db.example.com` rather than `ss@db.example.com`.
//
// A match is reported only when its host could be a public endpoint, and that carve-out is the widest
// thing in this block. What it excuses is the service-container DSN, which is the most common
// userinfo-bearing line in real CI: `DATABASE_URL: postgres://postgres:postgres@localhost:5432/test`,
// `DATABASE_URL: postgresql://test:test@localhost:5432/test`,
// `AMQP_URL: amqp://guest:guest@localhost:5672`, `MONGO_URL: mongodb://root:example@localhost:27017`
// and `DATABASE_URL: postgres://postgres:postgres@db:5432/test` all address a container the workflow
// started a few lines above and destroys when the job ends. The companion `POSTGRES_PASSWORD: test`
// sits below MIN_LITERAL_SECRET_LENGTH and was always clean, so in a typical file the DSN is the only
// line this function would report at all -- the check would block READY on a credential it watched
// the workflow invent, on a project that was clean before this trigger existed.
//
// Two signals, both bounded by the CI runtime rather than by the ecosystem, which is what separates
// them from the driver-name list the name pattern refuses:
//  * a loopback host -- `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`. Only the two dotted ones need
//    naming; `localhost` and `::1` are already held by the arm below, and all four are named anyway
//    so the rule reads as the two signals it is.
//  * a host with no dot in it -- a single label such as `db`, `cache`, `rabbit` or `postgres`. A
//    single-label name is not publicly resolvable: on a runner it is a service container, a Compose
//    alias or a link-local name, and no stranger can reach what it addresses.
//
// The accepted cost, stated plainly: a credential for an internal host reachable by a single-label
// name is not reported. `DATABASE_URL: postgres://svc:hunter2@vault-prod/app` is a stored credential
// and is clean, and so is every password for a private-network host named without a dot. Nothing in
// the shape of the line separates that from the service container above it, and the trade is this
// file's standing one: a miss costs a report, a false positive costs READY permanently with no way
// for the owner to clear it.
//
// The other side of that trade is stated as plainly, because it is the wider one. A dotted host is
// reported whatever it resolves to. That is what keeps a private address written out
// (`postgres://u:hunter2@10.0.0.5:5432/app`) and an internal FQDN
// (`redis://:hunter2@cache.internal.example.com:6379/0`) reported, and it is also what reports a
// whole class of hosts that are as job-local as `db` is. The loopback list is closed at four exact
// spellings, so every dotted name for the same machine or the same job is outside it:
// `postgres://u:hunter2@host.docker.internal:5432/app` (the runner's own host),
// `postgres://u:hunter2@postgres.default.svc.cluster.local:5432/app` (a Kubernetes service DNS
// name), `postgres://u:hunter2@db.local:5432/app` (mDNS),
// `postgres://u:hunter2@localhost.localdomain:5432/app`, `postgres://u:hunter2@localhost./app` and
// `postgres://u:hunter2@127.0.0.1./app` (the fully-qualified spellings of two names on the list),
// `postgres://u:hunter2@127.0.0.2:5432/app` and `postgres://u:hunter2@127.0.1.1:5432/app` (the rest
// of the loopback /8), and the bracketed `redis://:hunter2@[::]:6379/0` and
// `redis://:hunter2@[0:0:0:0:0:0:0:1]:6379/0` are all reported. That class -- not the single
// `[::ffff:127.0.0.1]` spelling -- is what the closed list costs, and each of those reports is an
// unclearable READY block. The list stays closed anyway: the alternative is a shape rule over
// resolvable names, which would have to decide that `127.0.0.0/8`, `.local`, `.internal` and
// `*.svc.cluster.local` are never public, and each of those is a claim about someone else's DNS
// rather than about the CI runtime. Erring toward the report is the direction this rule should fail
// in, and the report names a real stored credential in every case above.
//
// Where the host ends is established by shape, not assumed. It begins after the span's last `@` and
// runs to the first `:`, `/`, `?` or `#`, so a port is not part of the host:
// `db.example.com:5432/app` gives `db.example.com`, `sha256:0123456789abcdef` gives `sha256`, and
// `2026.json` (a path at-sign, not an authority one) gives `2026.json`.
//
// Reading the *last* `@` costs two shapes, both of which come from the span running through `/`
// rather than stopping at it the way RFC 3986 does. Neither is a report of nothing.
//  * A path at-sign after a genuine authority moves the host past the real one, so a credential can
//    go unreported: `DATABASE_URL: postgres://u:hunter2@db.example.com/app@2026` reads its host as
//    `2026`, a single label, and is clean. It is the miss direction, and it needs a URL whose *path*
//    carries an at-sign, which a DSN's database-name path does not. The same URL without the path
//    at-sign -- `postgres://u:hunter2@db.example.com/app` -- is reported.
//  * A path at-sign with any colon before it is read as an authority, so a bucket URL can be
//    reported with nothing in it: `CREDENTIALS_URL: gs://my-bucket@zone/2026:07/creds@v1.json` reads
//    `v1.json` as its host and is reported. That is the same false-positive class as the bucket and
//    timestamp spellings listed below, one at-sign further along, and it is priced with them.
// Where the first `@` is the only `@`, the two readings agree, which is every ordinary URL in this
// file. Where they differ the last-`@` reading is the correct one: `postgres://u:p@ss@127.0.0.1/app`
// reads its host as `127.0.0.1` and is clean, where the first-`@` reading gave `ss@127.0.0.1`, called
// it dotted, and reported a loopback service container as a public credential.
//
// An IPv6 literal is bracketed and read whole, `[::1]:6379/0` giving `::1`. A bracketed host is
// judged against the loopback list only, never the single-label arm: an IPv6 address carries no dot,
// so that arm would otherwise excuse every one of them, and
// `POSTGRES_URL: postgres://u:hunter2@[2001:db8::1]:5432/app` is reported. The list is closed at the
// four names, so an IPv6 spelling of loopback that is not `::1` is reported --
// `postgres://u:hunter2@[::ffff:127.0.0.1]:5432/app` -- which is the closed list's cost and the
// direction it should fail in.
//
// The carve-out sits on this trigger and nowhere else, but that only means an excused line falls
// through to the gate below rather than being cleared outright -- and what happens there depends on
// the name, not on the value. A secret-shaped name with no location suffix is reported:
// `DB_PASSWORD: postgres://postgres:postgres@localhost:5432/test` is, while `DATABASE_URL:` with the
// same value is clean. A secret-shaped name *with* a location suffix is not, because
// LOCATION_NAME_PATTERN plus a `/` in the value excuses it a second time:
// `DB_PASSWORD_URL: postgres://postgres:postgres@localhost:5432/test` and
// `PASSWORD_FILE: postgres://postgres:postgres@localhost:5432/test` are both clean. That is the
// larger half of the class, since a connection string is usually stored under a `_URL` name, so the
// carve-out excusing a loopback DSN is in practice the last word for most of the lines it reaches
// rather than a first opinion the name gate revisits. The remaining name-gated report is not an
// inconsistency to resolve here: it predates this trigger, and the class the carve-out was written
// for -- a project that was clean until the trigger began reading every line -- is exactly the one
// whose DSN sits under a name carrying no token from SECRET_NAME_PATTERN at all.
//
// The false positives are what that buys, and each is a permanent READY block on a correct line. The
// shape is exact: within the span, a `:` with the span's last `@` somewhere after it and at least one
// character between the two. The colon has three ordinary sources -- a port,
// `CREDENTIALS_URL: gs://my-bucket:8080/creds@2026.json` and
// `TOKEN_URL: ssh://github.com:22/org/repo@v1.git`; a path segment,
// `CREDENTIALS_URL: gs://my-bucket/2026:07/creds@2026.json` and
// `CREDENTIALS_URL: s3://bucket/2026-01-01T00:00:00Z/creds@v1.json`; and a Windows drive letter,
// `CREDENTIALS_URL: file:///c:/keys/creds@2026.json`. All five are reported and none is a secret.
//
// Dropping the name gate widened that class from `_URL`-suffixed names to every name in the file, so
// the question the widening has to answer is not how many lines in this repository match but what
// kinds of line can. Three kinds do, and each is held by a rule rather than by scarcity.
//  * An image reference pinned by digest, where a registry port supplies the colon and the digest
//    supplies the at-sign: `- uses: docker://registry.example.com:5000/image@sha256:0123456789abcdef`.
//    USES_KEYWORD_NAME_PATTERN is tested before this trigger and exempts the keyword outright, with
//    the cost recorded there. The host rule above reaches every digest-pinned spelling of this line
//    too, since the digest supplies the last at-sign and `sha256` is a single label, but the
//    exemption is what is relied on: it also covers the tag-pinned
//    `- uses: docker://user:hunter2@registry.example.com/image:3.18`, whose last at-sign is the
//    authority's and whose host is therefore dotted. That exemption is anchored, so `uses-token` is
//    not covered by it -- that line reaches this trigger, and either the host rule declines it on
//    `sha256` and SECRET_NAME_PATTERN reports it on the name, or, in the tag-pinned spelling, the
//    trigger reports it on the authority.
//  * An authority declaring an empty password: `redis://:@localhost:6379`. Held by the password test,
//    above.
//  * A service-container DSN: `postgres://postgres:postgres@localhost:5432/test`. Held by the host
//    rule, above.
// What stays open is the shape itself under any name: a `scheme://` value carrying a colon and then
// an at-sign before its first `?` or `#`, over a dotted host. The bucket, timestamp and drive-letter
// spellings listed above are that shape; they were already reported under an `_URL` name, and the
// widening gave them every other name too. Both halves are still needed, in that order, so
// `gs://my-bucket:8080/creds.json` and `gs://my-bucket/2026:07/creds.json` (no at-sign),
// `gs://my-bucket/creds@2026.json` and `gs://my-bucket/creds@2026/v:1.json` (no colon before the
// last at-sign -- in the second the colon sits after it, in the host) and the unported
// `- uses: docker://ghcr.io/org/image@sha256:0123456789abcdef` all stay clean. Reading the last `@`
// rather than the first adds one member to this class rather than a new kind: an earlier at-sign is
// no longer a barrier the colon cannot be found across, so
// `gs://my-bucket@zone/2026:07/creds@v1.json` is now reported where it was clean. It is the same
// bucket-path shape as the two above it, and it is priced with them. Across this repository's own
// YAML no line matches this shape, which says the widening costs nothing here and nothing at all
// about what it costs in a user's project.
//
// Three more limits, all deliberate, and each one is a way a stored credential goes unreported. The
// host rule above is a fourth, with its cost stated there.
// 1. A colon inside the userinfo is required, so a URL whose *username alone* is the credential --
//    `TOKEN_URL: postgres://ghp_16C7e42F292c6912E77@db.example.com/app` -- is not reported. That is
//    the price of keeping `TOKEN_URL: ssh://git@github.com/org/repo.git`, the ordinary spelling of a
//    Git remote, and `DATABASE_CREDENTIALS_URL: mysql://root@db.example.com:3306/app` clean: a bare
//    username before an `@` is a host's companion far more often than it is a secret, and reporting
//    one is an unclearable READY block.
// 2. The span still stops at `?` and `#`, so a password holding either is not reported:
//    `TOKEN_URL: postgres://u:sec?ret@db.example.com/app` and
//    `TOKEN_URL: postgres://u:sec#ret@db.example.com/app` are clean.
//    Unlike `/`, neither character is in the base64 alphabet, so a generated password does not carry
//    one -- while a query string is an ordinary part of a storage URL and hands the pattern both
//    halves for free. Running the span on would report
//    `TOKEN_URL: gs://my-bucket/creds.json?url=https://cdn.example.com/x@1`,
//    `CREDENTIALS_URL: gs://my-bucket/creds.json?ts=2026-01-01T00:00:00Z&owner=a@b.example`,
//    `CREDENTIALS_URL: gs://my-bucket/2026:07/creds.json?owner=a@b.example` and
//    `SECRET_URL: s3://bucket/key.json#frag:1@rev`, all of which are clean today. That trade is worse
//    than the one above it, so `?` and `#` keep terminating and this limit stays open.
// 3. MIN_LITERAL_SECRET_LENGTH is checked first, so a userinfo value under eight characters is
//    excused: `//:b@c.` is clean where `//:b@c.d` is reported. Both wear a dotted host, so the bound
//    is the only thing between them and it is pinned where it sits. The bound is not free, though.
//    Six characters already carry a `//`, a password, an `@` and a host with a dot in it: `//:b@.`
//    parses as password `b` over the host `.`, which is dotted and public by these rules, and
//    `//:b@.d` at seven is the same shape with a label after the dot. Both are excused by length
//    alone, and `//:bbb@.` -- eight characters, the same host `.` -- is reported, so the shapes below
//    the bound are reachable rather than hypothetical. What they are not is credentials: a
//    one-character password over a hostname that is a bare dot is a line no workflow writes, so the
//    bound is priced against short scalars generally rather than against this trigger, and keeping
//    the trigger off every short scalar in the file is what it is for -- which matters now that it
//    reads every line, not only secret-named ones.
//
// The split is two captures rather than one, so the rule above reads the same host the grammar does.
// Group 1 is the userinfo -- everything between `//` and the span's last `@` -- and it is a match
// only when USERINFO_PASSWORD_PATTERN finds a colon in it with at least one character after it.
// Group 2 is the host: the bracketed form, or the run of characters up to the first `:`, `/`, `?` or
// `#`. The host may be empty, and an empty host (`postgres://u:secret@:5432/app`) carries no dot and
// is excused with the rest. Splitting the password test out of the pattern also makes the match
// linear: the userinfo run is scanned once and backtracked once to find the last `@`, where the
// single combined form re-scanned for an `@` from every colon in the value.
const USERINFO_AUTHORITY_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:){0,3}\/\/([^?#]*)@(\[[^\]]*\]|[^:/?#]*)/;
const USERINFO_PASSWORD_PATTERN = /:./;
const LOOPBACK_HOST_PATTERN = /^(?:localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i;
const SINGLE_LABEL_HOST_PATTERN = /^[^.]*$/;
const BRACKETED_HOST_PATTERN = /^\[(.*)\]$/;
const MIN_LITERAL_SECRET_LENGTH = 8;

// Reduces a YAML scalar to the characters actually stored: the body of a quoted string, otherwise
// the value with its trailing `#` comment removed.
const storedScalar = (rawValue: string): string => {
  const quoted = /^(["'])([\s\S]*?)\1\s*(?:#.*)?$/.exec(rawValue);
  if (quoted?.[2] !== undefined) return quoted[2];
  return rawValue
    .replace(/(?:^|\s)#.*$/, "")
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "");
};

// True when the value embeds a password in its authority for a host that could be a public endpoint.
const embedsPasswordForPublicHost = (value: string): boolean => {
  const authority = USERINFO_AUTHORITY_PATTERN.exec(value);
  if (authority === null || !USERINFO_PASSWORD_PATTERN.test(authority[1] ?? "")) return false;
  const host = authority[2] ?? "";
  const bracketed = BRACKETED_HOST_PATTERN.exec(host);
  if (bracketed !== null) return !LOOPBACK_HOST_PATTERN.test(bracketed[1] ?? "");
  return !LOOPBACK_HOST_PATTERN.test(host) && !SINGLE_LABEL_HOST_PATTERN.test(host);
};

export const inlineSecretFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(line);
      const name = match?.[1];
      const rawValue = match?.[2];
      if (!name || !rawValue) continue;
      const value = storedScalar(rawValue);
      if (value.length < MIN_LITERAL_SECRET_LENGTH || MANAGED_REFERENCE_PATTERN.test(value)) continue;
      // The `uses` keyword is excused before any trigger runs, because the userinfo trigger below
      // does not consult the name and would otherwise report a `uses:` image reference.
      if (USES_KEYWORD_NAME_PATTERN.test(name)) continue;
      // A `user:password` authority over a host that could be a public endpoint is a stored
      // credential under any name, so it skips the name gate and the value-shape rules below. Every
      // other report still has to earn a secret-shaped name.
      const embedsPasswordInAuthority = embedsPasswordForPublicHost(value);
      if (!embedsPasswordInAuthority) {
        if (!SECRET_NAME_PATTERN.test(name)) continue;
        if (REFERENCE_NAME_PATTERN.test(name) || WORKFLOW_KEYWORD_NAME_PATTERN.test(name)) continue;
        if (LOCATION_VALUE_PATTERN.test(value)) continue;
        if (LOCATION_NAME_PATTERN.test(name) && NAMED_LOCATION_VALUE_PATTERN.test(value)) continue;
      }
      findings.push(
        finding(
          "INLINE_SECRET_IN_CI",
          "CRITICAL",
          file.path,
          embedsPasswordInAuthority
            ? `The workflow assigns ${name} a URL whose authority embeds a password instead of referencing a managed secret.`
            : `The workflow assigns ${name} a literal value instead of referencing a managed secret.`,
        ),
      );
      break;
    }
  }
  return findings;
};

export const prodEnvFindings = (
  entries: readonly { path: string; exists: boolean; ignored: boolean | null }[],
): readonly SecurityFindingDraft[] =>
  entries
    .filter((entry) => entry.exists && entry.ignored !== true)
    .map((entry) =>
      finding(
        "PROD_ENV_NOT_IGNORED",
        "HIGH",
        entry.path,
        entry.ignored === null
          ? "Ignore coverage could not be verified for an existing production environment file."
          : "An existing production environment file is not covered by Git ignore rules.",
      ),
    );

export const launchOwnerChecks = (): readonly ReadinessCheckDraft[] => [
  ownerCheck(
    "SECURITY_HEADERS_OWNER_REVIEW",
    "SECURITY",
    "Confirm the security header decision for this project, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_HEALTH_ENDPOINT_DECLARED",
    "OPERATIONS",
    "Confirm a health or readiness path exists, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_ROLLBACK_PLAN",
    "OPERATIONS",
    "Confirm what happens when a release fails and how the previous state is restored.",
  ),
  ownerCheck(
    "OPS_BACKUP",
    "OPERATIONS",
    "Confirm how project data is backed up and restored, or mark it not applicable.",
  ),
];

export const assessProjectReadiness = async (
  repositoryPath: string,
  options: { activeConstitution: boolean },
): Promise<ProjectReadinessAssessmentDraft> => {
  const canonicalRoot = await realpath(repositoryPath).catch(() => null);
  if (canonicalRoot === null) {
    throw new ProjectReadinessScanError("REPOSITORY_UNAVAILABLE", "The Project repository is unavailable");
  }
  const topLevel = await runBoundedGit(["rev-parse", "--show-toplevel"], canonicalRoot);
  if (topLevel.overflowed || topLevel.exitCode !== 0 || !samePath(outputText(topLevel), canonicalRoot)) {
    throw new ProjectReadinessScanError(
      "REPOSITORY_UNAVAILABLE",
      "The Project repository is not available at its registered top-level path",
    );
  }

  const [
    headResult,
    statusResult,
    trackedResult,
    envIgnored,
    envLocalIgnored,
    npmrcIgnored,
    hasLicense,
    workflows,
    prodEnvExists,
    prodEnvLocalExists,
    prodEnvIgnored,
    prodEnvLocalIgnored,
  ] = await Promise.all([
    runBoundedGit(["rev-parse", "HEAD"], canonicalRoot),
    runBoundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], canonicalRoot),
    runBoundedGit(["ls-files", "-z"], canonicalRoot),
    ignoredByGit(canonicalRoot, ".env"),
    ignoredByGit(canonicalRoot, ".env.local"),
    ignoredByGit(canonicalRoot, ".npmrc"),
    licensePresent(canonicalRoot),
    readBoundedCiWorkflows(canonicalRoot),
    pathExists(canonicalRoot, ".env.production"),
    pathExists(canonicalRoot, ".env.production.local"),
    ignoredByGit(canonicalRoot, ".env.production"),
    ignoredByGit(canonicalRoot, ".env.production.local"),
  ]);

  const repositoryHead =
    headResult.exitCode === 0 && !headResult.overflowed && /^[0-9a-f]{40,64}$/.test(outputText(headResult))
      ? outputText(headResult)
      : null;
  if (statusResult.exitCode !== 0 || statusResult.overflowed) {
    throw new ProjectReadinessScanError("REPOSITORY_UNAVAILABLE", "Git could not inspect repository status");
  }

  const secretFindings: SecurityFindingDraft[] = [];
  if (trackedResult.exitCode !== 0 || trackedResult.overflowed) {
    secretFindings.push(
      finding(
        "TRACKED_SECRET_PATH",
        "HIGH",
        null,
        "Tracked paths exceeded the safe inspection bound, so secret-like filenames were not fully checked.",
      ),
    );
  } else {
    for (const path of splitNullPaths(trackedResult).filter(isSecretLikePath).slice(0, 128)) {
      secretFindings.push(
        finding("TRACKED_SECRET_PATH", "CRITICAL", path, "Git tracks a filename commonly used for secrets."),
      );
    }
  }

  const ignoreFindings: SecurityFindingDraft[] = [];
  for (const [path, ignored] of [
    [".env", envIgnored],
    [".env.local", envLocalIgnored],
    [".npmrc", npmrcIgnored],
  ] as const) {
    if (ignored !== true) {
      ignoreFindings.push(
        finding(
          "ENV_NOT_IGNORED",
          "HIGH",
          path,
          ignored === null
            ? "Git ignore coverage could not be verified for this secret-bearing path."
            : "Git ignore rules do not cover this secret-bearing path.",
        ),
      );
    }
  }

  const ci = [...workflows.unverifiable, ...ciFindings(workflows.files)];

  const checks: readonly ReadinessCheckDraft[] = [
    automatedCheck(
      "SECURITY_ACTIVE_CONSTITUTION",
      "SECURITY",
      "An active owner-approved Project Constitution is present.",
      "Approve and publish a Project Constitution before launch.",
      options.activeConstitution
        ? []
        : [
            finding(
              "ACTIVE_CONSTITUTION_MISSING",
              "HIGH",
              ".loomrail/constitution.md",
              "The Project has no active owner-approved Constitution.",
            ),
          ],
    ),
    automatedCheck(
      "SECURITY_SECRET_PATHS",
      "SECURITY",
      "Git does not track known secret-like filenames.",
      "Remove or explicitly review tracked secret-like paths.",
      secretFindings,
    ),
    automatedCheck(
      "SECURITY_ENV_IGNORED",
      "SECURITY",
      "Git ignore rules cover common local secret files.",
      "Add ignore coverage for common local secret files.",
      ignoreFindings,
    ),
    automatedCheck(
      "SECURITY_CI_HARDENING",
      "SECURITY",
      "No known high-risk CI patterns were found in the bounded workflow scan.",
      "Review the reported CI trust and pinning findings.",
      ci,
    ),
    automatedCheck(
      "LEGAL_LICENSE",
      "LEGAL",
      "A root license marker is present.",
      "Add or explicitly decide the repository license before launch.",
      hasLicense
        ? []
        : [finding("LICENSE_MISSING", "MEDIUM", null, "No regular root LICENSE or COPYING file was found.")],
    ),
    ownerCheck(
      "LEGAL_OWNER_REVIEW",
      "LEGAL",
      "Confirm applicable license, privacy, terms, and data-processing obligations.",
    ),
    ownerCheck(
      "PAYMENTS_OWNER_REVIEW",
      "PAYMENTS",
      "Confirm payment, tax, refund, and provider obligations, or mark them not applicable.",
    ),
    ownerCheck(
      "ANALYTICS_OWNER_REVIEW",
      "ANALYTICS",
      "Confirm consent, retention, disclosure, and analytics data handling, or mark them not applicable.",
    ),
    automatedCheck(
      "DEPS_LOCKFILE_PRESENT",
      "DEPENDENCIES",
      "No missing or ambiguous lockfiles were found for tracked dependency manifests.",
      "Track a single lockfile so installs are reproducible.",
      lockfileFindings(
        trackedResult.exitCode !== 0 || trackedResult.overflowed ? null : splitNullPaths(trackedResult),
      ),
    ),
    automatedCheck(
      "ENV_PROD_SEPARATION",
      "ENVIRONMENT",
      "No unignored production env file or literal CI secret was found in the bounded scan.",
      "Keep production values out of the repository and out of CI literals.",
      [
        ...prodEnvFindings([
          { path: ".env.production", exists: prodEnvExists, ignored: prodEnvIgnored },
          { path: ".env.production.local", exists: prodEnvLocalExists, ignored: prodEnvLocalIgnored },
        ]),
        ...inlineSecretFindings(workflows.files),
        ...workflows.unverifiable,
      ],
    ),
    ...launchOwnerChecks(),
  ];
  const sourceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        repositoryHead,
        status: statusResult.output.toString("base64"),
        checks,
      }),
    )
    .digest("hex");

  return {
    repositoryHead,
    sourceDigest,
    workingTreeDirty: statusResult.output.byteLength > 0,
    checks,
  };
};
