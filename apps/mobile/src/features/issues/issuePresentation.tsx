import { useAtomValue } from "@effect/atom-react";
import { issueWriteAccess } from "@t3tools/client-runtime/issue-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { IssueDetail, IssueLabel, IssueState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";
import { View } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { m, type MessageResolver } from "../../i18n/messages";
import { issueEnvironment } from "../../state/issues";
import { ENVIRONMENT_REQUEST_INTERRUPTED } from "../../state/query";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";
import { issueTarget, type IssueParams } from "./issueParams";

const STARTED_STEPS = [
  { tint: "accent-adaptive-amber-700-300", text: "text-adaptive-amber-700-300" },
  { tint: "accent-adaptive-sky-600-400", text: "text-adaptive-sky-600-400" },
  { tint: "accent-adaptive-teal-600-400", text: "text-adaptive-teal-600-400" },
] as const;

/** The step a started state's progress is nearest, 0 to 2; without one, the middle. */
function startedStep(progress: number | undefined): number {
  return progress === undefined ? 1 : Math.min(2, Math.max(0, Math.round(progress * 4) - 1));
}

// Open and completed wear the pull request colors for open and merged; closed any other way
// than completed is grey, because work that stopped must not look like work that finished.
export function issueStatus(state: IssueState): {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly tint: string;
  readonly text: string;
} {
  const label = state.name;
  // A tracker with workflow stages draws each apart, like the web: a dashed ring for the backlog,
  // a ring for work not started, and a dot that turns amber, sky, then teal along the started ones.
  if (state.stage === "backlog")
    return {
      label,
      icon: "circle.dashed",
      tint: "accent-icon-muted",
      text: "text-foreground-muted",
    };
  if (state.stage === "unstarted")
    return { label, icon: "circle", tint: "accent-icon-muted", text: "text-foreground-muted" };
  if (state.stage === "started") {
    const step = STARTED_STEPS[startedStep(state.progress)]!;
    return { label, icon: "circle.inset.filled", ...step };
  }
  if (state.category === "open")
    return {
      label,
      icon: "git.issue",
      tint: "accent-adaptive-emerald-600-400",
      text: "text-adaptive-emerald-600-400",
    };
  if (state.closeReason !== undefined && state.closeReason !== "completed")
    return {
      label,
      icon: "slash.circle",
      tint: "accent-icon-muted",
      text: "text-foreground-muted",
    };
  return {
    label,
    icon: "checkmark.circle",
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
  };
}

/** What this device may do to the issue, and the first thing in the way when it may not. */
export function useIssueAccess(params: IssueParams, detail: IssueDetail | null | undefined) {
  const messages = useMessages();
  const connected = usePullRequestConnected(params.environmentId);
  const canWrite = useAtomValue(
    issueEnvironment.update.permissionAtom(issueTarget(params).environmentId),
  );
  if (!detail) return null;
  const access = issueWriteAccess(detail, connected && canWrite, messages);
  return {
    ...access,
    blocked: connected
      ? canWrite
        ? access.blocked
        : messages(msg("This device isn't allowed to change source control on this environment."))
      : messages(msg("Reconnect to make changes.")),
  };
}

export function issueCommandError(
  result: AsyncResult.AsyncResult<unknown, unknown>,
  resolve: MessageResolver = m,
) {
  if (!AsyncResult.isFailure(result)) return null;
  if (isAtomCommandInterrupted(result)) return resolve(ENVIRONMENT_REQUEST_INTERRUPTED);
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : resolve(msg("The tracker refused it."));
}

export function IssueLabelPill({ label }: { readonly label: IssueLabel }) {
  const color = pullRequestLabelColor(label.color);
  return (
    <View
      className="max-w-full flex-row items-center gap-1.5 rounded-2xl bg-grouped-card px-3 py-1"
      style={color ? { backgroundColor: `${color}20` } : undefined}
    >
      {color ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      ) : null}
      <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
        {label.name}
      </Text>
    </View>
  );
}
