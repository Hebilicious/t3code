/**
 * Quadratique, read through its `quadratique` command. A scope is a project key (`QUA`), an issue
 * key its id (`QUA-12`); Quadratique says which project a folder's repository is bound to. Commands
 * run as the human, without the variables that make Quadratique record an agent.
 */
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueListState,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type LocalIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

export const KIND = IssueTrackerKind.make("quadratique");
/** Quadratique has no host of its own; this names it wherever a host is shown or keyed. */
export const HOST = "quadratique";
const COMMAND = "quadratique";
const TIMEOUT_MS = 30_000;

/**
 * The variables Quadratique reads to decide that the caller is an agent, and the T3 thread it
 * would record. Set to undefined, the spawn drops them from the inherited environment.
 */
const AGENT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  [
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT",
    "GEMINI_CLI",
    "OPENCODE",
    "AMP_CURRENT_THREAD_ID",
    "AUGMENT_AGENT",
    "QWEN_CODE_SESSION_ID",
    "PI_CODING_AGENT",
    "CRUSH",
    "COPILOT_AGENT",
    "QUADRATIQUE_ROLE",
    "QUADRATIQUE_ACTOR_FIELDS",
    "T3CODE_THREAD_ID",
  ].map((name) => [name, undefined]),
);

/**
 * Notes are comments; a status move is a state change. The rest of an issue (acceptance,
 * evidence, claims, relations) is Quadratique's own and is shown in the body, read-only here.
 */
const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

/** Quadratique refuses what the human may not do itself, with a reason, so nothing is hidden here. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: false,
  labels: false,
  assignees: false,
};

/** The account T3 Code acts as: the human, the one person Quadratique serves. */
const VIEWER = "human";

const OPEN_CATEGORIES = ["backlog", "unstarted", "started"] as const;
const CLOSED_CATEGORIES = ["completed", "canceled"] as const;

const Category = Schema.Literals([...OPEN_CATEGORIES, ...CLOSED_CATEGORIES]);
type Category = typeof Category.Type;

const Actor = Schema.Struct({ kind: Schema.String, name: Schema.String });
type Actor = typeof Actor.Type;

const Assignee = Schema.Struct({ kind: Schema.String, role: Schema.optional(Schema.String) });
type Assignee = typeof Assignee.Type;

const Claim = Schema.Struct({
  holder: Actor,
  branch: Schema.optional(Schema.String),
  since: Schema.String,
});

const Summary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  category: Category,
  labels: Schema.Array(Schema.String),
  assignee: Schema.optional(Assignee),
  claim: Schema.optional(Claim),
  revision: Schema.Number,
  updatedAt: Schema.String,
});
type Summary = typeof Summary.Type;

const Issue = Schema.Struct({
  ...Summary.fields,
  description: Schema.optional(Schema.String),
  acceptance: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.String),
  blockedBy: Schema.Array(Schema.String),
  notes: Schema.Array(
    Schema.Struct({ text: Schema.String, author: Schema.String, at: Schema.String }),
  ),
  createdAt: Schema.String,
  createdBy: Actor,
});
type Issue = typeof Issue.Type;

const ListAnswer = Schema.Struct({
  items: Schema.Array(Summary),
  nextCursor: Schema.optional(Schema.String),
});
const IssueAnswer = Schema.Struct({ issue: Issue });

const WorkflowStatus = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  category: Category,
});
type WorkflowStatus = typeof WorkflowStatus.Type;
const ProjectList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      workflow: Schema.Struct({ statuses: Schema.Array(WorkflowStatus) }),
    }),
  ),
});
const Instructions = Schema.Struct({ project: Schema.optional(Schema.String) });
const UiAnswer = Schema.Struct({ url: Schema.String });
/** Every refusal names itself by `_tag` on standard output. */
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
);

/** What each refusal means for someone reading T3 Code rather than the command's reference. */
const REFUSAL_DETAIL: Record<string, string> = {
  Stale: "The issue changed while it was being updated. Try again.",
  HumanOnly: "Only the human can do this.",
  Held: "An agent holds this issue; only it or the human can move it.",
  UnknownStatus: "The project's workflow has no such status.",
  BaseNotMerged: "An issue this one is stacked on is not merged yet.",
};

function toState(status: string, category: Category, workflow: ReadonlyArray<WorkflowStatus>) {
  const name = workflow.find((each) => each.key === status)?.name ?? status;
  const state: IssueState =
    category === "completed" || category === "canceled"
      ? { category: "closed", name, closeReason: category }
      : { category: "open", name };
  return state;
}

function toActor(actor: Actor): IssueActor {
  return { login: actor.name, name: actor.name, avatarUrl: null, isBot: actor.kind !== "human" };
}

/** The human is `human`; agents of one role are `role:<role>`, as Quadratique writes filters. */
function assigneeLogin(assignee: Assignee): string {
  return assignee.kind === "human" ? VIEWER : `role:${assignee.role ?? "agent"}`;
}

function assigneeFilter(login: string): string {
  return JSON.stringify(
    login.startsWith("role:")
      ? { kind: "agent", role: login.slice("role:".length) }
      : { kind: "human" },
  );
}

/** The parts of an issue T3 Code has no field for, as markdown under the description. */
function bodyOf(issue: Issue): string {
  const sections = [issue.description ?? ""];
  if (issue.acceptance !== undefined) sections.push(`## Acceptance\n\n${issue.acceptance}`);
  if (issue.evidence !== undefined) sections.push(`## Evidence\n\n${issue.evidence}`);
  if (issue.claim !== undefined) {
    const branch = issue.claim.branch === undefined ? "" : ` on \`${issue.claim.branch}\``;
    sections.push(`Claimed by **${issue.claim.holder.name}**${branch} since ${issue.claim.since}.`);
  }
  if (issue.blockedBy.length > 0) sections.push(`Blocked by ${issue.blockedBy.join(", ")}.`);
  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

function categoriesOf(state: IssueListState): ReadonlyArray<Category> {
  if (state === "open") return OPEN_CATEGORIES;
  if (state === "closed") return CLOSED_CATEGORIES;
  return [];
}

export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  const fail = (
    operation: string,
    reason: IssueTrackerError["reason"],
    detail: string,
    cause?: unknown,
  ) => new IssueTrackerError({ tracker: KIND, operation, reason, detail, cause });

  /** Runs one command and decodes its answer; a refusal becomes the tracker's error. */
  const run = <A>(
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    answer: Schema.Codec<A, unknown>,
  ) =>
    process
      .run({
        operation: `quadratique.${operation}`,
        command: COMMAND,
        args: [...args, "--json"],
        cwd,
        env: AGENT_ENV,
        allowNonZeroExit: true,
        timeoutMs: TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "VcsProcessSpawnError"
            ? fail(operation, "missing-tool", "Quadratique is not installed.", cause)
            : fail(operation, "failed", "Quadratique did not answer.", cause),
        ),
        Effect.flatMap((output) =>
          output.exitCode === 0
            ? Schema.decodeEffect(Schema.fromJsonString(answer))(output.stdout).pipe(
                Effect.mapError((cause) =>
                  fail(
                    operation,
                    "failed",
                    "Quadratique gave an answer T3 Code cannot read.",
                    cause,
                  ),
                ),
              )
            : Effect.fail(refusalOf(operation, output.stdout, output.stderr)),
        ),
      );

  /** Quadratique names a refusal by `_tag` on standard output; anything else is its stderr. */
  const refusalOf = (operation: string, stdout: string, stderr: string) => {
    const refusal = decodeRefusal(stdout);
    if (Option.isNone(refusal)) {
      return fail(operation, "failed", stderr.trim() || "Quadratique refused the request.");
    }
    const tag = refusal.value._tag;
    if (tag === "NotFound") return fail(operation, "not-found", "No such issue.");
    return fail(operation, "failed", REFUSAL_DETAIL[tag] ?? `Quadratique refused: ${tag}.`);
  };

  // Workflows and the web app's address change rarely; a listing reads them for every row.
  const workflows = yield* Cache.makeWith(
    (cwd: string) =>
      run("projectList", cwd, ["project", "list"], ProjectList).pipe(
        Effect.map(
          (list) => new Map(list.items.map((project) => [project.key, project.workflow.statuses])),
        ),
      ),
    {
      capacity: 16,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
    },
  );
  const workflowOf = (cwd: string, project: string) =>
    Cache.get(workflows, cwd).pipe(Effect.map((all) => all.get(project) ?? []));

  // The server's port changes when it restarts, so its address is read again each minute.
  const webApps = yield* Cache.makeWith(
    (cwd: string) => run("ui", cwd, ["ui"], UiAnswer).pipe(Effect.map((ui) => new URL(ui.url))),
    {
      capacity: 16,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
    },
  );
  const issueUrl = (cwd: string, key: string) =>
    Cache.get(webApps, cwd).pipe(
      Effect.map((base) => new URL(`/issues/${encodeURIComponent(key)}`, base).toString()),
    );

  const scopes = yield* Cache.makeWith(
    (cwd: string) =>
      run("detectScope", cwd, ["workspace", "instructions"], Instructions).pipe(
        Effect.map((answer) => answer.project ?? null),
        Effect.orElseSucceed(() => null),
      ),
    { capacity: 256, timeToLive: () => Duration.minutes(1) },
  );

  const toSummary = (
    cwd: string,
    project: string,
    item: Summary,
    extra: {
      readonly createdAt?: string;
      readonly author?: IssueActor | null;
      readonly commentCount?: number;
    } = {},
  ) =>
    Effect.all([workflowOf(cwd, project), issueUrl(cwd, item.id)]).pipe(
      Effect.map(([workflow, url]): TrackerIssueSummary => {
        const state = toState(item.status, item.category, workflow);
        return {
          key: item.id,
          displayKey: item.id,
          title: item.title,
          url,
          author: extra.author ?? null,
          state,
          // A listing carries no creation time; the last change stands in for it.
          createdAt: extra.createdAt ?? item.updatedAt,
          updatedAt: item.updatedAt,
          closedAt: state.category === "closed" ? item.updatedAt : null,
          assignees:
            item.assignee === undefined
              ? []
              : [{ login: assigneeLogin(item.assignee), name: null, avatarUrl: null }],
          labels: item.labels.map((name) => ({ name, color: null })),
          commentCount: extra.commentCount ?? 0,
        };
      }),
    );

  const getIssue = (cwd: string, scope: string, key: string) =>
    run("getIssue", cwd, ["issue", "get", "--issue", key], IssueAnswer).pipe(
      Effect.map((answer) => answer.issue),
      Effect.filterOrFail(
        // A key from a client may name another project's issue; it is not this scope's.
        (issue) => issue.id.split("-")[0]?.toUpperCase() === scope.toUpperCase(),
        () => fail("getIssue", "not-found", "No such issue in this project."),
      ),
    );

  const listIssues: LocalIssueTrackerApi["listIssues"] = (input) => {
    if (input.involvement === "authored" || input.involvement === "mentioned") {
      // Quadratique files issues for agents; nobody is mentioned, and a listing names no author.
      return Effect.succeed({ items: [], nextCursor: null });
    }
    const assignee = involvementAssignee(input) ?? input.assignee;
    const args = [
      "issue",
      "list",
      "--project",
      input.scope,
      "--limit",
      String(input.limit),
      ...categoriesOf(input.state).flatMap((category) => ["--category", category]),
      ...(input.labels ?? []).flatMap((label) => ["--labels", label]),
      ...(assignee === undefined ? [] : ["--assignee", assigneeFilter(assignee)]),
      ...(input.query === undefined ? [] : ["--text", input.query]),
      ...(input.cursor === undefined ? [] : ["--cursor", input.cursor]),
    ];
    return Effect.gen(function* () {
      if (input.refresh === true) {
        yield* Cache.invalidate(workflows, input.cwd);
        yield* Cache.invalidate(webApps, input.cwd);
      }
      const page = yield* run("listIssues", input.cwd, args, ListAnswer);
      const items = yield* Effect.forEach(page.items, (item) =>
        toSummary(input.cwd, input.scope, item),
      );
      return { items, nextCursor: page.nextCursor ?? null };
    });
  };

  return {
    kind: KIND,
    capabilities: CAPABILITIES,
    localHost: HOST,
    detectScope: (cwd) => Cache.get(scopes, cwd),
    getViewer: () => Effect.succeed(VIEWER),
    listIssues,
    getIssue: Effect.fn("QuadratiqueIssueTracker.getIssue")(function* (input) {
      const issue = yield* getIssue(input.cwd, input.scope, input.key);
      const summary = yield* toSummary(input.cwd, input.scope, issue, {
        createdAt: issue.createdAt,
        author: toActor(issue.createdBy),
        commentCount: issue.notes.length,
      });
      const workflow = yield* workflowOf(input.cwd, input.scope);
      const comments = issue.notes.map((note, index): IssueComment => ({
        id: `${issue.id}#${index}`,
        author: { login: note.author, name: note.author, avatarUrl: null },
        body: note.text,
        createdAt: note.at,
        url: null,
      }));
      return {
        ...summary,
        body: bodyOf(issue),
        viewer: VIEWER,
        viewerPermissions: VIEWER_PERMISSIONS,
        states: workflow.map((status) => toState(status.key, status.category, workflow)),
        comments,
        commentsCursor: null,
        events: [],
        linkedPullRequests: [],
      };
    }),
    // Quadratique gives the last 50 notes with the issue and no older page.
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    comment: (input) =>
      getIssue(input.cwd, input.scope, input.key).pipe(
        Effect.flatMap((issue) =>
          run(
            "comment",
            input.cwd,
            [
              "issue",
              "update",
              "--issue",
              issue.id,
              "--revision",
              String(issue.revision),
              "--notes",
              input.body,
            ],
            IssueAnswer,
          ),
        ),
        Effect.asVoid,
      ),
    setState: Effect.fn("QuadratiqueIssueTracker.setState")(function* (input) {
      const issue = yield* getIssue(input.cwd, input.scope, input.key);
      const workflow = yield* workflowOf(input.cwd, input.scope);
      const status = workflow.find((each) => each.name === input.state);
      if (status === undefined) {
        return yield* fail(
          "setState",
          "failed",
          `The project's workflow has no status ${input.state}.`,
        );
      }
      yield* run(
        "setState",
        input.cwd,
        [
          "issue",
          "update",
          "--issue",
          issue.id,
          "--revision",
          String(issue.revision),
          "--status",
          status.key,
        ],
        IssueAnswer,
      );
    }),
  } satisfies LocalIssueTrackerApi;
});

/** The assignee an involvement asks for: only `assigned` narrows, to the human. */
function involvementAssignee(filter: IssueInvolvementFilter): string | undefined {
  return filter.involvement === "assigned" ? VIEWER : undefined;
}
