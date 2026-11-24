import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as QuadratiqueIssueTracker from "./QuadratiqueIssueTracker.ts";

const WORKFLOW = {
  statuses: [
    { key: "todo", name: "Todo", category: "unstarted" },
    { key: "in-review", name: "In review", category: "started" },
    { key: "done", name: "Done", category: "completed" },
    { key: "canceled", name: "Canceled", category: "canceled" },
  ],
};

const summary = {
  id: "QUA-1",
  project: "QUA",
  title: "Dogfood",
  status: "in-review",
  category: "started",
  priority: 2,
  labels: ["infra"],
  assignee: { kind: "human" },
  ready: false,
  blockedBy: [],
  order: 1,
  revision: 3,
  updatedAt: "2026-11-24T17:32:01.918Z",
};

const issue = {
  ...summary,
  description: "Track the work here.",
  acceptance: "AGENTS.md has the line.",
  notes: [{ text: "Looks good.", author: "heb", at: "2026-11-24T18:00:00.000Z" }],
  relations: [],
  children: [],
  createdAt: "2026-11-24T17:30:53.825Z",
  createdBy: { kind: "agent", name: "claude-code(t3)@dogfood" },
  links: [],
};

/** Answers each command the way Quadratique does, and records what was run. */
function quadratique(
  answers: Record<string, { readonly stdout: unknown; readonly exitCode?: number }>,
) {
  const runs: SourceControlProcessInput[] = [];
  const layer = TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.sync(() => {
          runs.push(input);
          const command = input.args
            .filter((arg) => !arg.startsWith("--"))
            .slice(0, 2)
            .join(" ");
          const answer = answers[command];
          if (answer === undefined) throw new Error(`Unexpected quadratique ${command}`);
          return TestSourceControlHost.processOutput(JSON.stringify(answer.stdout), {
            exitCode: ChildProcessSpawner.ExitCode(answer.exitCode ?? 0),
          });
        }),
    },
  });
  return { runs, layer };
}

const COMMON = {
  "project list": { stdout: { items: [{ key: "QUA", workflow: WORKFLOW }] } },
  ui: { stdout: { url: "http://127.0.0.1:40089/", opened: false } },
};

const target = { cwd: "/repo", host: QuadratiqueIssueTracker.HOST, scope: "QUA" };

describe("QuadratiqueIssueTracker", () => {
  it.effect("lists a project's open issues under their workflow names, as the human", () => {
    const { runs, layer } = quadratique({
      ...COMMON,
      "issue list": { stdout: { items: [summary], nextCursor: "next" } },
    });
    return Effect.gen(function* () {
      const tracker = yield* QuadratiqueIssueTracker.make;
      const page = yield* tracker.listIssues({
        ...target,
        involvement: "assigned",
        viewer: "human",
        state: "open",
        limit: 50,
        query: "dogfood",
        sort: "updated",
      });
      expect(page).toEqual({
        nextCursor: "next",
        items: [
          expect.objectContaining({
            key: "QUA-1",
            url: "http://127.0.0.1:40089/issues/QUA-1",
            state: { category: "open", name: "In review" },
            assignees: [{ login: "human", name: null, avatarUrl: null }],
            labels: [{ name: "infra", color: null }],
          }),
        ],
      });
      const list = runs.find((run) => run.args[1] === "list")!;
      expect(list.args).toEqual([
        "issue",
        "list",
        "--project",
        "QUA",
        "--limit",
        "50",
        "--category",
        "backlog",
        "--category",
        "unstarted",
        "--category",
        "started",
        "--assignee",
        '{"kind":"human"}',
        "--text",
        "dogfood",
        "--json",
      ]);
      // Run from an agent's session, Quadratique would otherwise record an agent.
      for (const run of runs) {
        expect(run.env).toHaveProperty("CLAUDECODE", undefined);
        expect(run.env).toHaveProperty("T3CODE_THREAD_ID", undefined);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an issue with its notes and its workflow, and moves it by status name", () => {
    const { runs, layer } = quadratique({
      ...COMMON,
      "issue get": { stdout: { issue } },
      // A write answers the summary, not the whole issue.
      "issue update": { stdout: { issue: { ...summary, status: "done", category: "completed" } } },
    });
    return Effect.gen(function* () {
      const tracker = yield* QuadratiqueIssueTracker.make;
      const detail = yield* tracker.getIssue({ ...target, key: "QUA-1" });
      expect(detail).toMatchObject({
        author: { login: "claude-code(t3)@dogfood", isBot: true },
        createdAt: "2026-11-24T17:30:53.825Z",
        commentCount: 1,
        comments: [{ author: { login: "heb" }, body: "Looks good." }],
        body: "Track the work here.\n\n## Acceptance\n\nAGENTS.md has the line.",
      });
      expect(detail.states.map((state) => state.name)).toEqual([
        "Todo",
        "In review",
        "Done",
        "Canceled",
      ]);
      expect(detail.states[3]).toEqual({
        category: "closed",
        name: "Canceled",
        closeReason: "canceled",
      });

      yield* tracker.setState!({ ...target, key: "QUA-1", state: "Done" });
      expect(runs.at(-1)!.args).toEqual([
        "issue",
        "update",
        "--issue",
        "QUA-1",
        "--revision",
        "3",
        "--status",
        "done",
        "--json",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "writes the description and acceptance back from the body, and refuses a body without acceptance",
    () => {
      const { runs, layer } = quadratique({
        ...COMMON,
        "issue get": { stdout: { issue: { ...issue, evidence: "Ran it." } } },
        "issue update": { stdout: { issue: summary } },
        "issue create": { stdout: { issue: { ...summary, id: "QUA-23" }, created: true } },
      });
      return Effect.gen(function* () {
        const tracker = yield* QuadratiqueIssueTracker.make;
        const detail = yield* tracker.getIssue({ ...target, key: "QUA-1" });
        // The body as read goes back unchanged but for the edit; evidence is not written.
        const edited = detail.body.replace(
          "AGENTS.md has the line.",
          "AGENTS.md has the line.\nCI passes.",
        );
        yield* tracker.update!({ ...target, key: "QUA-1", title: "Dogfood it", body: edited });
        expect(runs.at(-1)!.args).toEqual([
          "issue",
          "update",
          "--issue",
          "QUA-1",
          "--revision",
          "3",
          "--title",
          "Dogfood it",
          "--acceptance",
          "AGENTS.md has the line.\nCI passes.",
          "--description",
          "Track the work here.",
          "--json",
        ]);

        const refused = yield* Effect.flip(
          tracker.update!({ ...target, key: "QUA-1", body: "Only a description." }),
        );
        expect(refused.detail).toContain("## Acceptance");

        const { body } = (yield* tracker.listTemplates!()).templates[0]!;
        const created = yield* tracker.create!({
          ...target,
          title: "New",
          body: `${body}It works.`,
          labels: ["infra"],
          assignees: [],
        });
        expect(created).toEqual({
          key: "QUA-23",
          displayKey: "QUA-23",
          url: "http://127.0.0.1:40089/issues/QUA-23",
        });
        expect(runs.at(-1)!.args).toEqual([
          "issue",
          "create",
          "--project",
          "QUA",
          "--title",
          "New",
          "--acceptance",
          "- It works.",
          "--description",
          "What to do, and why.",
          "--labels",
          "infra",
          "--json",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it("splits a body into description and acceptance, ignoring the read-only sections", () => {
    expect(
      QuadratiqueIssueTracker.parseBody(
        "Why.\n\n## Acceptance\n\n- one\n- two\n\n## Evidence\n\nRan it.\n\n## Work\n\nClaimed.",
      ),
    ).toEqual({ description: "Why.", acceptance: "- one\n- two" });
    expect(QuadratiqueIssueTracker.parseBody("## Acceptance\n\n")).toEqual({
      description: "",
      acceptance: null,
    });
  });

  it.effect("refuses an issue of another project", () => {
    const { layer } = quadratique({
      ...COMMON,
      "issue get": { stdout: { issue: { ...issue, id: "VEL-1" } } },
    });
    return Effect.gen(function* () {
      const tracker = yield* QuadratiqueIssueTracker.make;
      expect(yield* Effect.flip(tracker.getIssue({ ...target, key: "VEL-1" }))).toMatchObject({
        reason: "not-found",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps a refusal to its reason", () => {
    const { layer } = quadratique({
      "issue get": { stdout: { _tag: "NotFound", kind: "issue", id: "QUA-9" }, exitCode: 1 },
    });
    return Effect.gen(function* () {
      const tracker = yield* QuadratiqueIssueTracker.make;
      expect(yield* Effect.flip(tracker.getIssue({ ...target, key: "QUA-9" }))).toMatchObject({
        reason: "not-found",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("claims no folder when Quadratique is not installed or names no project", () => {
    let installed = false;
    const layer = TestSourceControlHost.layer({
      process: {
        run: (input) =>
          installed
            ? Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify(input.cwd === "/repo" ? { project: "QUA" } : {}),
                ),
              )
            : Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  cause: new Error("ENOENT"),
                }),
              ),
      },
    });
    return Effect.gen(function* () {
      const missing = yield* QuadratiqueIssueTracker.make;
      expect(yield* missing.detectScope("/repo")).toBeNull();
      installed = true;
      const tracker = yield* QuadratiqueIssueTracker.make;
      expect(yield* tracker.detectScope("/repo")).toBe("QUA");
      expect(yield* tracker.detectScope("/elsewhere")).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});
