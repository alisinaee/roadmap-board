"""Usage accounts (R11.8, docs/USAGE-ACCOUNTS.md): which Claude login Helm's usage sync reads, who it belongs to, and
the switch between several logins.

An account is one Claude Code login, named by where its credentials live:

- "keychain": the default login (keychain item "Claude Code-credentials", else ~/.claude/.credentials.json or
  $CLAUDE_CONFIG_DIR). This is the implicit account "default" when the config has no list.
- "config-dir": another CLAUDE_CONFIG_DIR (a second account: `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`).
  Its keychain item is "Claude Code-credentials-<first 8 hex of sha256(dir)>" (Claude Code's rule; keychainService
  overrides it), else <dir>/.credentials.json.
- "credentials-file": one .credentials.json file only (Linux style), never the keychain.

Config (config.json): "usageAccounts": [{id, label, source, path?, keychainService?, enabled}] and
"usageActiveAccount": id. Only the active account is read by the sync. "Disconnect" sets enabled false: Helm stops
reading that login (no keychain or file read at all) and keeps it in the list; "Connect" undoes it. Neither touches
Claude Code's own login. Signing Claude Code itself in or out is `claude auth login|logout`, run by the person.

State (state dir usage-accounts.json, no secrets): per account the last endpoint reading, the last sync status and
the masked identity (masked e-mail, organisation with any e-mail masked, plan). The full e-mail is kept in memory only.

Identity comes from `claude auth status --json` (Claude Code's own command, run with the account's CLAUDE_CONFIG_DIR),
else from the credentials' subscriptionType. It runs only on an explicit check (never on a GET), and never under
unittest unless a runner is injected. Tokens are never read here except through usage_sources, never returned,
logged or stored. Every change writes one activity line (account id only) and one debug-log line.
"""

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

from roadmap.errors import EXIT_CONFLICT, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_USAGE, RoadmapError
from roadmap import log as rlog
from roadmap.log import get_logger
from roadmap.services import usage_sources
from roadmap.store import atomic, lock, paths
from roadmap.store import config as config_store

DEFAULT_ID = "default"
LIST_KEY = "usageAccounts"
ACTIVE_KEY = "usageActiveAccount"
STATE_FILE = "usage-accounts.json"
SOURCES = ("keychain", "config-dir", "credentials-file")
CREDENTIALS_NAME = ".credentials.json"
SERVICE_RE = re.compile(r"Claude Code-credentials(?:-[0-9a-f]{8})?")
LABEL_MAX = 40
MAX_ACCOUNTS = 8
STATUS_TIMEOUT_S = 15
LOGIN_GAP_S = 30
READING_FIELDS = ("weeklyPercent", "fiveHourPercent", "weeklyResetsAt", "fiveHourResetsAt", "updated", "source")
IDENTITY_FIELDS = ("loggedIn", "authMethod", "emailMasked", "orgName", "plan", "checkedAt", "via")
# Status of one account in the list.
ST_OK = "ok"                      # the last sync read this login
ST_EXPIRED = "expired"            # the login token has expired (use Claude Code once, or log in again)
ST_SIGNED_OUT = "signed_out"      # no Claude Code login at this place
ST_DENIED = "denied"              # the keychain refused
ST_ERROR = "error"                # network or endpoint failure
ST_DISCONNECTED = "disconnected"  # Helm does not read this login (the person disconnected it)
ST_IDLE = "idle"                  # connected but not active: not read live, the last reading is kept
ST_UNKNOWN = "unknown"            # active, never synced yet
_CODE_STATUS = {"no_item": ST_SIGNED_OUT, "no_token": ST_SIGNED_OUT, "expired": ST_EXPIRED, "denied": ST_DENIED,
                "net": ST_ERROR, "other": ST_ERROR}
_EMAIL = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

log = get_logger("services.usage_accounts")
_memory = {}            # account id -> full e-mail from the last check (never written to disk)
_memory_lock = threading.Lock()
_last_login = {"at": 0.0}


# ---------------------------------------------------------------- small helpers

def mask_email(text):
    """a***@gmail.com for every e-mail address in text; None stays None."""
    if not isinstance(text, str):
        return None
    return _EMAIL.sub(lambda m: m.group(1) + "***@" + m.group(2), text)


def _now_iso(now=None):
    return (now or datetime.now().astimezone()).isoformat(timespec="seconds")


def _bad(message):
    return RoadmapError("invalid_input", message, EXIT_USAGE)


def _home_short(path):
    home = os.path.expanduser("~")
    if isinstance(path, str) and (path == home or path.startswith(home + os.sep)):
        return "~" + path[len(home):]
    return path


def default_account():
    return {"id": DEFAULT_ID, "label": "Claude Code", "source": "keychain", "enabled": True}


def _normalise(entry):
    if not isinstance(entry, dict) or not paths.valid_id(entry.get("id")):
        return None
    source = entry.get("source") if entry.get("source") in SOURCES else None
    if source is None:
        return None
    out = {"id": entry["id"], "label": str(entry.get("label") or entry["id"])[:LABEL_MAX], "source": source,
           "enabled": entry.get("enabled") is not False}
    if source != "keychain":
        if not isinstance(entry.get("path"), str) or not os.path.isabs(entry["path"]):
            return None
        out["path"] = entry["path"]
    if isinstance(entry.get("keychainService"), str) and SERVICE_RE.fullmatch(entry["keychainService"]):
        out["keychainService"] = entry["keychainService"]
    return out


def accounts(cfg=None):
    """The configured accounts, normalised. No list (or an empty one) gives the implicit default account."""
    cfg = cfg if cfg is not None else config_store.load()
    raw = cfg.get(LIST_KEY) if isinstance(cfg, dict) else None
    out = [a for a in (_normalise(e) for e in (raw if isinstance(raw, list) else [])) if a is not None]
    return out or [default_account()]


def active_id(cfg=None):
    cfg = cfg if cfg is not None else config_store.load()
    ids = [a["id"] for a in accounts(cfg)]
    chosen = cfg.get(ACTIVE_KEY) if isinstance(cfg, dict) else None
    return chosen if chosen in ids else ids[0]


def _not_found(account_id):
    return RoadmapError("not_found", "no usage account '%s' (see `helm usage account list`)" % str(account_id)[:40],
                        EXIT_NOT_FOUND)


def _find(cfg, account_id):
    for account in accounts(cfg):
        if account["id"] == account_id:
            return account
    raise _not_found(account_id)


def keychain_service(account):
    """The keychain item of an account, or None when it has none (a credentials file only)."""
    if account.get("keychainService"):
        return account["keychainService"]
    if account["source"] == "keychain":
        return usage_sources.KEYCHAIN_SERVICE
    if account["source"] == "config-dir":
        return usage_sources.KEYCHAIN_SERVICE + "-" + hashlib.sha256(account["path"].encode("utf-8")).hexdigest()[:8]
    return None


def location(account):
    """The usage_sources location of an account. None for the default keychain account (the unchanged path)."""
    if account["source"] == "keychain" and not account.get("keychainService"):
        return None
    if account["source"] == "credentials-file":
        return {"service": None, "file": account["path"]}
    if account["source"] == "config-dir":
        return {"service": keychain_service(account), "file": usage_sources.credentials_file(account["path"])}
    return {"service": keychain_service(account), "file": usage_sources.credentials_file()}


def config_dir_of(account):
    """The CLAUDE_CONFIG_DIR that Claude Code uses for this account, or None for the default one."""
    if account["source"] == "config-dir":
        return account["path"]
    if account["source"] == "credentials-file":
        return os.path.dirname(account["path"])
    return None


def active_for_sync(cfg=None):
    """{"id", "location", "connected"} of the account the sync reads. Never raises: a broken list gives the default
    account, so the sync behaves as before R11.8."""
    try:
        cfg = cfg if cfg is not None else config_store.load()
        account = _find(cfg, active_id(cfg))
        return {"id": account["id"], "location": location(account), "connected": account["enabled"]}
    except Exception as exc:  # the sync must keep working with the old single login
        log.warning("usage accounts unreadable, using the default login: %s", type(exc).__name__)
        return {"id": DEFAULT_ID, "location": None, "connected": True}


# ---------------------------------------------------------------- state file (no secrets)

def state_path():
    return os.path.join(paths.state_dir(), STATE_FILE)


def _read_state():
    try:
        data = atomic.read_json(state_path(), default={}) if os.path.isfile(state_path()) else {}
    except Exception:
        data = {}
    accounts_state = data.get("accounts") if isinstance(data, dict) else None
    return {"schemaVersion": 1, "accounts": accounts_state if isinstance(accounts_state, dict) else {}}


def _update_state(account_id, changes):
    """Merge changes into one account's state under the state-directory lock. Never raises."""
    try:
        folder = paths.ensure_dir(paths.state_dir())
        with lock.locked(folder):
            data = _read_state()
            entry = dict(data["accounts"].get(account_id) or {})
            entry.update(changes)
            data["accounts"][account_id] = entry
            atomic.write_json(state_path(), data)
        return entry
    except Exception as exc:
        log.warning("usage account state not saved: %s", type(exc).__name__)
        return None


def _drop_state(account_id):
    try:
        folder = paths.ensure_dir(paths.state_dir())
        with lock.locked(folder):
            data = _read_state()
            data["accounts"].pop(account_id, None)
            atomic.write_json(state_path(), data)
    except Exception as exc:
        log.warning("usage account state not saved: %s", type(exc).__name__)
    with _memory_lock:
        _memory.pop(account_id, None)


def last_reading(account_id):
    """The last endpoint reading kept for an account ({} when none)."""
    entry = _read_state()["accounts"].get(account_id) or {}
    reading = entry.get("reading")
    return dict(reading) if isinstance(reading, dict) else {}


def note_reading(account_id, record, now=None):
    """The sync read this account: keep its reading and mark it ok. Called by services/usage.py. Never raises."""
    reading = {key: record.get(key) for key in READING_FIELDS} if isinstance(record, dict) else {}
    _update_state(account_id, {"reading": reading, "status": ST_OK, "reason": None, "statusAt": _now_iso(now)})


def note_failure(account_id, code, reason=None, now=None):
    """The sync could not read this account: keep the reason code (no secret in it). Never raises."""
    status = _CODE_STATUS.get(code, ST_ERROR)
    _update_state(account_id, {"status": status, "reason": (str(reason)[:200] if reason else None),
                               "statusAt": _now_iso(now)})


# ---------------------------------------------------------------- identity (`claude auth status --json`)

def claude_binary():
    """The claude CLI path, also when the service runs with launchd's short PATH. None when not found."""
    found = shutil.which("claude")
    if found:
        return found
    home = os.path.expanduser("~")
    for path in (os.path.join(home, ".local", "bin", "claude"), os.path.join(home, ".claude", "local", "claude"),
                 "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _run_status(argv, env):
    """The real runner: argv only, no shell, bounded time. Returns (exit code, stdout)."""
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=STATUS_TIMEOUT_S, env=env,
                          stdin=subprocess.DEVNULL)
    return proc.returncode, proc.stdout


def _status_env(account):
    env = dict(os.environ)
    folder = config_dir_of(account)
    if folder:
        env["CLAUDE_CONFIG_DIR"] = folder
    return env


def _identity_from_cli(account, runner):
    binary = claude_binary() if runner is _run_status else "claude"
    if not binary:
        return None
    try:
        code, out = runner([binary, "auth", "status", "--json"], _status_env(account))
        data = json.loads(out or "")
    except Exception:  # missing CLI, timeout, odd output: the next source answers
        return None
    if not isinstance(data, dict) or "loggedIn" not in data:
        return None
    email = data.get("email") if isinstance(data.get("email"), str) else None
    return {"loggedIn": data.get("loggedIn") is True, "authMethod": _short(data.get("authMethod")),
            "email": email, "emailMasked": mask_email(email), "orgName": mask_email(_short(data.get("orgName"))),
            "plan": _short(data.get("subscriptionType")), "via": "claude auth status"}


def _identity_from_credentials(account):
    """Plan only, from the stored login (no e-mail there). Reads the credentials; never the token value out."""
    try:
        oauth, _raw, _place = usage_sources.load_credentials(location(account))
    except usage_sources.SourceError:
        return {"loggedIn": False, "authMethod": None, "email": None, "emailMasked": None, "orgName": None,
                "plan": None, "via": "credentials"}
    except Exception:
        return None
    return {"loggedIn": True, "authMethod": "claude.ai", "email": None, "emailMasked": None, "orgName": None,
            "plan": _short(oauth.get("subscriptionType")), "via": "credentials"}


def _short(value):
    return _CONTROL.sub("", value)[:80] if isinstance(value, str) and value else None


def check(account_id=None, runner=None, cfg=None, now=None):
    """Read who is logged in at an account's place now and keep the masked identity. A disconnected account is not
    read (Helm promised not to). Returns the account's list row."""
    cfg = cfg if cfg is not None else config_store.load()
    account = _find(cfg, account_id or active_id(cfg))
    if account["enabled"]:
        identity = None
        if runner is not None or "unittest" not in sys.modules:
            identity = _identity_from_cli(account, runner or _run_status)
            if identity is None:
                identity = _identity_from_credentials(account)
        if identity is not None:
            with _memory_lock:
                _memory[account["id"]] = identity.pop("email", None)
            identity["checkedAt"] = _now_iso(now)
            _update_state(account["id"], {"identity": {k: identity.get(k) for k in IDENTITY_FIELDS}})
    return _row(account, cfg, _read_state()["accounts"].get(account["id"]) or {}, full_email=True, now=now)


def warm_identity():
    """Run check() once for the active account so the full e-mail is in memory after a restart, as if a person had
    clicked Check. Meant for a background thread at startup; it never raises, and the e-mail stays in memory only."""
    try:
        check()
    except RoadmapError as exc:
        log.warning("startup account check skipped: %s", exc.message)
    except Exception as exc:
        log.warning("startup account check skipped: unexpected %s", type(exc).__name__)


# ---------------------------------------------------------------- list / status

def _age_s(text, now):
    try:
        moment = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.astimezone()
    return int((now - moment).total_seconds())


def _row(account, cfg, entry, full_email, now=None):
    now = now or datetime.now(timezone.utc)
    active = account["id"] == active_id(cfg)
    if not account["enabled"]:
        status = ST_DISCONNECTED
    elif not active:
        status = ST_IDLE
    else:
        status = entry.get("status") or ST_UNKNOWN
    identity = {k: (entry.get("identity") or {}).get(k) for k in IDENTITY_FIELDS}
    if full_email:
        with _memory_lock:
            identity["email"] = _memory.get(account["id"])
    reading = entry.get("reading") if isinstance(entry.get("reading"), dict) else {}
    reading = {k: reading.get(k) for k in READING_FIELDS}
    reading["ageS"] = _age_s(reading.get("updated"), now)
    folder = config_dir_of(account)
    return {
        "id": account["id"], "label": account["label"], "source": account["source"],
        "path": _home_short(account.get("path")), "enabled": account["enabled"], "active": active,
        "live": active and account["enabled"], "status": status, "reason": entry.get("reason"),
        "statusAt": entry.get("statusAt"), "identity": identity, "reading": reading,
        "login": login_command(folder), "logout": logout_command(folder),
    }


def login_command(config_dir=None):
    """The shell line that signs Claude Code in at this place (the person runs it; it opens the browser)."""
    prefix = ("CLAUDE_CONFIG_DIR=" + shlex.quote(_home_short(config_dir)).replace("'~", "~'") + " ") if config_dir else ""
    return prefix + "claude auth login"


def logout_command(config_dir=None):
    """The shell line that signs Claude Code itself out at this place. Never run by Helm (docs/USAGE-ACCOUNTS.md)."""
    prefix = ("CLAUDE_CONFIG_DIR=" + shlex.quote(_home_short(config_dir)).replace("'~", "~'") + " ") if config_dir else ""
    return prefix + "claude auth logout"


def list_status(cfg=None, full_email=True, now=None):
    """Every account with its status, masked identity and last reading. Reads no credentials and runs nothing.
    full_email=False (the phone listener) leaves the full e-mail out."""
    cfg = cfg if cfg is not None else config_store.load()
    state = _read_state()["accounts"]
    rows = [_row(a, cfg, state.get(a["id"]) or {}, full_email, now) for a in accounts(cfg)]
    return {"active": active_id(cfg), "accounts": rows,
            "note": "Only the active account is read live; the others keep their last reading."}


# ---------------------------------------------------------------- changes

def _materialise(cfg):
    """The config's account list, written out with the implicit default the first time it is changed."""
    raw = cfg.get(LIST_KEY)
    if not isinstance(raw, list) or not [e for e in raw if _normalise(e) is not None]:
        cfg[LIST_KEY] = [default_account()]
    else:
        cfg[LIST_KEY] = [e for e in (_normalise(x) for x in raw) if e is not None]
    if cfg.get(ACTIVE_KEY) not in [e["id"] for e in cfg[LIST_KEY]]:
        cfg[ACTIVE_KEY] = cfg[LIST_KEY][0]["id"]
    return cfg[LIST_KEY]


def _event(action, account_id, src, data_dir):
    """One debug-log line and one activity line per change: the action and the account id only."""
    rlog.debug_event("core", "INFO", "core.write", msg="usage account " + action,
                     data={"action": action, "account": account_id})
    if data_dir:
        try:
            from roadmap.services import activity
            activity.append(data_dir, src if src in activity.SOURCES else "cli", "usage.account",
                            "usage account %s: %s" % (action, account_id))
        except Exception as exc:  # the change is saved already; the activity line is best effort
            log.warning("usage account activity not written: %s", type(exc).__name__)


def _usage_after(kind, account_id, cfg):
    """Tell the usage store an account change happened (services/usage.py). Best effort."""
    try:
        from roadmap.services import usage
        if kind == "switch":
            usage.account_switched(last_reading(account_id), config=cfg)
        else:
            usage.account_login_reset(disconnected=(kind == "disconnect"))
    except Exception as exc:
        log.warning("usage store not updated after account %s: %s", kind, type(exc).__name__)


def _set_enabled(account_id, enabled, src, data_dir):
    def mutate(cfg):
        rows = _materialise(cfg)
        for row in rows:
            if row["id"] == account_id:
                row["enabled"] = enabled
                return cfg
        raise _not_found(account_id)
    cfg = config_store._update(mutate)
    action = "connect" if enabled else "disconnect"
    if account_id == active_id(cfg):
        _usage_after(action, account_id, cfg)
    _event(action, account_id, src, data_dir)
    return list_status(cfg)


def connect(account_id, src="cli", data_dir=None):
    """Let Helm read this account's login again (undoes disconnect)."""
    return _set_enabled(account_id, True, src, data_dir)


def disconnect(account_id, src="cli", data_dir=None):
    """Helm stops reading this account's login. Claude Code stays signed in. Reversible with connect."""
    return _set_enabled(account_id, False, src, data_dir)


def switch(account_id, src="cli", data_dir=None):
    """Make this account the one the sync reads. It must be connected. The board then shows its last kept reading
    until the next sync."""
    def mutate(cfg):
        rows = _materialise(cfg)
        row = next((r for r in rows if r["id"] == account_id), None)
        if row is None:
            raise _not_found(account_id)
        if row["enabled"] is False:
            raise RoadmapError("conflict", "account '%s' is disconnected: connect it first" % account_id,
                               EXIT_CONFLICT)
        changed = cfg.get(ACTIVE_KEY) != account_id
        cfg[ACTIVE_KEY] = account_id
        return cfg, changed
    cfg, changed = config_store._update(mutate)
    if changed:
        _usage_after("switch", account_id, cfg)
        _event("switch", account_id, src, data_dir)
    return list_status(cfg)


def _clean_label(label, fallback):
    text = " ".join(_CONTROL.sub(" ", str(label if label is not None else fallback)).split())
    if not text or len(text) > LABEL_MAX:
        raise _bad("label must be 1 to %d characters" % LABEL_MAX)
    return text


def _clean_path(source, path):
    if not isinstance(path, str) or not path.strip() or _CONTROL.search(path):
        raise _bad("source %s needs a path" % source)
    full = os.path.abspath(os.path.expanduser(path.strip()))
    if source == "config-dir":
        if not os.path.isdir(full):
            raise _bad("config dir does not exist: " + _home_short(full))
    elif os.path.basename(full) != CREDENTIALS_NAME or not os.path.isdir(os.path.dirname(full)):
        raise _bad("a credentials file must be an existing folder's %s" % CREDENTIALS_NAME)
    return full


def add(account_id, label=None, source="config-dir", path=None, keychain_service=None, src="cli", data_dir=None):
    """Add a login place. It starts connected and not active. Only Claude Code's own keychain items and
    .credentials.json files can be named, so an account can never point Helm at another secret."""
    if not paths.valid_id(account_id):
        raise _bad("account id must be 1-40 lowercase letters, digits or dashes")
    if source not in SOURCES:
        raise _bad("source must be one of: " + ", ".join(SOURCES))
    entry = {"id": account_id, "label": _clean_label(label, account_id), "source": source, "enabled": True}
    if source != "keychain":
        entry["path"] = _clean_path(source, path)
    elif path:
        raise _bad("source keychain takes no path")
    if keychain_service is not None:
        if source == "credentials-file" or not SERVICE_RE.fullmatch(str(keychain_service)):
            raise _bad("keychainService must be 'Claude Code-credentials' or 'Claude Code-credentials-<8 hex>'")
        entry["keychainService"] = keychain_service

    def mutate(cfg):
        rows = _materialise(cfg)
        if len(rows) >= MAX_ACCOUNTS:
            raise RoadmapError("conflict", "at most %d usage accounts" % MAX_ACCOUNTS, EXIT_CONFLICT)
        if any(r["id"] == account_id for r in rows):
            raise RoadmapError("conflict", "usage account '%s' already exists" % account_id, EXIT_CONFLICT)
        if any(location(r) == location(entry) for r in rows):
            raise RoadmapError("conflict", "another usage account already reads that login", EXIT_CONFLICT)
        rows.append(entry)
        return cfg
    cfg = config_store._update(mutate)
    _event("add", account_id, src, data_dir)
    return list_status(cfg)


def remove(account_id, src="cli", data_dir=None):
    """Forget a login place (its kept reading too). The active account cannot be removed: switch first. Nothing of
    Claude Code's own login is touched."""
    def mutate(cfg):
        rows = _materialise(cfg)
        if not any(r["id"] == account_id for r in rows):
            raise _not_found(account_id)
        if cfg.get(ACTIVE_KEY) == account_id:
            raise RoadmapError("conflict", "'%s' is the active account: switch to another one first" % account_id,
                               EXIT_CONFLICT)
        cfg[LIST_KEY] = [r for r in rows if r["id"] != account_id]
        return cfg
    cfg = config_store._update(mutate)
    _drop_state(account_id)
    _event("remove", account_id, src, data_dir)
    return list_status(cfg)


# ---------------------------------------------------------------- login in Terminal (macOS, opt-in per click)

def _terminal_script(command):
    escaped = command.replace("\\", "\\\\").replace('"', '\\"')
    return 'tell application "Terminal" to do script "' + escaped + '"'


def _run_osascript(argv):
    return subprocess.run(argv, check=False, timeout=10, capture_output=True).returncode == 0


def open_login(account_id=None, runner=None, cfg=None, src="cli", data_dir=None, now_s=None):
    """Open a Terminal window that runs `claude auth login` for this account (the person finishes it in the browser).
    At most once per LOGIN_GAP_S. The command is built here from the account's own path, never from a request.
    Returns {"opened": bool, "command": str}."""
    cfg = cfg if cfg is not None else config_store.load()
    account = _find(cfg, account_id or active_id(cfg))
    folder = config_dir_of(account)
    command = login_command(folder)
    if folder and _CONTROL.search(folder):
        raise _bad("account path is not usable")
    shell_line = ("CLAUDE_CONFIG_DIR=" + shlex.quote(folder) + " " if folder else "") + "claude auth login"
    moment = time.time() if now_s is None else now_s
    if runner is None and (sys.platform != "darwin" or "unittest" in sys.modules):
        return {"opened": False, "command": command}
    if moment - _last_login["at"] < LOGIN_GAP_S:
        raise RoadmapError("rate_limited", "a login window was opened a moment ago", EXIT_ERROR)
    _last_login["at"] = moment
    try:
        opened = bool((runner or _run_osascript)(["osascript", "-e", _terminal_script(shell_line)]))
    except Exception:
        opened = False
    _event("login", account["id"], src, data_dir)
    return {"opened": opened, "command": command}
