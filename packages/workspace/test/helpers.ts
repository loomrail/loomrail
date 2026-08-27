import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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

// Creates a throwaway git repository parked mid-rebase with an unresolved conflict: `main` and
// `feature` each make a diverging edit to the same line of the same file, then `feature` is
// rebased onto `main`. The `git rebase` call below is expected to exit non-zero -- that is the
// conflict landing as intended (setup succeeding), not a failure of this helper.
export const makeRepoMidRebase = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-rebase-"));
  const sharedFile = join(dir, "shared.txt");
  const commit = (message: string) =>
    execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", message], { cwd: dir });

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });

  await writeFile(sharedFile, "base\n");
  await execFileAsync("git", ["add", "shared.txt"], { cwd: dir });
  await commit("base");

  await execFileAsync("git", ["checkout", "--quiet", "-b", "feature"], { cwd: dir });
  await writeFile(sharedFile, "feature change\n");
  await execFileAsync("git", ["add", "shared.txt"], { cwd: dir });
  await commit("feature change");

  await execFileAsync("git", ["checkout", "--quiet", "main"], { cwd: dir });
  await writeFile(sharedFile, "main change\n");
  await execFileAsync("git", ["add", "shared.txt"], { cwd: dir });
  await commit("main change");

  await execFileAsync("git", ["checkout", "--quiet", "feature"], { cwd: dir });

  try {
    await execFileAsync("git", [...testCommitterArgs, "rebase", "main"], { cwd: dir });
  } catch {
    // Expected: the rebase stops on a conflict, leaving .git/rebase-merge behind. That is the
    // mid-rebase state this helper exists to produce, not an error to surface.
  }

  return dir;
};
