"""Ollama client for the grove's LLM jobs: one model per kind of job.

Every job the grove asks of a model is one of three kinds, and each kind
has its own model (`--choice-model`, `--prose-model`, `--embed-model`):

- **choice** jobs pick from a menu (the World Soul's operator, the steward). They want a small
  model that follows a schema: qwen3:4b-instruct-2507-q4_K_M by default.
  With `--decide rules` (the default) the pick itself is made by
  `decide.py`, in code, and the model only writes the one line of why.
- **prose** jobs write a line (the chronicle, naming and diaries, ask the grove): gemma3:4b by default.
- **embed** turns chronicle lines into vectors: nomic-embed-text.

`--tier cloud` (the default) puts `--cloud-model` (deepseek-v4.1-flash:cloud)
in front of every chat job, with the job's local model as the fallback;
`--tier local` keeps every call on the box. `--model NAME` still pins every
chat job to exactly one model.

A model that is not installed is not a silent 404. Each job's chain is
filtered to what Ollama has (`/api/tags`, with a bare name read as
`:latest`; a `:cloud` name may also be confirmed by `/api/show`). A job
with nothing installed is reported as missing — in the status line, so
the HUD says so, and in `model_status()` for the API — and it falls back
to its template without calling. A 404 mid-run marks the model missing and
moves the job along its chain at once. Ollama being down is retried on a
cadence (REPROBE_MISSING_SECONDS), not given up on for the life of the
process, and a model pulled while the demo runs is picked up the same way.

Small boxes: calls are serialised — within the process by a lock, and
across processes (the estate and the grove on one Pi) by an flock on
`--model-lock` (per user; `--lock-wait`, default 60 s, bounds the wait,
and waiters take turns). With `--resident one` (the default) a local chat model is
unloaded before a different one is used, so the choice and prose models
are never both resident; `--keep-alive` (default 2m) is sent with every
call. chat_json NEVER raises.
"""

import errno
import fcntl
import json
import os
import stat
import threading
import time
import urllib.error
import urllib.request

from . import rules

DEFAULT_HOST = "http://127.0.0.1:11434"

CHOICE_MODEL = "qwen3:4b-instruct-2507-q4_K_M"
PROSE_MODEL = "gemma3:4b"
EMBED_MODEL = "nomic-embed-text"
CLOUD_MODEL = "deepseek-v4.1-flash:cloud"
# the old default: used only when it happens to be installed, after the
# job's own models — it is never asked for when it is not there
LAST_RESORT = "llama3.2:3b"
DEFAULT_KEEP_ALIVE = "2m"
# per user: a file another account made (or a link it planted) is never
# opened; two demos run as one user share it
DEFAULT_LOCK = f"/tmp/llm-world-ollama-{os.getuid()}.lock"
DEFAULT_LOCK_WAIT = 60.0
LOCK_POLL = 0.05
REPROBE_MISSING_SECONDS = 60
# a cloud name /api/show could not confirm is asked again after this, then
# twice as long each time it fails, up to the cap — never written off
SHOW_BACKOFF = 30.0
SHOW_BACKOFF_MAX = 900.0
TAGS_TIMEOUT = 5

# which kind of model each job wants. The World Soul's operator and the
# steward choose from menus and bounds (choices); the chronicle, the
# naming voice and the asks write lines (prose).
JOB_ROLE = {"op": "choice", "review": "choice",
            "chron": "prose", "voice": "prose", "ask": "prose"}
USES_EMBED = True            # does this app ask for embeddings?
LEAD_JOB = "op"                # the job whose model sets the pacing
CHOICE_JOBS_HELP = "the World Soul, the steward"
PROSE_JOBS_HELP = "chronicle, naming, ask"

TIERS = ("cloud", "local")
DECIDE_MODES = ("rules", "llm")
RESIDENT_MODES = ("one", "many")

# one process, one caller at a time: two jobs must never make Ollama load
# two models at once on a 16 GB Pi
_CALL_LOCK = threading.RLock()


class ModelBusy(TimeoutError):
    """Another call — in this process or another llm-world process — still
    holds the model. The call does not go ahead: a lock that gives way
    after its wait is no lock at all."""


def _json_from(text):
    """The one object in a model's reply, or None.

    Ollama is asked for a `format` schema and the models mostly honour it,
    but not always: a flash answer turns up wrapped in a ```json fence often
    enough to matter, and a long one can trail its explanation after the
    object. So take the reply as given if it parses, and otherwise the
    first `{` that starts a complete object, wherever in the text it sits."""
    dec = json.JSONDecoder()
    text = text.strip()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            out, _end = dec.raw_decode(text[i:])
        except ValueError:
            continue
        if isinstance(out, dict):
            return out
    return None


def is_cloud(name):
    return ":cloud" in str(name or "") or str(name or "").endswith("-cloud")


def same_model(a, b):
    """Ollama names a bare tag `:latest`; `nomic-embed-text` and
    `nomic-embed-text:latest` are the same model."""
    def norm(n):
        n = str(n or "")
        return n if ":" in n else n + ":latest"
    return norm(a) == norm(b)


def needs_think_off(name):
    """A local tag that reasons before it answers would spend minutes of a
    Pi's time doing it: plain qwen3 tags (not the instruct-2507 builds)
    and SmolLM3. Cloud models get no `think` key — the flash proxies stream
    the reasoning into the answer when it is sent."""
    n = str(name or "").lower()
    if is_cloud(n):
        return False
    if n.startswith("qwen3") and "instruct" not in n:
        return True
    return "smollm3" in n


def job_chain(job, tier="cloud", explicit=None, choice=CHOICE_MODEL,
              prose=PROSE_MODEL, cloud=CLOUD_MODEL):
    """The models a job may use, best first, before anything is checked
    against what is installed. Pure, so it is tested on its own."""
    if explicit:
        return [explicit]
    role = JOB_ROLE.get(job, "prose")
    own, other = (choice, prose) if role == "choice" else (prose, choice)
    chain = [own, other, LAST_RESORT]
    if tier == "cloud" and cloud:
        chain.insert(0, cloud)
    out = []
    for m in chain:
        if m and not any(same_model(m, x) for x in out):
            out.append(m)
    return out


class LLM:
    def __init__(self, model="auto", tier="cloud", host=DEFAULT_HOST,
                 timeout=240.0, choice_model=None, prose_model=None,
                 embed_model=None, cloud_model=None, keep_alive=None,
                 resident="one", lock_path=DEFAULT_LOCK, decide="rules",
                 lock_wait=None):
        self.host = host or DEFAULT_HOST
        self.timeout = timeout
        # how long a call waits for the model before giving up its turn
        self.lock_wait = DEFAULT_LOCK_WAIT if lock_wait is None \
            else float(lock_wait)
        self.lock_problem = ""            # the shared lock could not be used
        self.tier = "cloud" if tier in ("cloud", "hybrid", "auto", None) \
            else tier                     # grove's old "hybrid" is cloud
        self.choice_model = choice_model or CHOICE_MODEL
        self.prose_model = prose_model or PROSE_MODEL
        self.embed_model = embed_model or EMBED_MODEL
        self.cloud_model = CLOUD_MODEL if cloud_model is None \
            else cloud_model
        self.keep_alive = keep_alive or DEFAULT_KEEP_ALIVE
        self.resident = resident if resident in RESIDENT_MODES else "one"
        self.lock_path = lock_path
        self.decide = decide if decide in DECIDE_MODES else "rules"
        self.explicit = None if model in ("auto", None, "") else model
        self.enabled = True               # Ollama answered the last probe
        self.reason = ""
        self.latency = 0.0
        self.last_raw = None
        self.last_fail = None             # the last job that could not be read
        self.notes = []
        self.job_fails = {}               # job -> consecutive failures
        self.job_chains = {}              # job -> [wanted models, in order]
        self.job_models = {}              # job -> the model in use, or None
        self.chosen = {}                  # job -> the best model installed
        self.reprobe_at = {}              # job -> when to try chosen again
        self.missing = []                 # wanted models Ollama lacks
        self.gone = set()                 # models a call found missing
        self.shown = {}                   # :cloud name -> /api/show said so
        self.show_retry = {}              # :cloud name -> (ask again at, gap)
        self.job_failing = {}             # job -> why it ran off its chain
        self.called = set()               # local models this process used
        self.embed_ok = True
        self.budget = None                # cloud tokens per day (optional)
        self.tok = {"day": time.strftime("%Y-%m-%d"),
                    "in": 0, "out": 0, "calls": 0}
        self.tags = {"models": []}
        self.next_probe = 0.0
        self._probe_mu = threading.Lock() # one probe at a time
        self.probe()

    # -- what is installed ----------------------------------------------------
    def probe(self):
        """Read /api/tags and (re)resolve every job. Never raises; an
        unreachable Ollama is retried on the next cadence, not forever
        given up on."""
        self.next_probe = time.time() + REPROBE_MISSING_SECONDS
        try:
            self.tags = self._request("GET", "/api/tags", None,
                                      timeout=TAGS_TIMEOUT)
        except Exception as e:
            self.enabled = False
            self.reason = f"ollama unreachable ({e})"
            self.tags = {"models": []}
            self._resolve_all()
            return False
        if not self.enabled or self.reason.startswith("ollama unreachable"):
            self.reason = ""
        self.enabled = True
        self.gone.clear()
        self._resolve_all()
        return True

    def _installed(self, name):
        for m in self.tags.get("models", []):
            n = m.get("name", "") or m.get("model", "")
            if same_model(n, name):
                return True
        return False

    def _available(self, name):
        if not name or name in self.gone:
            return False
        if self._installed(name):
            return True
        if not is_cloud(name) or not self.enabled:
            return False
        # a cloud model answers /api/show without having been pulled. Only
        # a yes is kept; a failure is asked again on a backoff, so one bad
        # moment does not lock the cloud out until a restart
        if self.shown.get(name):
            return True
        at, gap = self.show_retry.get(name, (0.0, SHOW_BACKOFF / 2))
        if time.time() < at:
            return False
        try:
            self._request("POST", "/api/show", {"model": name},
                          timeout=TAGS_TIMEOUT)
        except Exception:
            gap = min(SHOW_BACKOFF_MAX, gap * 2)
            self.show_retry[name] = (time.time() + gap, gap)
            return False
        self.shown[name] = True
        self.show_retry.pop(name, None)
        return True

    def _resolve_all(self):
        missing = []
        for job in JOB_ROLE:
            chain = job_chain(job, self.tier, self.explicit,
                              self.choice_model, self.prose_model,
                              self.cloud_model)
            self.job_chains[job] = chain
            have = [m for m in chain if self._available(m)]
            pick = have[0] if have else None
            # a probe puts every job back on its best installed model
            self.job_models[job] = pick
            self.chosen[job] = pick
            self.job_failing.pop(job, None)
            if self.enabled:
                wanted = chain[0] if self.explicit else \
                    (self.choice_model if JOB_ROLE[job] == "choice"
                     else self.prose_model)
                if not self._available(wanted) and wanted not in missing:
                    missing.append(wanted)
                if self.explicit is None and self.tier == "cloud" and \
                        self.cloud_model and \
                        not self._available(self.cloud_model) and \
                        self.cloud_model not in missing:
                    missing.append(self.cloud_model)
        self.embed_ok = self.enabled and USES_EMBED and \
            self._available(self.embed_model)
        if self.enabled and USES_EMBED and not self.embed_ok and \
                self.embed_model not in missing:
            missing.append(self.embed_model)
        self.missing = missing

    def _probe_due(self):
        return time.time() >= self.next_probe and (
            not self.enabled or bool(self.missing) or
            any(m is None for m in self.job_models.values()))

    def _maybe_probe(self):
        """Probe again on the cadence while anything is unreachable or
        missing — a model pulled mid-run is used without a restart. On the
        calling thread: only the call paths, which wait on Ollama anyway."""
        if self._probe_due() and self._probe_mu.acquire(blocking=False):
            try:
                self.probe()
            finally:
                self._probe_mu.release()

    def _probe_in_background(self):
        if not self._probe_due() or not self._probe_mu.acquire(
                blocking=False):
            return
        self.next_probe = time.time() + REPROBE_MISSING_SECONDS

        def run():
            try:
                self.probe()
            finally:
                self._probe_mu.release()
        threading.Thread(target=run, daemon=True, name="llm-probe").start()

    def wait_for_probe(self, timeout=10.0):
        """Block until no probe is running (tests, and a clean shutdown)."""
        if self._probe_mu.acquire(timeout=timeout):
            self._probe_mu.release()

    def ready(self):
        """Ollama answered and a chat job has a model. Never waits on
        Ollama: it is asked from the sim thread and under the world lock,
        so a due re-probe runs in the background and the answer is the
        last one known."""
        self._probe_in_background()
        return self.enabled and any(self.job_models.values())

    # -- the ladder ------------------------------------------------------------
    def _swap_job_model(self, job):
        """Move this job one step down its chain, to the next installed
        model. Jobs move on their own: a prose model failing does not
        demote the watcher's choices."""
        cur = self.job_models.get(job)
        chain = self.job_chains.get(job, [])
        after = chain[chain.index(cur) + 1:] if cur in chain else chain
        nxt = next((m for m in after if self._available(m)), None)
        self.job_models[job] = nxt
        if nxt != cur:
            self.notes.append(f"{job} moved to {nxt or 'its template'}")
            self.reprobe_at[job] = time.time() + self._reprobe_seconds()
        self.notes = self.notes[-4:]

    def _reprobe_seconds(self):
        return rules.R["pacing"].get("reprobe_seconds", 900)

    def _reconsider(self, job):
        """Go back to the job's chosen model on a cadence: the ladder only
        steps down, and without this one bad pair of calls demotes a job
        for the life of the process (grove b38)."""
        chosen = self.chosen.get(job)
        if not chosen or self.job_models.get(job) == chosen:
            return False
        if time.time() < self.reprobe_at.get(job, 0) or self.over_budget():
            return False
        if not self._available(chosen):
            return False
        self.job_models[job] = chosen
        self.job_fails[job] = 0
        self.job_failing.pop(job, None)
        self.notes.append(f"{job} tries {chosen} again")
        self.notes = self.notes[-4:]
        self.reprobe_at[job] = time.time() + self._reprobe_seconds()
        return True

    def _gone(self, model):
        """A call said this model does not exist: stop asking for it."""
        self.gone.add(model)
        self.shown.pop(model, None)
        if model not in self.missing:
            self.missing.append(model)
        self.next_probe = time.time() + REPROBE_MISSING_SECONDS
        for job, m in list(self.job_models.items()):
            if m == model:
                self._swap_job_model(job)
        # the status line names it under "not installed" already

    # -- ollama i/o --------------------------------------------------------------
    def _request(self, method, path, payload, timeout=30):
        url = self.host + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    class _Serial:
        """The process lock plus, when configured, a lock shared with every
        other llm-world process on the box.

        The shared lock is two byte-range locks on one file: a turnstile at
        byte 0 and the model at byte 1. A caller takes the turnstile, then
        the model, then lets the turnstile go — so a process that has just
        finished cannot take the model straight back while another is
        waiting; they take turns. Every wait is bounded by `wait` and ends
        in ModelBusy, never in a call made without the lock.

        The file is opened without following links and must be a regular
        file owned by this user; one that is not is left alone, the call
        runs under the process lock only, and `owner.lock_problem` says so
        in the status line."""

        def __init__(self, path, wait, owner=None):
            self.path, self.wait, self.fd = path, wait, None
            self.owner = owner

        def __enter__(self):
            if not _CALL_LOCK.acquire(timeout=max(0.0, self.wait)):
                raise ModelBusy("another model call is still running")
            try:
                self._lock()
            except BaseException:
                self._close()
                _CALL_LOCK.release()
                raise
            return self

        def _problem(self, text):
            if self.owner is not None:
                self.owner.lock_problem = text

        def _open(self):
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | \
                getattr(os, "O_CLOEXEC", 0)
            try:
                fd = os.open(self.path, flags, 0o600)
            except OSError as e:
                why = "is a symlink" if e.errno == errno.ELOOP else \
                    (e.strerror or str(e)).lower()
                self._problem(f"model lock {self.path} {why}; "
                              "this process only")
                return None
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid():
                os.close(fd)
                self._problem(f"model lock {self.path} is not this user's "
                              "file; this process only")
                return None
            self._problem("")
            return fd

        def _take(self, byte, end):
            while True:
                try:
                    fcntl.lockf(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB,
                                1, byte)
                    return
                except OSError as e:
                    if e.errno not in (errno.EACCES, errno.EAGAIN):
                        raise
                if time.time() >= end:
                    # the wait ran out: give up the turn, never go ahead
                    # without the lock (the caller sees ModelBusy)
                    raise ModelBusy("another llm-world process holds "
                                    "the model")
                time.sleep(LOCK_POLL)

        def _lock(self):
            if not self.path:
                return
            self.fd = self._open()
            if self.fd is None:
                return
            end = time.time() + max(0.0, self.wait)
            self._take(0, end)                  # the turnstile
            try:
                self._take(1, end)              # the model
            finally:
                fcntl.lockf(self.fd, fcntl.LOCK_UN, 1, 0)

        def _close(self):
            if self.fd is not None:
                try:
                    os.close(self.fd)   # closing releases the locks
                except OSError:
                    pass
                self.fd = None

        def __exit__(self, *exc):
            self._close()
            _CALL_LOCK.release()
            return False

    def _serial(self):
        return LLM._Serial(self.lock_path, self.lock_wait, self)

    def _ours(self, name):
        """A chat model this app is configured for, or has called — the
        only ones _make_room may unload. Another program's model on the
        same Ollama is left alone."""
        mine = set(self.called)
        for chain in self.job_chains.values():
            mine.update(chain)
        mine.update(m for m in (self.choice_model, self.prose_model,
                                self.explicit) if m)
        return any(same_model(name, m) for m in mine)

    def _make_room(self, model):
        """With --resident one, unload any other local chat model of ours
        before this one loads (the embedder is small and stays). Cloud
        models load nothing here."""
        if self.resident != "one" or is_cloud(model):
            return
        try:
            ps = self._request("GET", "/api/ps", None, timeout=TAGS_TIMEOUT)
        except Exception:
            return
        for m in ps.get("models", []):
            n = m.get("name", "") or m.get("model", "")
            if not n or same_model(n, model) or \
                    same_model(n, self.embed_model) or is_cloud(n) or \
                    not self._ours(n):
                continue
            try:
                self._request("POST", "/api/generate",
                              {"model": n, "keep_alive": 0},
                              timeout=TAGS_TIMEOUT)
            except Exception:
                pass

    # -- the public calls --------------------------------------------------------
    def chat_json(self, system, user, schema, max_tokens=160,
                  temperature=0.8, retries=1, job="chron"):
        """One streamed structured completion. dict | None; the job's
        model may swap after repeated failures. Never raises."""
        try:
            return self._chat_json(system, user, schema, max_tokens,
                                   temperature, retries, job)
        except Exception as e:            # the world must never crash
            self.reason = f"client error: {e}"
            return None

    def _chat_json(self, system, user, schema, max_tokens, temperature,
                   retries, job):
        self._maybe_probe()
        if not self.enabled:
            return None
        self._reconsider(job)
        model = self.job_models.get(job)
        if not model:
            if job in self.job_failing:
                self.reason = f"{job}: {self.job_failing[job]}"
                why = "every model failing"
            else:
                self.reason = (f"{job}: no model installed (wanted "
                               f"{self.job_chains.get(job, ['?'])[0]})")
                why = "model not installed"
            self.last_fail = {"job": job, "why": why, "model": None,
                              "raw": ""}
            return None
        for _attempt in range(retries + 1):
            model = self.job_models.get(job)
            if not model:
                break
            payload = self._payload(model, system, user, schema,
                                    max_tokens, temperature)
            t0 = time.time()
            content, status = self._stream_chat(payload)
            self.latency = time.time() - t0
            if status == "busy":
                # waiting on another caller says nothing about the model:
                # no failure counted, no swap, no retry
                self.last_fail = {"job": job, "why": "model busy",
                                  "model": model, "raw": ""}
                return None
            if status == 404:
                self.reason = f"model not installed: {model}"
                self.last_fail = {"job": job, "why": "model not installed",
                                  "model": model, "raw": ""}
                self._gone(model)
                continue
            if content:
                out = _json_from(content)
                if out is not None:
                    self.job_fails[job] = 0
                    self.job_failing.pop(job, None)
                    self.reason = ""
                    self.last_fail = None
                    return out
            if isinstance(status, int) and status != 200:
                why = f"HTTP {status}"
            else:
                why = "the model answered nothing" if not content \
                    else "unparseable JSON"
            self.reason = self.reason or why
            self.last_fail = {"job": job, "why": why, "model": model,
                              "raw": (content or "")[:300]}
            self.job_fails[job] = self.job_fails.get(job, 0) + 1
            if self.job_fails[job] >= 2:
                self._swap_job_model(job)
                self.job_fails[job] = 0
                if self.job_models.get(job) is None:
                    # installed, and failing: not the same as missing
                    self.job_failing[job] = (f"every model failing (last "
                                             f"{model}: {why})")
                    self.reason = f"{job}: {self.job_failing[job]}"
                    self.next_probe = time.time() + REPROBE_MISSING_SECONDS
        return None

    def _payload(self, model, system, user, schema, max_tokens,
                 temperature):
        # the flash-class clouds reason in a hidden channel and need
        # headroom so the JSON survives the reasoning's budget; the
        # ceiling rides the model, so it never follows a job down onto
        # a local one
        headroom = 3000 if is_cloud(model) else 0
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "stream": True,
            "format": schema,
            "options": {"num_predict": max_tokens + headroom,
                        "num_ctx": 4096, "temperature": temperature},
            "keep_alive": self.keep_alive,
        }
        if needs_think_off(model):
            payload["think"] = False
        return payload

    def _stream_chat(self, payload):
        """(text | None, http status | "busy" | None). Reasoning chunks may carry
        text in `thinking` — never treated as the answer. The deadline
        starts once the model is ours: a call that waited its turn is not
        then sent and thrown away."""
        content = []
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.host + "/api/chat", data=data, method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with self._serial():
                deadline = time.time() + self.timeout
                self._make_room(payload["model"])
                if not is_cloud(payload["model"]):
                    self.called.add(payload["model"])
                with urllib.request.urlopen(
                        req, timeout=max(1.0, min(90.0, self.timeout))) \
                        as resp:
                    for line in resp:
                        if time.time() > deadline:
                            self.reason = "deadline exceeded"
                            break
                        part = json.loads(line.decode())
                        msg = part.get("message", {})
                        if msg.get("content"):
                            content.append(msg["content"])
                        if part.get("done"):
                            self._meter(part)
                            break
        except ModelBusy as e:
            self.reason = f"waiting for the model lock: {e}"
            return None, "busy"
        except urllib.error.HTTPError as e:
            self.reason = f"call failed: {e}"
            return None, e.code
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.reason = f"call failed: {e}"
            return None, None
        except (json.JSONDecodeError, ConnectionError):
            self.reason = "bad stream data"
            return None, None
        text = "".join(content)
        self.last_raw = text[:300]
        return (text if text else None), 200

    def embed(self, texts, timeout=150.0):
        """Vectors from the embed model, or None. Serialised like a chat
        call; a missing embedder is reported, not retried every ask."""
        self._maybe_probe()
        if not self.enabled or not self.embed_ok:
            return None
        payload = {"model": self.embed_model, "input": list(texts),
                   "keep_alive": self.keep_alive}
        try:
            with self._serial():
                return self._request("POST", "/api/embed", payload,
                                     timeout=timeout).get("embeddings")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self.embed_ok = False
                if self.embed_model not in self.missing:
                    self.missing.append(self.embed_model)
                self.next_probe = time.time() + REPROBE_MISSING_SECONDS
            return None
        except Exception:
            return None

    def _meter(self, last_part):
        day = time.strftime("%Y-%m-%d")
        if self.tok.get("day") != day:
            self.tok = {"day": day, "in": 0, "out": 0, "calls": 0}
        self.tok["calls"] += 1
        self.tok["in"] += int(last_part.get("prompt_eval_count") or 0)
        self.tok["out"] += int(last_part.get("eval_count", 0) or 0)

    def over_budget(self):
        return bool(self.budget) and \
            (self.tok["in"] + self.tok["out"]) >= self.budget

    def spend_today(self):
        return self.tok["in"] + self.tok["out"]

    # -- pacing, by what the machine can actually carry ---------------------------
    def is_cloud(self):
        return is_cloud(self.job_models.get(LEAD_JOB))

    # -- what the HUD and the API say -----------------------------------------------
    def job_state(self, job):
        if not self.enabled:
            return "unreachable"
        m = self.job_models.get(job)
        if m is None:
            return "failing" if job in self.job_failing else "missing"
        chain = self.job_chains.get(job, [])
        return "ok" if chain and m == chain[0] else "fallback"

    def model_status(self):
        """Everything the API reports about the models, as plain data."""
        return {
            "tier": self.tier,
            "pinned": self.explicit,
            "reachable": self.enabled,
            "reason": self.reason,
            "decide": self.decide,
            "keep_alive": self.keep_alive,
            "resident": self.resident,
            "lock": {"path": self.lock_path or None,
                     "wait": self.lock_wait,
                     "problem": self.lock_problem or None},
            "models": {"choice": self.choice_model,
                       "prose": self.prose_model,
                       "embed": self.embed_model,
                       "cloud": self.cloud_model if self.tier == "cloud"
                       else None},
            "jobs": {job: {"role": JOB_ROLE[job],
                           "model": self.job_models.get(job),
                           "wanted": (self.job_chains.get(job) or [None])[0],
                           "state": self.job_state(job)}
                     for job in JOB_ROLE},
            "embed": None if not USES_EMBED else {
                      "model": self.embed_model,
                      "state": "ok" if self.embed_ok else
                      ("unreachable" if not self.enabled else "missing")},
            "missing": list(self.missing),
            "failing": dict(self.job_failing),
            "tokens_today": self.spend_today(),
        }


def status_line(llm):
    """One readable line for the HUD: the models in use and, before
    anything else, what is missing."""
    if llm is None:
        return "AI off — pure deterministic sim"
    if not llm.enabled:
        return (f"tier {llm.tier} — {llm.reason or 'ollama unreachable'}"
                f" · retrying every {REPROBE_MISSING_SECONDS} s")
    used = []
    for job in JOB_ROLE:
        m = llm.job_models.get(job)
        if m and m not in used:
            used.append(m)
    failing = [j for j in JOB_ROLE
               if j in llm.job_failing and llm.job_models.get(j) is None]
    if not used:
        base = f"tier {llm.tier} · " + \
            ("every model failing" if failing else "no model installed")
    elif len(used) == 1:
        base = f"tier {llm.tier} · {used[0]}"
    else:
        base = f"tier {llm.tier} · " + " · ".join(
            f"{_short(m)} ({', '.join(j for j in JOB_ROLE if llm.job_models.get(j) == m)})"
            for m in used)
    if llm.decide == "rules":
        base += " · choices by rules"
    if failing:
        base += " · failing: " + "; ".join(
            f"{j} ({llm.job_failing[j]}, on its template)" for j in failing)
    lacking = [m for m in llm.missing
               if not (is_cloud(m) and llm.tier != "cloud")]
    if lacking:
        silent = [j for j in JOB_ROLE if llm.job_models.get(j) is None
                  and j not in failing]
        base += " · not installed: " + ", ".join(lacking)
        if silent:
            base += " (" + ", ".join(silent) + " on templates)"
    if llm.tier == "cloud" and llm.is_cloud():
        base += f" · tokens today {llm.spend_today():,}" + \
                (f" of {llm.budget:,}" if llm.budget else "")
    if llm.lock_problem:
        base += f" · {llm.lock_problem}"
    if llm.notes:
        base += f" · {llm.notes[-1]}"
    return base


def _short(model):
    return str(model).replace("-q4_K_M", "")


def add_flags(sp):
    """The model flags, the same in both apps."""
    sp.add_argument("--choice-model", default=CHOICE_MODEL,
                    help=f"model for menu-shaped jobs ({CHOICE_JOBS_HELP}); "
                         f"default {CHOICE_MODEL}")
    sp.add_argument("--prose-model", default=PROSE_MODEL,
                    help=f"model for prose jobs ({PROSE_JOBS_HELP}); "
                         f"default {PROSE_MODEL}")
    sp.add_argument("--embed-model", default=EMBED_MODEL,
                    help=f"embedding model; default {EMBED_MODEL}")
    sp.add_argument("--cloud-model", default=CLOUD_MODEL,
                    help=f"with --tier cloud, tried before the local "
                         f"models; default {CLOUD_MODEL}")
    sp.add_argument("--decide", default="rules", choices=DECIDE_MODES,
                    help='"rules" (default): menu choices are made in '
                         'code and the model writes only the why; "llm": '
                         'the model picks from the menu too')
    sp.add_argument("--keep-alive", default=DEFAULT_KEEP_ALIVE,
                    help="how long Ollama keeps a model loaded after a "
                         f"call; default {DEFAULT_KEEP_ALIVE}")
    sp.add_argument("--resident", default="one", choices=RESIDENT_MODES,
                    help='"one" (default): unload the other local chat '
                         'model before loading this one; "many": let '
                         'Ollama keep both')
    sp.add_argument("--model-lock", default=DEFAULT_LOCK,
                    help="a file every llm-world process locks around a "
                         "model call, so two demos on one box take turns; "
                         '"" for this process only (two apps on '
                         'different models then thrash); default '
                         f'{DEFAULT_LOCK}')
    sp.add_argument("--lock-wait", type=float, default=DEFAULT_LOCK_WAIT,
                    help="seconds a call waits its turn at the model "
                         "before falling back to its template; default "
                         f"{DEFAULT_LOCK_WAIT:g}")


def from_args(args, **kw):
    """An LLM built from the parsed flags."""
    g = lambda k, d=None: getattr(args, k, d)    # noqa: E731
    return LLM(model=g("model", "auto") or "auto",
               tier=g("tier", "cloud"), host=g("host") or DEFAULT_HOST,
               choice_model=g("choice_model"), prose_model=g("prose_model"),
               embed_model=g("embed_model"), cloud_model=g("cloud_model"),
               keep_alive=g("keep_alive"), resident=g("resident", "one"),
               lock_path=g("model_lock", DEFAULT_LOCK),
               lock_wait=g("lock_wait"),
               decide=g("decide", "rules"), **kw)


def _soul_gap(self):
    """(lo, hi) wall seconds between World Soul invitations, from the
    rules; the caller rolls inside the range."""
    p = rules.R["pacing"]["soul_gap_local" if not self.is_cloud()
                         else "soul_gap_cloud"]
    return p[0], p[1]


LLM.soul_gap = _soul_gap
