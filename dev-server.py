"""Local development server for RosterWarden.

`python -m http.server` sends no cache headers, so browsers apply heuristic
caching and keep serving stale JavaScript after an edit - which looks exactly
like a bug in the app. This serves the same files with caching switched off.

Development only. The real site is static files on GitHub Pages.

    python dev-server.py [port] [--lan]

Only this computer can reach it, unless `--lan` is given: that opens it to the local network, for trying
the app on a phone, and with it everything in this folder (including .git) to anyone on that network.
"""
from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ARGS = [a for a in sys.argv[1:] if a != "--lan"]
PORT = int(ARGS[0]) if ARGS else 8123
# "" listens on every network interface; 127.0.0.1 on this computer alone.
HOST = "" if "--lan" in sys.argv[1:] else "127.0.0.1"


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serve the project directory, telling the browser never to cache."""

    def end_headers(self) -> None:
        """Add no-store headers to every response before finishing them."""
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        """Quieten the per-request logging; only errors are worth seeing."""
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main() -> int:
    """Serve the project root until interrupted."""
    root = Path(__file__).resolve().parent
    handler = partial(NoCacheHandler, directory=str(root))
    print(f"RosterWarden dev server: http://localhost:{PORT}  (no-cache{', open to the local network' if HOST == '' else ''})")
    # Threading, not the plain HTTPServer: browsers hold keep-alive
    # connections open, and a single-threaded server blocks on the first
    # one, leaving every later request hanging.
    try:
        ThreadingHTTPServer((HOST, PORT), handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
