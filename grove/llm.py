"""Ollama client for the LLM's three jobs, with tiered model chains.

Cloud models (reasoning-capable, gated behind an ollama subscription)
are 10-20x faster than this CPU can manage and write far better prose.
Local models keep the world self-contained: no network, no account.
The chain machinery unifies both: start with the preferred tier, and
auto-fall to the next model after repeated failures — the world runs
on whatever is available, and on templates alone when nothing is.

Every call is: short prompt, JSON-schema `format`, `think` disabled,
token cap, hard wall-clock deadline. `chat_json` NEVER raises.
"""

import json
import re
import time
import urllib.error
import urllib.request

DEFAULT_HOST = "http://127.0.0.1:11434"

CLOUD_CHAIN = ["glm-5.2:cloud", "deepseek-v4-pro:cloud", "llama3.2:1b"]
LOCAL_CHAIN = ["llama3.2:1b", "llama3.2:3b"]


class LLM:
    def __init__(self, model="auto", tier="auto", host=DEFAULT_HOST,
                 timeout=240.0):
        self.host = host
        self.timeout = timeout
        self.tier = tier                  # auto | cloud | local
        self.enabled = True
        self.reason = ""
        self.latency = 0.0
        self.last_raw = None
        self.fail_streak = 0
        self.notes = []
        self._tags = self._fetch_tags()
        if model in ("auto", None, ""):
            base = CLOUD_CHAIN if self._prefer_cloud() else LOCAL_CHAIN
            self.chain = list(dict.fromkeys(base))
        else:
            self.chain = [model] + [f for f in
                (CLOUD_CHAIN if ":cloud" in model else LOCAL_CHAIN)
                if f != model]
        self.fallbacks = list(self.chain)
        self.model = None
        for cand in self.chain:
            self.model = cand
            if self._model_ok(cand):
                break
        if self.model is None:
            self.enabled = False
            self.reason = "no usable model in " + ", ".join(self.chain)

    def _fetch_tags(self):
        try:
            return self._request("GET", "/api/tags", None)
        except Exception as e:
            self.enabled = False
            self.reason = f"ollama unreachable ({e})"
            return {"models": []}

    def _prefer_cloud(self):
        if self.tier == "cloud":
            return True
        if self.tier == "local":
            return False
        # auto: try the cloud first; the failure machinery falls back
        return True

    def _model_ok(self, name):
        wanted = name
        for m in self._tags.get("models", []):
            if m.get("name") == wanted or m.get("model") == wanted or \
                    (m.get("name", "").endswith(":latest") and
                     m["name"][:-7] == wanted):
                return True
        return False

    def _advance_chain(self):
        """After repeated failures, move to the next usable model."""
        while self.fallbacks:
            cand = self.fallbacks.pop(0)
            if self._model_ok(cand):
                self.model = cand
                self.fail_streak = 0
                self.notes.append(f"soul moved to {cand}")
                return True
        self.enabled = False
        self.reason = self.reason or "every model in the chain failed"
        return False

    def _request(self, method, path, payload):
        url = self.host + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    def is_cloud(self):
        return self.model is not None and self.model.endswith(":cloud")

    def soul_gap(self):
        """Wall seconds between World Soul invitations, by tier."""
        if self.is_cloud():
            return 40 + 40   # a fast model can speak often
        return 150 + 90      # a slow one must not starve the prose

    def chat_json(self, system, user, schema, max_tokens=160,
                  temperature=0.8, retries=1):
        """One streamed structured completion. dict on success, None on
        any failure — callers fall back and the chain may advance."""
        if not self.enabled:
            return None
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "stream": True,          # chunks arrive; a stalled call can be
            "format": schema,        # abandoned instead of hanging forever
            "think": False,          # reasoning models must not spend the
                                     # token budget thinking
            "options": {"num_predict": max_tokens, "num_ctx": 4096,
                        "temperature": temperature},
            "keep_alive": "30m",
        }
        deadline = time.time() + self.timeout
        attempts = (retries + 1) * 3 if self.is_cloud() else retries + 1
        for _attempt in range(attempts):
            t0 = time.time()
            content = self._stream_chat(payload, deadline)
            self.latency = time.time() - t0
            if content:
                try:
                    out = json.loads(content)
                    self.fail_streak = 0
                    return out
                except json.JSONDecodeError:
                    m = re.search(r"\{[\s\S]*\}", content)
                    if m:
                        try:
                            out = json.loads(m.group(0))
                            self.fail_streak = 0
                            return out
                        except json.JSONDecodeError:
                            pass
            self.reason = "unparseable JSON" \
                if self.reason == "" else self.reason
            self.fail_streak += 1
            if self.fail_streak >= 3:
                if self._advance_chain():
                    payload["model"] = self.model
                    deadline = time.time() + self.timeout
                else:
                    return None
        return None

    def _stream_chat(self, payload, deadline):
        """Accumulate a streamed /api/chat response; None on failure.
        Reasoning chunks may carry their text in `thinking` — never
        treated as the answer."""
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
                        break
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.reason = f"call failed: {e}"
            self.fail_streak += 1
            if self.fail_streak >= 3:
                self._advance_chain()
            return None
        except (json.JSONDecodeError, ConnectionError):
            self.reason = "bad stream data"
            return None
        text = "".join(content)
        self.last_raw = text[:300]
        return text if text else None


def status_line(llm):
    if llm is None:
        return "LLM off — pure deterministic sim"
    if not llm.enabled:
        return f"LLM off — {llm.reason}"
    base = f"LLM {llm.model} · last call {llm.latency:.1f}s"
    if llm.notes:
        base += f" · {llm.notes[-1]}"
    if llm.fail_streak:
        base += f" · {llm.fail_streak} fails ×"
    elif llm.reason and False:
        base += f" · {llm.reason[:40]}"
    return base