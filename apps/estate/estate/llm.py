"""Ollama client for the estate's LLM jobs, with one voice, moving as one.

Every job the estate speaks — the watcher's fates, the chronicle, the
narration, the asks — rides ONE model and ONE chain: the same resolution,
advancing together, with an automatic swap down the chain after two failed
calls in a row. The default tier is cloud-first (glm-5.3-flash:cloud first,
falling back to the local llama when no cloud model is reachable); --tier
local keeps the whole estate on llama-3.2-3b — the slow silicon's truth.

This is grove's client with the estate's words, and that is deliberate: the
model ladder, the recovery cadence and the JSON recovery were each bought
with a recorded fault (grove b38, b52), and re-deriving them would be
paying for them twice. What differs is the words and the pacing the estate
keeps — the watcher's gap, not the soul's.

Chains keep the model resident: keep_alive 30m. chat_json NEVER raises.
"""

import json
import time
import urllib.error
import urllib.request

from . import rules

DEFAULT_HOST = "http://127.0.0.1:11434"

LOCAL_JOBS = {"watch": "llama3.2:3b"}          # tier local's one model...
LOCAL_ALT = {"llama3.2:3b": "llama3.2:1b"}    # ...and its fallback seat
CLOUD_CHAIN = ["glm-5.3-flash:cloud", "glm-5.2:cloud",
               "deepseek-v4-pro:cloud", "llama3.2:3b"]
LOCAL_FALLBACK_ORDER = ["llama3.2:3b", "llama3.2:1b"]

# every job in TIE_JOB_ORDER shares one resolution and one chain (the
# watcher's), in every tier; they speak as one and they move as one
TIE_JOB_ORDER = ("watch", "chron", "voice", "ask")


def _json_from(text):
    """The one object in a model's reply, or None.

    Ollama is asked for a `format` schema and the models mostly honour it,
    but not always: a flash answer turns up wrapped in a ```json fence often
    enough to matter, and a long one can trail its explanation after the
    object. Parsing the whole reply is too strict for that, and the single
    greedy `{...}` retry this replaces would swallow any brace that came
    after the answer — `{"a":1}\\n\\n... the {cap} range ...` has no parse.
    So take the reply as given if it parses, and otherwise the first `{`
    that starts a complete object, wherever in the text it sits."""
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


class LLM:
    def __init__(self, model="auto", tier="cloud", host=DEFAULT_HOST,
                 timeout=240.0):
        self.host = host
        self.timeout = timeout
        self.tier = tier                  # cloud | local
        self.enabled = True
        self.reason = ""
        self.latency = 0.0
        self.last_raw = None
        self.last_fail = None             # the last job that could not be read
        self.notes = []
        self.job_fails = {}               # job -> consecutive failures
        self.job_chains = {}              # job -> [models to try, in order]
        self.budget = None                # cloud tokens per day (optional)
        self.tok = {"day": time.strftime("%Y-%m-%d"),
                    "in": 0, "out": 0, "calls": 0}
        self.tags = self._fetch_tags()
        self.explicit = None if model in ("auto", None, "") else model
        self.job_models = {}
        model, chain = self._resolve()
        for job in TIE_JOB_ORDER:
            self.job_models[job] = model
            self.job_chains[job] = list(chain)
        # the voice the estate was ASKED for. The chain may step down from
        # it, but must never lose it: without this the ladder is a ratchet
        # and one bad pair of calls demotes the estate until it is
        # restarted (grove b38, which is why this line exists at all)
        self.chosen = model
        self.reprobe_at = 0.0             # when to try the chosen voice again

    # -- model resolution ------------------------------------------------
    def _available(self, name):
        for m in self.tags.get("models", []):
            n = m.get("name", "") or m.get("model", "")
            if n == name or (n.endswith(":latest") and n[:-7] == name):
                return True
        return False

    def _resolve(self):
        """(model, chain) for the estate's one voice: --model NAME pins
        exactly one model; --tier local keeps the estate on the llama;
        anything else is cloud-first with local fallback."""
        if self.explicit:
            return self.explicit, [self.explicit]
        if self.tier == "local":
            m = LOCAL_JOBS["watch"]
            preferred = m if self._available(m) else LOCAL_ALT[m]
            return preferred, [m, LOCAL_ALT[m]]
        chain = [m for m in CLOUD_CHAIN if self._available(m)] \
            or list(LOCAL_FALLBACK_ORDER)
        chain += [m for m in LOCAL_FALLBACK_ORDER if m not in chain]
        return chain[0], chain

    def _swap_job_model(self, job):
        """Move this job along its chain, and the whole voice tier with
        it: the watcher, the chronicle, the narration and the asks share
        the model and move as one."""
        before = dict(self.job_models)
        for step_job in TIE_JOB_ORDER:
            chain = [m for m in self.job_chains.get(step_job, [])
                     if m != self.job_models.get(step_job)]
            if chain and self._available(chain[0]):
                self.job_models[step_job] = chain[0]
        if self.job_models != before:
            self.notes.append("the estate's voice moved to "
                              + self.job_models["watch"])
            if self.job_models["watch"] != self.chosen:
                # the ladder only steps down; start the clock on the way
                # back up the moment we leave the voice we were asked for
                self.reprobe_at = time.time() + self._reprobe_seconds()
        self.notes = self.notes[-4:]
        return True

    def _settled(self):
        """The chosen voice answered — say so. Otherwise the dashboard
        reads 'the watcher tries X again' for the rest of the run, sitting
        beside X's own name in the status line like a contradiction."""
        if self.job_models.get("watch") != self.chosen or not self.notes:
            return
        if self.notes[-1] == "the watcher tries " + self.chosen + " again":
            self.notes[-1] = ("the watcher speaks with " + self.chosen
                              + " again")

    def _reprobe_seconds(self):
        """How long the estate stays on a fallback before trying the
        chosen voice again."""
        return rules.R["pacing"].get("reprobe_seconds", 900)

    def _reconsider(self):
        """Go back to the voice the estate was asked for, on a cadence. The
        chain was one-way: `_resolve` runs once, at construction, and
        `_swap_job_model` only ever walks forward, so a single pair of
        failed calls demoted every job for the life of the process. Here
        the watcher tries its chosen model again; if it is still unwell it
        fails twice more and steps back down the same ladder."""
        chosen = self.chosen
        if not chosen or self.job_models.get("watch") == chosen:
            return False
        if time.time() < self.reprobe_at or self.over_budget():
            return False
        for job in TIE_JOB_ORDER:
            if chosen in self.job_chains.get(job, ()):
                self.job_models[job] = chosen
        self.job_fails.clear()            # the fallback's record is spent
        self.notes.append("the watcher tries " + chosen + " again")
        self.notes = self.notes[-4:]
        self.reprobe_at = time.time() + self._reprobe_seconds()
        return True

    # -- ollama i/o --------------------------------------------------------
    def _fetch_tags(self):
        try:
            return self._request("GET", "/api/tags", None)
        except Exception as e:
            self.enabled = False
            self.reason = f"ollama unreachable ({e})"
            return {"models": []}

    def _request(self, method, path, payload):
        url = self.host + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    # -- the one public call -------------------------------------------------
    def chat_json(self, system, user, schema, max_tokens=160,
                  temperature=0.8, retries=1, job="chron"):
        """One streamed structured completion. dict | None; the job's
        model may swap after repeated failures."""
        if not self.enabled:
            return None
        self._reconsider()             # has the chosen voice earned a retry?
        model = self.job_models.get(job, "llama3.2:3b")
        # the flash-class clouds reason in a hidden channel: no `think`
        # key (with think:false the proxy streams the reasoning INTO the
        # answer's channel and the JSON never parses), and reasoning
        # headroom so the JSON survives the reasoning's budget — the
        # answer costs only its own tokens; the ceiling merely truncates.
        headroom = 3000 if ":cloud" in model else 0
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "stream": True,
            "format": schema,
            "options": {"num_predict": max_tokens + headroom,
                        "num_ctx": 4096, "temperature": temperature},
            "keep_alive": "30m",
        }
        deadline = time.time() + self.timeout
        for _attempt in range(retries + 1):
            t0 = time.time()
            content = self._stream_chat(payload, deadline)
            self.latency = time.time() - t0
            if content:
                out = _json_from(content)
                if out is not None:
                    self.job_fails[job] = 0
                    self.reason = ""
                    self.last_fail = None
                    self._settled()
                    return out
            # say which failure this was: a model that answered nothing is
            # not the same as one that answered something unreadable, and
            # until now both were reported as "unparseable JSON"
            why = "the model answered nothing" if not content \
                else "unparseable JSON"
            self.reason = self.reason or why
            self.last_fail = {"job": job, "why": why,
                              "model": payload["model"],
                              "raw": (content or "")[:300]}
            self.job_fails[job] = self.job_fails.get(job, 0) + 1
            if self.job_fails[job] >= 2:
                self._swap_job_model(job)
                payload["model"] = self.job_models.get(job, model)
                # the ceiling rides the model: a cloud's reasoning head-
                # room must not follow the voice down onto the llama
                headroom = 3000 if ":cloud" in payload["model"] else 0
                payload["options"]["num_predict"] = max_tokens + headroom
                deadline = time.time() + self.timeout
                self.job_fails[job] = 0
        return None

    def _stream_chat(self, payload, deadline):
        """Accumulate a streamed /api/chat response; None on failure.
        Reasoning chunks may carry text in `thinking` — never treated
        as the answer."""
        content = []
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.host + "/api/chat", data=data, method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
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
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.reason = f"call failed: {e}"
            return None
        except (json.JSONDecodeError, ConnectionError):
            self.reason = "bad stream data"
            return None
        text = "".join(content)
        self.last_raw = text[:300]
        return text if text else None

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

    # -- pacing, by what the machine can actually carry ---------------------
    def is_cloud(self):
        return ":cloud" in str(self.job_models.get("watch", ""))

    def watch_gap(self):
        """(lo, hi) wall seconds between watcher invitations, from the
        rules; the caller rolls inside the range."""
        p = rules.R["pacing"]["watcher_gap" if not self.is_cloud()
                             else "watcher_gap_cloud"]
        return p[0], p[1]


def status_line(llm):
    if llm is None:
        return "tier local — pure deterministic sim"
    if not llm.enabled:
        return f"tier local — {llm.reason}"
    # one model, moving as one — name it once; if the tie ever slipped,
    # the split reappears so the drift is seen, not hidden
    voice = llm.job_models.get("watch", "?")
    all_speaking_one = all(m == voice for m in llm.job_models.values())
    base = f"tier {llm.tier} · {voice}" if all_speaking_one else \
        (f"tier {llm.tier} · {voice} (watch) · "
         f"{llm.job_models.get('chron')} (prose)")
    if llm.tier != "local":
        base += f" · tokens today {llm.spend_today()}" + \
                (f"/{llm.budget}" if llm.budget else "")
    if llm.notes:
        base += f" · {llm.notes[-1]}"
    return base
