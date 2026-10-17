"""Top-level commands serve and open. serve runs the dashboard server on 127.0.0.1 and, unless --no-usage-loop,
the usage refresh loop in a daemon thread. open is still a stub."""

import errno
import json
import logging
import signal
import sys
import threading

from roadmap import log as rlog
from roadmap.errors import EXIT_CONFLICT, EXIT_USAGE, RoadmapError, stub
from roadmap.http import server as http_server
from roadmap.services import launchd, loader, usage, usage_accounts
from roadmap.store import config as config_store
from roadmap.store import paths

DEFAULT_PORT = 8780
# The port the legacy split-net dashboard uses. A config still on it gets a `next: roadmap doctor` hint on conflict.
LEGACY_PORT = 8765


def register(sub, common):
    """Add serve and open to the root subparsers."""
    serve = sub.add_parser("serve", parents=[common], help="run the dashboard server on 127.0.0.1")
    serve.add_argument("--port", type=int, default=None, help="listener port (default: config port, 8780)")
    serve.add_argument("--no-usage-loop", action="store_true", help="do not refresh plan usage in the background")
    serve.add_argument("--no-phone", action="store_true", help="do not start the read-only phone listener")
    serve.set_defaults(handler=run)

    from roadmap.commands import open as open_cmd
    open_cmd.register(sub, common)


def run(args):
    """Bind, start the usage loop, serve until SIGINT or SIGTERM, then shut down. Exit 4 when the port is busy."""
    cfg = config_store.load()
    port = args.port if args.port is not None else cfg.get("port", DEFAULT_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise RoadmapError("invalid_input", "port must be a whole number from 0 to 65535", EXIT_USAGE)
    try:
        httpd = http_server.make_server(port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        owner = loader.port_owner(port)
        who = "another process" if owner is None else "%s, pid %s" % (owner["name"], owner["pid"])
        next_step = "roadmap doctor" if port == LEGACY_PORT and cfg.get("port") == LEGACY_PORT else None
        raise RoadmapError("conflict", "port %d is busy (used by %s)" % (port, who), EXIT_CONFLICT, next=next_step)

    _log_to_stderr()
    rlog.setup_file_logging(paths.logs_dir())
    launchd.prepare_launchd_logs()
    bound = httpd.server_address[1]
    url = "http://127.0.0.1:%d/" % bound
    phone = None
    if not getattr(args, "no_phone", False):
        try:
            phone = http_server.make_phone_server()
        except OSError as exc:
            logging.getLogger("roadmap").warning("phone listener not started: %s", exc.strerror or "port busy")
    stop_usage = threading.Event()
    if not args.no_usage_loop:
        threading.Thread(target=usage.run_loop, args=(stop_usage,), name="usage-loop", daemon=True).start()
        # One background warm-up of the active account's identity (in memory only), so the full e-mail is back
        # after a restart without a manual Check. Runs off the request path; never delays serving.
        threading.Thread(target=usage_accounts.warm_identity, name="account-warmup", daemon=True).start()

    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "data": {"port": bound, "url": url, "usage_loop": not args.no_usage_loop}}),
              flush=True)
        args.json = False  # the start line above is the envelope; cli.main must not print a second one
    else:
        print("roadmap: serving " + url, flush=True)

    stopping = threading.Event()

    def ask_to_stop(signum, frame):
        stopping.set()

    signal.signal(signal.SIGINT, ask_to_stop)
    signal.signal(signal.SIGTERM, ask_to_stop)
    worker = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5}, name="http", daemon=True)
    worker.start()
    phone_worker = None
    if phone is not None:
        phone_worker = threading.Thread(target=phone.serve_forever, kwargs={"poll_interval": 0.5},
                                        name="phone", daemon=True)
        phone_worker.start()
    stopping.wait()
    if phone is not None:
        phone.shutdown()
        phone_worker.join(5)
        phone.server_close()
    httpd.shutdown()
    worker.join(5)
    httpd.server_close()
    stop_usage.set()
    print("roadmap: stopped", file=sys.stderr, flush=True)
    return None


def _log_to_stderr():
    """Send roadmap log lines (the access log included) to stderr at INFO, once per process."""
    logger = logging.getLogger("roadmap")
    if any(getattr(h, "roadmap_stderr", False) for h in logger.handlers):
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))
    handler.addFilter(rlog.RedactingFilter())
    handler.roadmap_stderr = True
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
