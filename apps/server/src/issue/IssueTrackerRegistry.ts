import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as LinearDriver from "@t3tools/issue-tracker-linear/server/driver";
import * as QuadratiqueDriver from "@t3tools/issue-tracker-quadratique/server/driver";
import {
  isLocalIssueTracker,
  isStandaloneIssueTracker,
  type IssueTrackerApi,
  type LocalIssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
    /** The trackers on this machine that say themselves which projects are theirs. */
    readonly local: ReadonlyArray<LocalIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
    local: trackers.filter(isLocalIssueTracker),
  };
}

/** Trackers that are not a git host's own. Each signs requests with a credential from Settings. */
const STANDALONE_TRACKERS = [LinearDriver.make];

/** Trackers on this machine, found from a project's folder. Each runs its own command. */
const LOCAL_TRACKERS = [QuadratiqueDriver.make];

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const standalone = yield* Effect.all(STANDALONE_TRACKERS);
  const local = yield* Effect.all(LOCAL_TRACKERS);
  return fromTrackers([
    ...drivers.flatMap(({ instance }) => instance.issues ?? []),
    ...standalone,
    ...local,
  ]);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, IssueTrackerHostLive.layer)),
);
