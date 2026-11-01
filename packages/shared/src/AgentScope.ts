import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface AgentScopeShape {
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly name: string;
    readonly threadId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Terminals may survive restarts; agents must remain eligible for orphan cleanup. */
    readonly survivesRestart?: boolean | undefined;
    /**
     * Keep a shared process running after a tool OOM when supported.
     * Falls back to ordinary scope behavior on older systemd.
     */
    readonly shared?: boolean | undefined;
  }) => Effect.Effect<AgentScopeCommand>;
  readonly oomKilled: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Reaps processes left after the owning agent exits, including setsid
   * descendants outside its process group. Preserves systemd OOM diagnosis.
   */
  readonly stop: (unit: string) => Effect.Effect<void>;
  /**
   * SIGKILLs every process in the thread's own scope, which works even while
   * the kernel throttles them. Shared scopes serve other threads and are never
   * killed here. Succeeds with whether a scope was killed.
   */
  readonly kill: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Forgets the thread's scope. The session manager calls it before it opens
   * a provider session, so a scope only answers for the session that launched
   * it, even when the next session runs without one (Cursor, OpenCode).
   */
  readonly clear: (threadId: string) => Effect.Effect<void>;
}

export interface AgentScopeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The systemd scope the command runs in, for `stop`. */
  readonly unit?: string | undefined;
}

export const AgentScope = Context.Reference<AgentScopeShape>("@t3tools/shared/AgentScope", {
  defaultValue: () => ({
    wrap: ({ command, args }) => Effect.succeed({ command, args }),
    oomKilled: () => Effect.succeed(false),
    stop: () => Effect.void,
    kill: () => Effect.succeed(false),
    clear: () => Effect.void,
  }),
});

export const AgentScopeThreadId = Context.Reference<string | undefined>(
  "@t3tools/shared/AgentScope/ThreadId",
  { defaultValue: () => undefined },
);

/** Set where an adapter starts a runtime that spawns its agent later, as `AgentScopeThreadId` is. */
export const AgentScopeResourceIdentity = Context.Reference<AgentResourceIdentity | undefined>(
  "@t3tools/shared/AgentScope/ResourceIdentity",
  { defaultValue: () => undefined },
);

export const AGENT_OOM_SCORE_ADJ = 800;

export const RAISE_OOM_SCORE_LINE = `{ echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`;

const LAUNCH_SCRIPT = [RAISE_OOM_SCORE_LINE, 'exec "$@"'].join("\n");

// systemd-run needs XDG_RUNTIME_DIR to reach this user's manager.
const SCOPED_LAUNCH_SCRIPT = [
  RAISE_OOM_SCORE_LINE,
  ': "${XDG_RUNTIME_DIR:=$1}"',
  "export XDG_RUNTIME_DIR",
  "shift",
  'exec "$@"',
].join("\n");

export interface AgentSystemdScope {
  readonly systemdRun: string;
  readonly slice: string;
  readonly unit: string;
  readonly runtimeDir: string;
  readonly options: ReadonlyArray<string>;
}

const quoteShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** An executable file for launchers that take a path, not a command line, such as Playwright. */
export function agentScopeLauncherScript(launch: AgentScopeCommand): string {
  const command = [launch.command, ...launch.args].map(quoteShell).join(" ");
  return `#!/bin/sh\nexec ${command} "$@"\n`;
}

/** Exec at every step preserves the agent PID, stdio, and signals; systemd-run places it and descendants in the scope. */
export function agentScopeCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly scope?: AgentSystemdScope | undefined;
}): AgentScopeCommand {
  const { command, args, scope } = input;
  if (scope === undefined) {
    return { command: "/bin/sh", args: ["-c", LAUNCH_SCRIPT, "t3-agent", command, ...args] };
  }
  return {
    command: "/bin/sh",
    args: [
      "-c",
      SCOPED_LAUNCH_SCRIPT,
      "t3-agent",
      scope.runtimeDir,
      scope.systemdRun,
      "--user",
      "--scope",
      "--quiet",
      `--slice=${scope.slice}`,
      `--unit=${scope.unit}`,
      ...scope.options,
      "--",
      command,
      ...args,
    ],
  };
}

/** The T3 thread an agent process works for, as it appears in the agent's own telemetry. */
export interface AgentResourceIdentity {
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly environmentId?: string | undefined;
}

const OTEL_RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";

const AGENT_RESOURCE_KEYS = {
  threadId: "t3.thread_id",
  projectId: "t3.project_id",
  environmentId: "t3.environment_id",
} as const satisfies Record<keyof AgentResourceIdentity, string>;

const resourceAttributeKey = (entry: string) => {
  const key = entry.split("=", 1)[0]!.trim();
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};

/**
 * Appends the identity to the child's `OTEL_RESOURCE_ATTRIBUTES`, percent-encoded as the
 * specification requires. Inherited attributes stay, except the identity's own keys, which a
 * server launched from another thread's agent would otherwise pass on. `inherited` is the value
 * the child gets when `env` only overlays the server's environment.
 */
export function withAgentResourceAttributes(
  env: NodeJS.ProcessEnv,
  identity: AgentResourceIdentity | undefined,
  inherited: string | undefined = env[OTEL_RESOURCE_ATTRIBUTES],
): NodeJS.ProcessEnv {
  const attributes = Object.entries(AGENT_RESOURCE_KEYS).flatMap(([field, key]) => {
    const value = identity?.[field as keyof AgentResourceIdentity];
    return value ? [`${key}=${encodeURIComponent(value)}`] : [];
  });
  if (attributes.length === 0) return env;
  const replaced = new Set<string>(Object.values(AGENT_RESOURCE_KEYS));
  const kept = (inherited ?? "")
    .split(",")
    .filter((entry) => entry.trim() !== "" && !replaced.has(resourceAttributeKey(entry)));
  return { ...env, [OTEL_RESOURCE_ATTRIBUTES]: [...kept, ...attributes].join(",") };
}
