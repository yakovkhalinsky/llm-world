"""Ollama client for the LLM's three small jobs.

Every call is: short prompt, JSON-schema `format`, token cap, timeout.
`chat_json` NEVER raises — it returns a parsed dict or None, so the
world keeps running on deterministic fallbacks whenever the model
is missing, slow, or writing nonsense.
"""

import json
import re
import time
import urllib.error
import urllib.request

DEFAULT_HOST = "http://127.0.0.1:11434"
DEFAULT_MODEL = "llama3.2:1b"
FAST_SUGGESTION = "llama3.2:3b"


class LLM:
    def __init__(self, model=DEFAULT_MODEL, host=DEFAULT_HOST, timeout=240.0):
        self.model = model
        self.host = host
        self.timeout = timeout
        self.enabled = True
        self.reason = ""
        self.latency = 0.0
        self._check()

    def _check(self):
        try:
            data = self._request("GET", "/api/tags", None)
        except Exception as e:
            self.enabled, self.reason = False, f"ollama unreachable ({e})"
            return
        names = set()
        for m in data.get("models", []):
            names.add(m.get("name", ""))
            names.add(m.get("model", ""))
            if m.get("name", "").endswith(":latest"):
                names.add(m["name"][:-7])
        if self.model not in names:
            self.enabled = False
            self.reason = (f"model '{self.model}' not pulled "
                           f"(run: ollama pull {self.model})")

    def _request(self, method, path, payload):
        url = self.host + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def chat_json(self, system, user, schema, max_tokens=160,
                  temperature=0.8, timeout=None, retries=1):
        """One streamed structured completion with a hard wall-clock
        deadline. dict on success, None on failure — callers fall back."""
        if not self.enabled:
            return None
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "stream": True,          # chunks arrive; a stalled call can be
            "format": schema,        # abandoned instead of hanging forever
            "options": {"num_predict": max_tokens, "num_ctx": 4096,
                        "temperature": temperature},
            "keep_alive": "30m",
        }
        deadline = time.time() + (timeout or self.timeout)
        for _attempt in range(retries + 1):
            t0 = time.time()
            content = self._stream_chat(payload, deadline)
            self.latency = time.time() - t0
            if content is None:
                return None          # connection or deadline failure
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                m = re.search(r"\{[\s\S]*\}", content)
                if m:
                    try:
                        return json.loads(m.group(0))
                    except json.JSONDecodeError:
                        pass
            self.reason = "unparseable JSON (retrying)" \
                if _attempt < retries else "unparseable JSON"
            self.last_raw = content[:300]
        return None

    def _stream_chat(self, payload, deadline):
        """Accumulate a streamed /api/chat response; None on failure."""
        content = []
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.host + "/api/chat", data=data, method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                for line in resp:
                    if time.time() > deadline:
                        self.reason = "deadline exceeded"
                        break
                    part = json.loads(line.decode())
                    content.append(part.get("message", {}).get("content", ""))
                    if part.get("done"):
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


def status_line(llm):
    if llm is None:
        return "LLM off — pure deterministic sim"
    base = f"LLM {llm.model} · last call {llm.latency:.1f}s"
    if llm.enabled and llm.reason:
        return base + f" · {llm.reason[:60]}"
    if not llm.enabled:
        return f"LLM off — {llm.reason}"
    return base


def describe(model, host):
    llm = LLM(model=model, host=host)
    return llm