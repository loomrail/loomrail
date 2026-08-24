import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: repositoryRoot,
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const forbiddenFileNames = [
  /(^|\/)\.env(?:\.[^/]+)?$/i,
  /\.(?:db|sqlite|sqlite3)(?:-[^/]*)?$/i,
  /\.(?:log|trace|har)$/i,
  /(^|\/)trace\.zip$/i,
  /(^|\/)(?:screen ?shot|screencapture)[^/]*\.(?:png|jpe?g|webp)$/i,
];

const forbiddenContent = [
  { label: "private key", pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { label: "OpenAI-style secret", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { label: "macOS personal path", pattern: /\/Users\/[^/\s"']+/ },
  { label: "Windows personal path", pattern: /[A-Za-z]:\\Users\\[^\\\r\n"']+/ },
];

const findings = [];

for (const relativePath of candidateFiles) {
  if (forbiddenFileNames.some((pattern) => pattern.test(relativePath))) {
    findings.push(`${relativePath}: forbidden runtime/private artifact name`);
    continue;
  }

  const absolutePath = resolve(repositoryRoot, relativePath);
  if (statSync(absolutePath).size > 2 * 1024 * 1024) continue;
  const content = readFileSync(absolutePath);
  if (content.includes(0)) continue;

  const text = content
    .toString("utf8")
    .replaceAll("/Users/local owner", "[synthetic-macos-home]")
    .replaceAll("C:\\Users\\local owner", "[synthetic-windows-home]");
  for (const check of forbiddenContent) {
    if (check.pattern.test(text)) findings.push(`${relativePath}: contains ${check.label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Public-tree check failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-tree check passed for ${candidateFiles.length.toString()} files.\n`);
}
