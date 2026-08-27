import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Creates a throwaway git repository with one committed file, then puts every category of
// uncommitted work in front of it at once: an edit to that tracked file, a brand-new file already
// staged, an untracked file at the root, an untracked file inside a subdirectory, an ignored file
// that must never be carried, and a tracked file deleted from the working copy without staging the
// deletion. Exists so a single test can assert that a carry-in snapshot picks up all of the former
// and none of the latter.
export const makeRepoWithEveryKindOfChange = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-carry-in-"));
  const commit = (message: string) =>
    execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", message], { cwd: dir });

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });

  await writeFile(join(dir, ".gitignore"), "build/\n");
  await writeFile(join(dir, "tracked-modified.txt"), "original\n");
  await writeFile(join(dir, "deleted.txt"), "will be removed\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked-modified.txt", "deleted.txt"], { cwd: dir });
  await commit("base");

  // Tracked file edited but not staged.
  await writeFile(join(dir, "tracked-modified.txt"), "changed\n");

  // New file staged but not committed.
  await writeFile(join(dir, "staged.txt"), "staged\n");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: dir });

  // Untracked file at the repository root.
  await writeFile(join(dir, "untracked-new.txt"), "new\n");

  // Untracked file inside a subdirectory.
  await mkdir(join(dir, "subdir"), { recursive: true });
  await writeFile(join(dir, "subdir", "untracked-nested.txt"), "nested\n");

  // Ignored file that must be left behind.
  await mkdir(join(dir, "build"), { recursive: true });
  await writeFile(join(dir, "build", "artifact.txt"), "artifact\n");

  // Tracked file deleted from the working copy, deletion not staged.
  await rm(join(dir, "deleted.txt"));

  return dir;
};

// Creates a throwaway git repository that has never been committed to (headCommit is null) with a
// single untracked file sitting in it -- the case a carry-in snapshot has to handle with a
// parentless `commit-tree`, since there is no HEAD to be a parent.
export const makeEmptyRepoWithUntrackedFile = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-carry-in-empty-"));
  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "untracked-new.txt"), "new\n");
  return dir;
};
