"""Run the pinned wrangler (`npx --no-install wrangler <args>`) for the RosterWarden app with the Cloudflare
credentials from Guardian's .env (CLOUDFLARE_API_TOKEN), so the token is never typed, printed or stored here.

    npm ci                       (once, and after package-lock.json changes: installs the pinned wrangler)
    python wr.py deploy          (publishes the app to rosterwarden.sixthdaystudios.com)
    python wr.py deploy --force  (publishes even when the checks below fail)

A deploy only goes ahead from a clean checkout of main whose tests pass, so what goes live is always
something committed and tested. The sync worker in worker/ is deployed separately, from that folder.
"""
import os
import shutil
import subprocess
import sys

ENV_FILE = r"Y:\Guardian\.env"
ACCOUNT_ID = "257d47d170c46772026c2f5ae2562514"   # same account as sixthdaystudios.com (not a secret)

# Exactly what the app needs, and nothing else (no sync worker, tests or tooling).
APP_FILES = ["index.html", "manifest.webmanifest", "sw.js", "_headers", "css", "js", "icons"]
HERE = os.path.dirname(os.path.abspath(__file__))

# The test run a deploy waits on: the whole suite, as the README gives it.
TEST_COMMAND = ["node", "--test", "tests/*.mjs"]


def stage_app():
    """Copy the app's own files into dist/, fresh each time, for wrangler to publish."""
    dist = os.path.join(HERE, "dist")
    shutil.rmtree(dist, ignore_errors=True)
    os.makedirs(dist)
    for name in APP_FILES:
        src = os.path.join(HERE, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(dist, name))
        else:
            shutil.copy2(src, dist)


def deploy_problems(run=subprocess.run, out=sys.stderr):
    """List why this checkout shouldn't go live: not on main, uncommitted changes, or failing tests.

    `run` stands in for subprocess.run, so the tests can check this without git, node or a deploy.
    An empty list means it's fine to deploy. The tests are only run once the git checks pass.
    """
    def git(*args):
        """Run one git command here and return its output (empty if git fails)."""
        done = run(["git", *args], cwd=HERE, capture_output=True, encoding="utf-8", errors="replace")
        return done.stdout if done.returncode == 0 else ""

    problems = []
    branch = git("rev-parse", "--abbrev-ref", "HEAD").strip() or "unknown"
    if branch != "main":
        problems.append(f"this checkout is on '{branch}', not main")
    changes = git("status", "--porcelain").splitlines()
    if changes:
        listed = "\n".join(f"      {line}" for line in changes[:10])
        more = f"\n      ...and {len(changes) - 10} more" if len(changes) > 10 else ""
        problems.append(f"there are uncommitted changes (commit or stash them):\n{listed}{more}")
    if problems:
        return problems

    print("Running the tests before deploying...", file=out)
    tests = run(TEST_COMMAND, cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if tests.returncode != 0:
        problems.append("the tests fail: run `node --test tests/*.mjs` to see which")
    return problems


def may_deploy(force, run=subprocess.run, out=sys.stderr):
    """Run the deploy checks and say what's wrong. True when the deploy may go ahead (or --force overrides)."""
    problems = deploy_problems(run, out)
    if not problems:
        return True
    reasons = "\n".join(f"  - {p}" for p in problems)
    if force:
        print(f"Deploying anyway (--force), although:\n{reasons}", file=out)
        return True
    print(f"Not deploying, because:\n{reasons}\n"
          "Fix that, or run `python wr.py deploy --force` to deploy anyway.", file=out)
    return False


def split_force(args):
    """Take wr.py's own --force flag out of the arguments; wrangler never sees it."""
    return [a for a in args if a != "--force"], "--force" in args


def main(argv):
    """Check (for a deploy), stage, then run the pinned wrangler with the Cloudflare credentials."""
    args, force = split_force(argv)
    if not os.path.isdir(os.path.join(HERE, "node_modules", "wrangler")):
        print("The pinned wrangler isn't installed. Run `npm ci` here first.", file=sys.stderr)
        return 1
    if args[:1] == ["deploy"]:
        if not may_deploy(force):
            return 1
        stage_app()

    from dotenv import dotenv_values   # only needed here, so the tests can import this file without it
    secrets = dotenv_values(ENV_FILE)
    env = {**os.environ, "CLOUDFLARE_API_TOKEN": secrets["CLOUDFLARE_API_TOKEN"], "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID,
           "WRANGLER_SEND_METRICS": "false"}
    # --no-install: use the wrangler pinned in package-lock.json, never fetch whatever npm has today.
    return subprocess.call(["npx", "--no-install", "wrangler", *args], env=env, shell=os.name == "nt", cwd=HERE)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
