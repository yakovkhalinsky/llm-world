"""Ollama client for the grove's LLM jobs, with one model, moving as one.

Every job the grove speaks — the operator's fates, the chronicle, the
naming and diaries, the asks, the steward's review — rides ONE model and
ONE chain (the soul's): the same resolution, advancing together, with an
automatic swap down the chain after two failed calls in a row. The
default tier is cloud-first (glm-5.3-flash:cloud first, falling back to
the local llama when no cloud model is reachable); --tier local forces
the whole forest onto llama-3.2-3b — the slow silicon's truth.

Chains keep the model resident: keep_alive 30m. chat_json NEVER raises.
"""

import json
import re
import time
import urllib.error
import urllib.request

from . import rules

DEFAULT_HOST = "http://127.0.0.1:11434"

LOCAL_JOBS = {"soul": "llama3.2:3b"}     # tier local's one model...
LOCAL_ALT = {"llama3.2:3b": "llama3.2:1b"}   # ...and its fallback seat
CLOUD_CHAIN = ["glm-5.3-flash:cloud", "glm-5.2:cloud",
               "deepseek-v4-pro:cloud", "llama3.2:3b"]
LOCAL_FALLBACK_ORDER = ["llama3.2:3b", "llama3.2:1b"]

# every job in TIE_JOB_ORDER shares one resolution and one chain (the
# soul's), in every tier; they speak as one and they move as one
TIE_JOB_ORDER = ("soul", "chron", "voice", "op", "ask", "review")


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
        self.notes = []
        self.job_fails = {}               # job -> consecutive failures
        self.job_chains = {}              # job -> [models to try, in order]
        self.budget = None                # cloud tokens per day (optional)
        self.tok = {"day": time.strftime("%Y-%m-%d"),
                    "in": 0, "out": 0, "calls": 0}
        self.tags = self._fetch_tags()
        if model in ("auto", None, ""):
            self.explicit = None
        else:
            self.explicit = model
        self.job_models = {}
        self.job_chains = {}
        model, chain = self._resolve("soul")
        for job in TIE_JOB_ORDER:
            self.job_models[job] = model
            self.job_chains[job] = list(chain)

    # -- model resolution ------------------------------------------------
    def _available(self, name):
        for m in self.tags.get("models", []):
            n = m.get("name", "") or m.get("model", "")
            if n == name or (n.endswith(":latest") and n[:-7] == name):
                return True
        return False

    def _resolve(self, job):
        """(model, chain) for the grove's one voice: --model NAME pins
        exactly one model; --tier local keeps the forest on the llama;
        anything else is cloud-first with local fallback."""
        if self.explicit:
            return self.explicit, [self.explicit]
        if self.tier == "local":
            m = LOCAL_JOBS["soul"]
            preferred = m if self._available(m) else LOCAL_ALT[m]
            return preferred, [m, LOCAL_ALT[m]]
        chain = [m for m in CLOUD_CHAIN if self._available(m)] \
            or list(LOCAL_FALLBACK_ORDER)
        chain += [m for m in LOCAL_FALLBACK_ORDER if m not in chain]
        return chain[0], chain

    def _swap_job_model(self, job):
        """Move this job along its chain, and the whole voice tier with
        it: soul, chron, voice and op share the model and move as one."""
        before = dict(self.job_models)
        for step_job in TIE_JOB_ORDER:
            chain = [m for m in self.job_chains.get(step_job, [])
                     if m != self.job_models.get(step_job)]
            if chain and self._available(chain[0]):
                self.job_models[step_job] = chain[0]
        if self.job_models != before:
            self.notes.append("the grove's voice moved to "
                              + self.job_models["soul"])
        self.notes = self.notes[-4:]
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
        attempts = retries + 1
        model = self.job_models.get(job, "llama3.2:3b")
        # the flash-class clouds reason in a hidden channel: no `think`
        # key (with think:false the proxy streams the reasoning INTO the
        # answer's channel and the JSON never parses), and reasoning
        # headroom so the JSON survives the reasoning's budget — the
        # answer costs only its own tokens; the ceiling merely truncates
        headroom = 500 if ":cloud" in model else 0
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
        for _attempt in range(attempts):
            t0 = time.time()
            content = self._stream_chat(payload, deadline)
            self.latency = time.time() - t0
            if content:
                try:
                    out = json.loads(content)
                    self.job_fails[job] = 0
                    return out
                except json.JSONDecodeError:
                    m = re.search(r"\{[\s\S]*\}", content)
                    if m:
                        try:
                            out = json.loads(m.group(0))
                            self.job_fails[job] = 0
                            return out
                        except json.JSONDecodeError:
                            pass
            self.reason = self.reason or "unparseable JSON"
            self.job_fails[job] = self.job_fails.get(job, 0) + 1
            if self.job_fails[job] >= 2:
                self._swap_job_model(job)
                payload["model"] = self.job_models.get(job, model)
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
        return ":cloud" in str(self.job_models.get("soul", ""))

    def soul_gap(self):
        """(lo, hi) wall seconds between World Soul invitations, from
        the rules; the caller rolls inside the range."""
        p = rules.R["pacing"]["soul_gap_local" if not self.is_cloud()
                             else "soul_gap_cloud"]
        return p[0], p[1]


def status_line(llm):
    if llm is None:
        return "tier local — pure deterministic sim"
    if not llm.enabled:
        return f"tier local — {llm.reason}"
    base = (f"tier {llm.tier} · {llm.job_models.get('soul')} (soul) · "
            f"{llm.job_models.get('chron')} (prose)")
    if llm.tier != "local":
        base += f" · tokens today {llm.spend_today()}" + \
                (f"/{llm.budget}" if llm.budget else "")
    if llm.notes:
        base += f" · {llm.notes[-1]}"
    return base