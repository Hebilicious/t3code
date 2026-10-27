---
name: sync-fork
description: Keep this fork (Hebilicious/t3code, branch heb) current with upstream and the same on every device. Use to update T3 to the latest upstream, to pull the fork onto another laptop, or to change one of the fork's own commits. Rebases heb onto upstream/main, verifies, restarts T3 and pushes.
---

# Sync the fork

This checkout runs Hebilicious/t3code, branch `heb`: upstream's `main` plus
a few commits of our own, one per change. Every device runs `heb` from
GitHub, so `origin/heb` is the source of truth and is always pushed.

- `origin` is the fork, `https://github.com/Hebilicious/t3code`.
- `upstream` is `https://github.com/pingdotgg/t3code`. Add it if missing:
  `git remote add upstream https://github.com/pingdotgg/t3code.git`.
- `heb` is the only local branch. Updating rewrites its history, so other
  devices reset to `origin/heb`; they never merge it.

List the fork's commits with `git log --oneline upstream/main..heb`. Keep each
commit to one change, and put a fix to a change into that change's commit.

## Run T3

`scripts/t3dev` starts the dev stack from this checkout, shared on the tailnet,
with its state in `~/.t3/userdata`. Each device links it onto its PATH once:
`ln -sf "$PWD/scripts/t3dev" ~/.local/bin/t3dev`. Start T3 with `t3dev`, or
through the device's `t3dev` systemd user unit if it has one.

## Set up a new device

Needs git, proto, sqlite3, and Tailscale signed in to the tailnet (for
`--share`).

```sh
git clone -b heb https://github.com/Hebilicious/t3code.git ~/GitHub/t3code
cd ~/GitHub/t3code
git remote add upstream https://github.com/pingdotgg/t3code.git
proto install && pnpm install
ln -sf "$PWD/scripts/t3dev" ~/.local/bin/t3dev
t3dev
```

## Before anything: match origin/heb

```sh
git fetch origin && git fetch upstream
git status -sb                      # heb...origin/heb [ahead N, behind M]
```

- Behind only: `git reset --hard origin/heb`.
- Ahead (local commits not on GitHub): these are unpublished changes. Rebase
  them onto `origin/heb` (`git rebase origin/heb`), then continue.
- Uncommitted changes: commit or stash them; never discard them without
  asking.

## Update from upstream

T3 runs from this checkout and restarts when its files change, so do the
rebase in a separate worktree and switch the checkout over in one step.

1. Rebase:

   ```sh
   git worktree add ../t3code-update heb -b heb-update
   cd ../t3code-update && git rebase upstream/main
   ```

   A conflict is usually upstream moving or restructuring the code our commit
   touched. Reapply the same change at its new place; keep the commit's scope.

2. Toolchain: compare `engines.node` and `packageManager` in `package.json`
   with `.prototools`. If upstream moved, update `.prototools` in the commit
   that adds it, then `proto install`.
3. Verify in the worktree:

   ```sh
   pnpm install --frozen-lockfile
   for d in packages/provider-core packages/provider-acp-registry apps/server; do
     (cd $d && npx tsc --noEmit)
   done
   (cd apps/server && pnpm exec vp test run src/project/AgentSessionScanner.test.ts)
   ```

   Stop and report if any of them fails.

4. Back up T3's state. `t3dev` keeps it in `~/.t3/userdata`:

   ```sh
   for db in ~/.t3/userdata/*.sqlite; do sqlite3 "$db" ".backup '$db.bak-$(date +%F)'"; done
   ```

   A database that is locked while T3 runs can be backed up after step 5
   stops T3.

5. Switch and restart. Find how T3 runs on this device:
   `systemctl --user status t3dev`, or `pgrep -af 'dev-runner.ts dev'`.

   ```sh
   # stop T3 (systemctl --user stop t3dev, or kill the dev-runner's process group)
   cd <this checkout>
   git reset --hard heb-update
   git worktree remove ../t3code-update && git branch -D heb-update
   pnpm install
   rm -rf node_modules/.vite node_modules/.vite-temp apps/web/node_modules/.vite apps/web/node_modules/.vite-temp
   # start T3 again the way it was started (t3dev, or systemctl --user start t3dev)
   ```

6. Check it works: `curl -s -o /dev/null -w '%{http_code}' <T3 URL>/.well-known/t3/environment`
   returns 200, and the app loads in a browser with the thread list.
7. Publish:

   ```sh
   git push --force-with-lease origin heb
   git push origin upstream/main:main    # keep the fork's main equal to upstream
   ```

   The fork's `main` may already be synced on GitHub ("Sync fork"); then that
   push changes nothing.

Roll back with `git reset --hard heb@{1}`, restore the `.bak-<date>`
databases, and restart T3.

## Pull the fork onto another device

```sh
git fetch origin
git status -sb                  # must show no local-only commits; see above
git reset --hard origin/heb
proto install                   # node and pnpm from .prototools
pnpm install
```

Then restart T3 there (`t3dev`). Nothing to push.

## Change one of the fork's commits

Commit the change as a fixup of the commit it belongs to, fold it in, verify
(steps 3 and 6 above) and push:

```sh
git commit --fixup=<commit>
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/main
git push --force-with-lease origin heb
```

A change that fits none of the commits gets its own commit.
