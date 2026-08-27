import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Throwaway Git repositories for the daemon's own tests. `@loomrail/workspace` has near-identical
// helpers, but they live in that package's `test/` directory, which nothing outside it can import;
// these are the daemon-side copies, kept in one file rather than in each test that needs one.
//
// The committer identity is set with -c flags rather than relying on the machine's global git
// config, so a repository builds the same way whoever runs the suite.
const testCommitterArgs = ["-c", "user.email=loomrail-test@example.com", "-c", "user.name=Loomrail Test"];

/**
 * A repository with one committed file. Created at `at` when given -- so a caller can put it beside
 * whatever else its test owns and clean up in one `rm` -- and otherwise at a fresh temporary
 * directory of its own.
 */
export const makeThrowawayRepo = async (at?: string): Promise<string> => {
  const dir = at ?? (await mkdtemp(join(tmpdir(), "loomrail daemon repo ")));
  if (at !== undefined) await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "committed.txt"), "committed\n");
  await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
  await execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", "initial"], { cwd: dir });
  return dir;
};

/**
 * A repository parked mid-rebase with an unresolved conflict: `main` and `feature` each edit the
 * same line of the same file, then `feature` is rebased onto `main`. The `git rebase` call is
 * expected to exit non-zero -- that is the conflict landing as intended, not a broken helper.
 */
export const makeRepoMidRebase = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail daemon rebase "));
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
    // Expected: the rebase stops on the conflict, leaving .git/rebase-merge behind. That is the
    // mid-rebase state this helper exists to produce, not an error to surface.
  }
  return dir;
};
