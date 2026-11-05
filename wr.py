"""Run `npx wrangler <args>` for the RosterWarden app with the Cloudflare credentials from
Guardian's .env (CLOUDFLARE_API_TOKEN), so the token is never typed, printed or stored here.

    python wr.py deploy          (publishes the app to rosterwarden.sixthdaystudios.com)

The sync worker in worker/ is deployed separately, from that folder.
"""
import os
import shutil
import subprocess
import sys

from dotenv import dotenv_values

ENV_FILE = r"Y:\Guardian\.env"
ACCOUNT_ID = "257d47d170c46772026c2f5ae2562514"   # same account as sixthdaystudios.com (not a secret)

# Exactly what the app needs, and nothing else (no sync worker, tests or tooling).
APP_FILES = ["index.html", "manifest.webmanifest", "sw.js", "_headers", "css", "js", "icons"]
HERE = os.path.dirname(os.path.abspath(__file__))


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


if sys.argv[1:2] == ["deploy"]:
    stage_app()

secrets = dotenv_values(ENV_FILE)
env = {**os.environ, "CLOUDFLARE_API_TOKEN": secrets["CLOUDFLARE_API_TOKEN"], "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID,
       "WRANGLER_SEND_METRICS": "false"}
sys.exit(subprocess.call(["npx", "--yes", "wrangler@4", *sys.argv[1:]], env=env, shell=os.name == "nt",
                         cwd=HERE))
