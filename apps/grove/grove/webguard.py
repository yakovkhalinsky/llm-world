"""Who may change the world, and how much they may say.

The page's own buttons are the only legitimate writers: they POST JSON from
the page's own origin to the host the server was started as. Everything a
state-changing POST must pass is here, in one place:

- `check(handler, hosts)`: the Host must be one this server answers to
  (closes DNS rebinding: a hostile name pointed at 127.0.0.1 arrives with
  its own name as the Host); an Origin, when the browser sends one, must be
  that same host; a browser that labels the request cross-site is refused;
  and the body must be labelled `application/json`, which a cross-site page
  cannot send without a preflight, and the preflight (OPTIONS) is answered
  501, so the browser never sends the POST at all.
- `read_json(handler)`: the declared length is required, numeric, and at
  most `BODY_LIMIT`; exactly that much is read, under the handler's socket
  timeout, so a lying length is a 400, not a hung thread; the body must be
  one JSON object, with no NaN or Infinity.
- `positive_id(obj)`: an `id` that is a real positive integer — not a bool,
  not a string of digits, not a float.

A failure raises `Refused(code, why)`; the handler answers it with that
code and closes the connection.

This file is the same in `apps/grove/grove/` and `apps/estate/estate/` (a
test in each app pins the two byte for byte). The two apps are separate
packages with no shared Python, so the pin stands in for the import.
"""

import json
import socket

BODY_LIMIT = 4096

# The names the live demo is reached by when it runs with --public: the
# station's tailnet name. Its addresses are looked up at startup.
PUBLIC_NAMES = ("station.tail8a1a2.ts.net",)


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(why)
        self.code = code
        self.why = why


def _addresses(name):
    try:
        return {ai[4][0] for ai in socket.getaddrinfo(name, None)}
    except (OSError, UnicodeError):
        return set()


def _lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def allowed_hosts(bind, port, public, extra=(), lookup=True):
    """Every `Host` header value this server answers a POST for.

    Always the loopback names. With `public`, also the station's tailnet
    name and its addresses, the LAN address the start-up hint prints, and
    any `extra` names. `lookup=False` skips the DNS and LAN lookups (for
    tests)."""
    names = {"localhost", "127.0.0.1", "[::1]"}
    if bind not in ("", "0.0.0.0", "::"):
        names.add(bind)
    if public:
        for name in tuple(PUBLIC_NAMES) + tuple(extra):
            names.add(name.lower())
            if lookup:
                for ip in _addresses(name):
                    names.add("[" + ip + "]" if ":" in ip else ip)
        if lookup:
            ip = _lan_ip()
            if ip:
                names.add(ip)
    hosts = {f"{n}:{port}" for n in names}
    if port == 80:
        hosts |= names
    return frozenset(hosts)


def check(handler, hosts):
    """Refuse a state-changing request that did not come from the page."""
    got = handler.headers.get_all("Host") or []
    if len(got) != 1 or got[0].strip().lower() not in hosts:
        raise Refused(403, "this server does not answer to that host")
    host = got[0].strip().lower()
    origins = handler.headers.get_all("Origin") or []
    if len(origins) > 1:
        raise Refused(403, "more than one origin")
    if origins and origins[0].strip().lower() not in (
            "http://" + host, "https://" + host):
        raise Refused(403, "a request from another origin")
    site = (handler.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if site == "cross-site":
        raise Refused(403, "a request from another site")
    ctypes = handler.headers.get_all("Content-Type") or []
    if len(ctypes) != 1 or \
            ctypes[0].split(";", 1)[0].strip().lower() != "application/json":
        raise Refused(403, "the body must be application/json")


def _no_constants(name):
    raise ValueError("not a number: " + name)


def read_json(handler, limit=BODY_LIMIT):
    """The request's body as one JSON object, or `Refused`."""
    lengths = handler.headers.get_all("Content-Length") or []
    if not lengths:
        raise Refused(411, "a length is required")
    if len(lengths) > 1:
        raise Refused(400, "more than one length")
    raw = lengths[0].strip()
    if not (raw.isascii() and raw.isdigit()):
        raise Refused(400, "the length is not a number")
    n = int(raw)
    if n > limit:
        raise Refused(413, "the body is too large")
    try:
        data = handler.rfile.read(n) if n else b""
    except (socket.timeout, OSError):
        raise Refused(400, "the body is shorter than its length")
    if len(data) != n:
        raise Refused(400, "the body is shorter than its length")
    try:
        obj = json.loads(data.decode("utf-8") or "{}",
                         parse_constant=_no_constants)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise Refused(400, "the body is not JSON")
    if not isinstance(obj, dict):
        raise Refused(400, "the body is not a JSON object")
    return obj


def positive_id(obj):
    v = obj.get("id")
    if type(v) is not int or v <= 0 or v >= 2 ** 63:
        raise Refused(400, "id must be a positive integer")
    return v
