import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

export type WorktreeWithChanges = {
  worktreePath: string;
  baseline: string;
};

// Creates a throwaway git repository, commits a base, and then leaves in the working tree one of
// every kind of change a summary has to account for: a tracked file edited, a file created, a
// tracked file deleted, a file renamed, a binary file whose bytes changed, and an ignored build
// artifact that must stay out of the summary entirely. Returns the base commit to summarise
// against.
//
// `pkg/` is a directory holding two changed text files and one changed binary, and it is that
// mixture on purpose: asking for a directory is how a reading that answers for whatever a pathspec
// matched, rather than for the file it was asked about, gets caught calling two changed text files
// "binary, nothing to show".
//
// `nested/deep/` is a directory that does not exist in the baseline at all, so that a created file
// two levels down -- the ordinary shape of an agent's work -- is covered rather than assumed.
//
// The created file is the point of the whole exercise: `git diff <baseline>` in a working tree
// does not see it (spec §2.1), so a helper that left it out could not tell a correct
// implementation from the naive one. The binary file and the rename are here for the same reason
// one level down -- they are the two shapes `--numstat -z` encodes differently from every other
// record, and a parser is where a format assumption hides.
//
// Committer identity comes from -c flags rather than the machine's global git config, so the test
// does not depend on the settings of whoever runs it.
export const makeWorktreeWithEveryKindOfChange = async (): Promise<WorktreeWithChanges> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-changes-"));
  const commit = (message: string) =>
    execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", message], { cwd: dir });

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });

  await writeFile(join(dir, ".gitignore"), "build/\n");
  await writeFile(join(dir, "modified.txt"), "one\n");
  await writeFile(join(dir, "deleted.txt"), "gone\n");
  // Five identical lines so that moving the file, with its content untouched, scores as a 100%
  // rename under `-M` instead of as a delete plus an add.
  await writeFile(join(dir, "renamed-from.txt"), "r1\nr2\nr3\nr4\nr5\n");
  await writeFile(join(dir, "pic.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]));
  await mkdir(join(dir, "pkg"), { recursive: true });
  await writeFile(join(dir, "pkg", "a.txt"), "pkg-a\n");
  await writeFile(join(dir, "pkg", "pic2.bin"), Buffer.from([0x00, 0x7f, 0x00, 0xfe]));
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await commit("base");

  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

  // Tracked file edited: one line added, none removed.
  await writeFile(join(dir, "modified.txt"), "one\ntwo\n");

  // File created and left untracked -- what an agent does most of the time.
  await writeFile(join(dir, "added.txt"), "added\n");

  // Tracked file removed from the working copy.
  await rm(join(dir, "deleted.txt"));

  // File moved, content untouched.
  await rename(join(dir, "renamed-from.txt"), join(dir, "renamed-to.txt"));

  // Binary file whose bytes changed: git reports `-` for both line counts.
  await writeFile(join(dir, "pic.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x00, 0x20, 0x7f]));

  // A directory holding two changed text files and one changed binary.
  await writeFile(join(dir, "pkg", "a.txt"), "pkg-a\npkg-a2\n");
  await writeFile(join(dir, "pkg", "b.txt"), "pkg-b\n");
  await writeFile(join(dir, "pkg", "pic2.bin"), Buffer.from([0x00, 0x7f, 0x01, 0xfd, 0x00]));

  // A file created two levels down, in a directory the baseline does not have.
  await mkdir(join(dir, "nested", "deep"), { recursive: true });
  await writeFile(join(dir, "nested", "deep", "created.txt"), "deep\n");

  // Ignored build output, which `add -A` must leave out of the temporary index by itself.
  await mkdir(join(dir, "build"), { recursive: true });
  await writeFile(join(dir, "build", "artifact.txt"), "artifact\n");

  return { worktreePath: dir, baseline };
};

export type WorktreeWithAwkwardPaths = WorktreeWithChanges & {
  // A changed file whose name contains a tab. Legal on POSIX, and the shape that broke the whole
  // summary: `--numstat -z` writes the record `1\t0\ttab\there.txt`, which splitting on every tab
  // reads as four fields instead of three.
  tabPath: string;
  // A changed file named exactly `*`. Also legal on POSIX, and the only way to tell a pathspec
  // that git evaluates from one it takes literally: without `:(literal)`, `*` matches every
  // changed file in the worktree (probed).
  starPath: string;
  // Another changed file, so that a pathspec git evaluated instead of taking literally has
  // something to wrongly pull in.
  otherPath: string;
};

// Creates a throwaway git repository whose changed files have names that are legal and awkward:
// one with a tab in it, one that is a glob character on its own.
//
// Separate from `makeWorktreeWithEveryKindOfChange` rather than folded into it because neither
// name can be created on Windows, and CI runs this suite on windows-latest. The tests that use
// this helper skip there and say so; the fixture every other test shares stays portable.
export const makeWorktreeWithAwkwardPaths = async (): Promise<WorktreeWithAwkwardPaths> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-awkward-"));
  const tabPath = "tab\there.txt";
  const starPath = "*";
  const otherPath = "plain.txt";

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, starPath), "s1\n");
  await writeFile(join(dir, otherPath), "p1\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", "base"], { cwd: dir });

  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

  await writeFile(join(dir, starPath), "s1\ns2\n");
  await writeFile(join(dir, otherPath), "p1\np2\n");
  await writeFile(join(dir, tabPath), "t1\n");

  return { worktreePath: dir, baseline, tabPath, starPath, otherPath };
};

export type WorktreeWithBracketPath = WorktreeWithChanges & {
  // A changed file whose name contains a bracket expression: legal on every platform this suite
  // runs on, Windows included, and still a pathspec expression if git is allowed to evaluate it.
  bracketPath: string;
  // The file that bracket expression matches when git evaluates it. `a[b].txt` as a pattern is
  // "a", one character out of {b}, ".txt" -- which is `ab.txt` and not the file of that literal
  // name. Probed: `diff-index -p HEAD -- 'a[b].txt'` answers with BOTH files' patches (git matches
  // an exact name as well as a glob), while `-- ':(literal)a[b].txt'` answers with one.
  decoyPath: string;
};

// Creates a throwaway git repository holding a changed file whose name is a pathspec expression
// and a changed file that expression matches.
//
// Separate from `makeWorktreeWithAwkwardPaths` because that fixture's names (a tab, a bare `*`)
// cannot exist on Windows, where CI also runs this suite: the `:(literal)` defence needs a test
// that runs on every platform, and brackets are legal in an NTFS filename.
export const makeWorktreeWithBracketPath = async (): Promise<WorktreeWithBracketPath> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-bracket-"));
  const bracketPath = "a[b].txt";
  const decoyPath = "ab.txt";

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, bracketPath), "x1\n");
  await writeFile(join(dir, decoyPath), "y1\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", "base"], { cwd: dir });

  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

  await writeFile(join(dir, bracketPath), "x1\nx2\n");
  await writeFile(join(dir, decoyPath), "y1\ny2\n");

  return { worktreePath: dir, baseline, bracketPath, decoyPath };
};

export type WorktreeWithHostileConfig = WorktreeWithChanges & {
  // The one changed file, named in UTF-8. Non-ASCII on purpose: `core.quotepath` defaults to true,
  // so without the flag git escapes this name to octal in every path it prints.
  nonAsciiPath: string;
};

// Creates a throwaway repository whose own config is set up to change what git prints: an external
// diff driver that replaces every patch with a marker, colour forced on, rename detection turned
// off, and `core.quotepath` left explicitly at the default that escapes non-ASCII paths. Exists so
// a test can read a diff on a machine configured against it (spec D4) rather than only assert the
// argv Loomrail passes.
//
// The driver script lives outside the worktree, so that it is not itself one of the changes.
export const makeWorktreeWithHostileGitConfig = async (): Promise<WorktreeWithHostileConfig> => {
  const dir = await mkdtemp(join(tmpdir(), "loomrail-workspace-hostile-"));
  const driverDir = await mkdtemp(join(tmpdir(), "loomrail-workspace-driver-"));
  const driver = join(driverDir, "evil-diff.sh");
  const nonAsciiPath = "é-файл.txt";

  await writeFile(driver, "#!/bin/sh\necho PWNED-BY-EXTERNAL-DIFF\n", { mode: 0o755 });

  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, nonAsciiPath), "one\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", [...testCommitterArgs, "commit", "--quiet", "-m", "base"], { cwd: dir });

  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

  await writeFile(join(dir, nonAsciiPath), "one\ntwo\n");

  // `diff.external` is executed by Git's shell. Git for Windows needs its POSIX-facing path form,
  // and quoting keeps the probe valid if the temporary directory contains a space.
  const driverCommand = `"${driver.replaceAll("\\", "/")}"`;

  const hostile: readonly (readonly [string, string])[] = [
    ["diff.external", driverCommand],
    ["color.ui", "always"],
    ["color.diff", "always"],
    ["diff.renames", "false"],
    ["core.quotepath", "true"],
  ];
  for (const [key, value] of hostile) {
    await execFileAsync("git", ["config", key, value], { cwd: dir });
  }

  return { worktreePath: dir, baseline, nonAsciiPath };
};

// The owner's own `git diff` in a repository, run only so a test can show that a hostile config
// really is hostile. Asserting immunity to a config that turns out to change nothing would prove
// nothing at all.
export const readPorcelainDiff = async (dir: string, baseline: string, path: string): Promise<string> =>
  (await execFileAsync("git", ["diff", baseline, "--", path], { cwd: dir })).stdout;

// Every path a tree object holds, sorted. A test that has a tree sha in hand can say what the tree
// CONTAINS with it: 40 hex characters that are not the empty tree is a shape check, and a label of
// the right shape can still name the wrong tree -- the baseline's, say, beside a list of five
// changed files -- without either check noticing. `-z` keeps non-ASCII paths unquoted.
export const listTreePaths = async (dir: string, tree: string): Promise<readonly string[]> => {
  const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", tree], { cwd: dir });
  return stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
};
