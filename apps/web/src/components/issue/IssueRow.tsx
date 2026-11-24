import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { FolderIcon, MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import {
  PullRequestLabelChip,
  PullRequestActorAvatar,
} from "../pullRequest/pullRequestPresentation";
import { IssueStateGlyph, issueTrackerPresentation } from "./issuePresentation";

export type IssueRowTarget = Pick<
  EnvironmentIssueEntry,
  "environmentId" | "projectId" | "tracker" | "host" | "scope" | "key" | "url"
>;

/** The page row in the pull-request list's shape: state glyph, then key and title over meta. */
function IssueRowImpl({
  entry,
  selected,
  showScope,
  showTracker,
  environmentLabel,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  /** Only when the list spans more than one scope, where the key alone is ambiguous. */
  showScope: boolean;
  /** Only when the list spans more than one tracker or host. */
  showTracker: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string | undefined;
  onSelect: (entry: IssueRowTarget) => void;
}) {
  const tracker = issueTrackerPresentation(entry.tracker);
  // A git host's scope is the repository, which names the project; another tracker's scope is
  // only its own key (`QUA`), so the row names the project instead.
  const projectNamed = showScope && sourceControlClients.find(entry.tracker) === undefined;
  return (
    <div
      className={cn(
        "flex items-center rounded-md [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(PULL_REQUEST_ROW_CLASS, "@container/issue-row-meta px-3 py-2.5")}
      >
        <IssueStateGlyph state={entry.state} />
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{entry.displayKey}</span>}
          title={entry.title}
          status={
            <>
              {entry.assignees.length > 0 ? (
                <span className="flex items-center -space-x-1">
                  {entry.assignees.slice(0, 3).map((assignee) => (
                    <PullRequestActorAvatar
                      key={assignee.login}
                      actor={assignee}
                      className="ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : null}
              {entry.commentCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount}
                </span>
              ) : null}
            </>
          }
          meta={
            <>
              {/* A tracker that names no author leaves it out, rather than a deleted account's "ghost". */}
              {entry.author !== null ? <PullRequestRowAuthor actor={entry.author} /> : null}
              {showTracker ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <tracker.Icon aria-hidden className="size-3" />
                  <span className="sr-only">{tracker.providerName}</span>
                </span>
              ) : null}
              {projectNamed ? (
                <span className="inline-flex min-w-0 items-center gap-1 text-foreground/80">
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{entry.projectTitle}</span>
                </span>
              ) : showScope ? (
                <span className="truncate">{entry.scope}</span>
              ) : null}
              {environmentLabel ? <span className="truncate">{environmentLabel}</span> : null}
              {entry.labels.length > 0 ? (
                <span className="hidden min-w-0 items-center gap-1 @xl/issue-row-meta:flex">
                  {entry.labels.slice(0, 3).map((label, index) => (
                    <PullRequestLabelChip key={label.name} label={label}>
                      {index === 2 && entry.labels.length > 3 ? (
                        <span className="shrink-0">+{entry.labels.length - 3}</span>
                      ) : null}
                    </PullRequestLabelChip>
                  ))}
                </span>
              ) : null}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
    </div>
  );
}

export const IssueRow = memo(IssueRowImpl);
