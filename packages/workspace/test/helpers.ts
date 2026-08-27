import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const testCommitterArgs = ["-c", "user.email=loomrail-test@example.com", "-c", "user.name=Loomrail Test"];

// Creates a throwaway git repository under the OS temp directory, with one empty commit already
// made, so tests have a real repo to run `git` commands against. The committer identity is set
// with -c flags rather than relying on the machine's global git config, so the test does not
// depend on the settings of whoever runs it.
export const makeThrowawayRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
  await execFileAsync("git", [...testCommitterArgs, "commit", "--allow-empty", "--quiet", "-m", "initial"], {
    cwd: dir,
  });
  return dir;
};
