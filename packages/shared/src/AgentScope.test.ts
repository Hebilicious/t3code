// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  AGENT_OOM_SCORE_ADJ,
  agentScopeCommand,
  agentScopeLauncherScript,
  withAgentResourceAttributes,
} from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-launcher-"));
    try {
      const launcher = NodePath.join(directory, "launch's");
      NodeFS.writeFileSync(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      const launched = NodeChildProcess.spawnSync(launcher, ["--flag", "it's"], {
        encoding: "utf8",
      });
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(AGENT_OOM_SCORE_ADJ);
      expect(launchedArgs).toEqual(["a b", "$HOME", "--flag", "it's"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("withAgentResourceAttributes", () => {
  const identity = { threadId: "thread 1", projectId: "project,1", environmentId: "env=1" };
  const attributes = "t3.thread_id=thread%201,t3.project_id=project%2C1,t3.environment_id=env%3D1";

  it.each([
    { name: "nothing inherited", inherited: undefined, expected: attributes },
    {
      name: "the operator's attributes",
      inherited: "service.namespace=house,deployment.environment=home",
      expected: `service.namespace=house,deployment.environment=home,${attributes}`,
    },
    {
      name: "another thread's identity",
      inherited: "service.namespace=house, t3.thread_id=other,t3%2Eenvironment_id=old,",
      expected: `service.namespace=house,${attributes}`,
    },
  ])("appends the identity to $name", ({ inherited, expected }) => {
    expect(
      withAgentResourceAttributes(
        {
          PATH: "/bin",
          ...(inherited === undefined ? {} : { OTEL_RESOURCE_ATTRIBUTES: inherited }),
        },
        identity,
      ),
    ).toEqual({ PATH: "/bin", OTEL_RESOURCE_ATTRIBUTES: expected });
  });

  it("reads the inherited value when the environment overlays the server's", () => {
    expect(
      withAgentResourceAttributes({ FOO: "1" }, { threadId: "t" }, "service.name=server"),
    ).toEqual({ FOO: "1", OTEL_RESOURCE_ATTRIBUTES: "service.name=server,t3.thread_id=t" });
  });

  it("leaves the environment alone without an identity", () => {
    const env = { OTEL_RESOURCE_ATTRIBUTES: "t3.thread_id=kept" };
    expect(withAgentResourceAttributes(env, undefined)).toBe(env);
    expect(withAgentResourceAttributes(env, { threadId: "" })).toBe(env);
  });
});
