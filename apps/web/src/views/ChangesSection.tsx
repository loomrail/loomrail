import { useState } from "react";
import type { ChangedFile } from "@loomrail/contracts";
import { Badge, Icon, InspectorSection } from "@loomrail/ui";

import { changeStatusLabelKeys, changeStatusTones, changesRefusalKey } from "../changesView";
import { useI18n } from "../i18n";
import type { Translator } from "../i18n";
import { useWorkItemChanges, useWorkItemFileDiff } from "../workspace";

/**
 * What the row says about one file, shared by the two shapes a row can take.
 *
 * A binary file's row is a plain `<div>` and a text file's row is a `<button>` that expands it, and
 * the only difference between them is that -- so the contents are written once here rather than
 * twice, where the two could drift into naming the same file differently.
 */
const ChangedFileRow = ({ file, t }: { file: ChangedFile; t: Translator }): React.JSX.Element => (
  <span className="changes-row">
    <span className="changes-row__head">
      <Badge tone={changeStatusTones[file.status]}>{t(changeStatusLabelKeys[file.status])}</Badge>
      <code className="changes-row__path">{file.path}</code>
    </span>
    <span className="changes-row__meta">
      {/* Spec §10.4: a rename is one file that moved, not a deletion plus an addition, and the row
          is only telling the truth about it if the name it moved from is on screen too. */}
      {file.previousPath === null ? null : (
        <span className="changes-row__previous">{t("changes.renamedFrom", { path: file.previousPath })}</span>
      )}
      {/* Named binary rather than shown as an empty diff (spec D8), and shown INSTEAD of line
          counts rather than beside them: git reports no line counts for a binary file, its
          `insertions`/`deletions` are null, and printing `+0 −0` would read as "nothing changed in
          it". The counts below are rendered only when both are really there, for that same reason
          -- there is no zero to fall back on. */}
      {file.binary ? <Badge tone="neutral">{t("changes.binary")}</Badge> : null}
      {file.insertions === null || file.deletions === null ? null : (
        <span
          aria-label={t("changes.lineCounts", {
            insertions: file.insertions,
            deletions: file.deletions,
          })}
          className="changes-row__counts"
        >
          <span className="changes-row__insertions">+{file.insertions}</span>
          <span className="changes-row__deletions">&minus;{file.deletions}</span>
        </span>
      )}
    </span>
  </span>
);

/**
 * The body of the one file the owner expanded.
 *
 * A component of its own so that the query lives and dies with the disclosure: a body is fetched
 * when this mounts and never before, which is what keeps the file list free of the cost of the
 * patches it lists (spec D5). It is also what makes the reread on a stage event cost one body
 * rather than all of them -- only the mounted query is active for the event channel to refetch
 * (spec D6).
 *
 * The patch is printed as preformatted text and nothing else. Colouring each line would mean one
 * element per line, and this diff is capped at 512 KiB rather than at a number of lines -- a
 * generated file at that cap is tens of thousands of elements for an effect the leading `+` and `-`
 * of a unified diff already carry. Side-by-side and syntax highlighting are named non-goals of this
 * milestone (spec §11).
 */
const ExpandedFileDiff = ({ path, workItemId }: { path: string; workItemId: string }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const diffQuery = useWorkItemFileDiff(workItemId, path);

  if (diffQuery.error) {
    return (
      <p className="changes-diff__note" role="status">
        {t(changesRefusalKey(diffQuery.error))}
      </p>
    );
  }

  if (diffQuery.isPending) {
    return (
      <p className="changes-diff__note" role="status">
        {t("changes.diffPending")}
      </p>
    );
  }

  const diff = diffQuery.data.diff;
  if (diff === null) {
    // The handle answers `null` for a work item with no workspace, and the list this row belongs to
    // could only have been drawn from a workspace that existed a moment ago -- so reaching here
    // means it stopped existing between the two reads. Saying so beats a spinner that never ends.
    return (
      <p className="changes-diff__note" role="status">
        {t("changes.diffUnavailable")}
      </p>
    );
  }

  // `patch === null` and `binary` are the same fact from the two sides of the contract, and either
  // one is enough: there is no text to print, and printing "" would read as a real but empty diff.
  if (diff.binary || diff.patch === null) {
    return <p className="changes-diff__note">{t("changes.binaryNoPatch")}</p>;
  }

  return (
    <div className="changes-diff">
      <pre className="changes-diff__patch">
        <code>{diff.patch}</code>
      </pre>
      {/* Spec D8: a body that was cut says so where the owner is reading it. Silent truncation
          turns "there are another two hundred lines" into "that is all of it". */}
      {diff.truncated ? (
        <p className="changes-diff__note">
          {t("changes.patchTruncated", { bytes: diff.omittedBytes.toLocaleString(locale) })}
        </p>
      ) : null}
    </div>
  );
};

/**
 * The files this work item's agent changed, and the diff inside the one the owner expanded
 * (spec §9).
 *
 * Renders nothing at all -- no heading, no shell -- for a work item with no workspace, which is
 * every prose-only stage and every item before its first code stage. That is the same decision
 * `WorkspacePanel` makes next to it and for the same reason: a heading standing over a blank reads
 * as a panel that failed to load rather than as an absence.
 *
 * A refusal, on the other hand, is shown. "Loomrail could not read this" and "there is nothing to
 * read" are different pieces of news, and collapsing the first into the second would make an
 * unreadable worktree look like an idle one (spec D7).
 *
 * The section is keyed by work item at the call site, so `expandedPath` cannot survive a switch to
 * a different task and reopen a same-named file the owner never asked about.
 */
export const ChangesSection = ({ workItemId }: { workItemId: string }): React.JSX.Element | null => {
  const { t } = useI18n();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const changesQuery = useWorkItemChanges(workItemId);

  if (changesQuery.error) {
    return (
      <InspectorSection title={t("changes.title")}>
        <p className="changes__refusal" role="status">
          {t(changesRefusalKey(changesQuery.error))}
        </p>
      </InspectorSection>
    );
  }

  // Pending and "no workspace" both render nothing, deliberately: while the read is in flight there
  // is no honest answer to show, and an empty section that later fills in would move everything
  // below it on the page.
  const summary = changesQuery.data?.changes ?? null;
  if (summary === null) return null;

  return (
    <InspectorSection title={t("changes.title")}>
      {summary.files.length === 0 ? (
        // An empty list is a statement about the world -- the worktree is unchanged -- and never
        // the residue of a read that failed, because that arrives as the refusal above (spec D7).
        <p className="inspector-copy">{t("changes.empty")}</p>
      ) : (
        <div className="changes">
          {/* Spec D8 again, for the list rather than a body: the owner is looking at the first N of
              more, and has to be told before they conclude the rest was never changed. */}
          {summary.truncated ? (
            <p className="changes__note">{t("changes.truncated", { count: summary.files.length })}</p>
          ) : null}
          <ul className="changes-list">
            {summary.files.map((file) => {
              const expanded = expandedPath === file.path;
              return (
                <li className="changes-list__item" key={file.path}>
                  {file.binary ? (
                    // No control at all, rather than one that opens onto "there is no diff": the
                    // row already says the file is binary, and a disclosure that can only ever
                    // disclose that sentence is a button that does nothing.
                    <div className="changes-list__row">
                      <ChangedFileRow file={file} t={t} />
                    </div>
                  ) : (
                    <button
                      aria-expanded={expanded}
                      className="changes-list__row changes-list__toggle"
                      onClick={() => {
                        setExpandedPath(expanded ? null : file.path);
                      }}
                      type="button"
                    >
                      {/* Decorative: `aria-expanded` above already tells assistive tech the state,
                          and the row's own text is its accessible name. This is the only sign a
                          sighted reader has that the row opens at all. */}
                      <Icon
                        aria-hidden="true"
                        className="changes-list__chevron"
                        name={expanded ? "chevronDown" : "chevronRight"}
                        size={12}
                      />
                      <ChangedFileRow file={file} t={t} />
                    </button>
                  )}
                  {expanded ? <ExpandedFileDiff path={file.path} workItemId={workItemId} /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </InspectorSection>
  );
};
