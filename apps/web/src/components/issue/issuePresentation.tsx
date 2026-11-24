import type { IssueState, IssueTrackerKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  SquareKanbanIcon,
  TicketIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { LinearIcon, type Icon } from "~/components/Icons";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

export const IssueGlyph = { issue: CircleDotIcon } as const;

/** Name and mark per standalone or local tracker kind; one missing here falls back to its kind and a ticket. */
const STANDALONE_TRACKERS: Partial<Record<string, { providerName: string; Icon: Icon }>> = {
  linear: { providerName: "Linear", Icon: LinearIcon },
  quadratique: { providerName: "Quadratique", Icon: SquareKanbanIcon },
};

/** A git host's tracker wears the host's own icon and name; a standalone tracker wears its kind. */
export function issueTrackerPresentation(tracker: IssueTrackerKind | string) {
  if (sourceControlClients.find(tracker) !== undefined) {
    return getSourceControlPresentationForKind(tracker);
  }
  return STANDALONE_TRACKERS[tracker] ?? { providerName: tracker, Icon: TicketIcon };
}

/** A ring with a pie inside that fills as a started state moves along its workflow. */
function startedIcon(fraction: number): Icon {
  const angle = fraction * 2 * Math.PI;
  const x = 12 + 5 * Math.sin(angle);
  const y = 12 - 5 * Math.cos(angle);
  const pie =
    fraction >= 1
      ? "M12 7a5 5 0 1 1 0 10a5 5 0 1 1 0-10Z"
      : `M12 12V7A5 5 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
  const StartedIcon: Icon = (props) => (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d={pie} fill="currentColor" />
    </svg>
  );
  return StartedIcon;
}

/**
 * Started states, early to late: a quarter, a half, three quarters of the pie, each in its own
 * ink, so "in progress", "in review" and "merged" read apart at a glance.
 */
const STARTED_STEPS = [
  { Icon: startedIcon(0.25), toneClassName: "text-amber-600 dark:text-amber-300/90" },
  { Icon: startedIcon(0.5), toneClassName: "text-sky-600 dark:text-sky-300/90" },
  { Icon: startedIcon(0.75), toneClassName: "text-teal-600 dark:text-teal-300/90" },
] as const;

/** The step a started state's progress is nearest; without one, the middle. */
function startedStep(progress: number | undefined) {
  if (progress === undefined) return STARTED_STEPS[1];
  return STARTED_STEPS[Math.min(2, Math.max(0, Math.round(progress * 4) - 1))]!;
}

const MUTED_TONE = "text-zinc-500 dark:text-zinc-400/80";

/** A tracker with workflow stages draws each stage apart; one with only open and closed does not. */
function stagePresentation(state: IssueState) {
  switch (state.stage) {
    case "backlog":
      return { label: state.name, toneClassName: MUTED_TONE, Icon: CircleDashedIcon };
    case "unstarted":
      return { label: state.name, toneClassName: MUTED_TONE, Icon: CircleIcon };
    case "started":
      return { label: state.name, ...startedStep(state.progress) };
    default:
      return null;
  }
}

/**
 * Open and completed borrow the ink the pull-request states use for open and merged, so green
 * and violet mean the same thing on both pages; closed any other way than completed wears a
 * draft's grey, because work that stopped must not look like work that finished. The tracker's own state name is the label,
 * so a workflow tracker's "In Review" reads as itself.
 */
export function issueStatePresentation(state: IssueState) {
  const staged = stagePresentation(state);
  if (staged !== null) return staged;
  if (state.category === "open") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.open,
      label: state.name,
      Icon: CircleDotIcon,
    };
  }
  if (state.closeReason !== undefined && state.closeReason !== "completed") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.draft,
      label: state.name,
      Icon: CircleSlashIcon,
    };
  }
  return {
    ...PULL_REQUEST_STATE_PRESENTATION.merged,
    label: state.name,
    Icon: CircleCheckIcon,
  };
}

export function IssueStateGlyph({ state, className }: { state: IssueState; className?: string }) {
  const presentation = issueStatePresentation(state);
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}
