"""The model client: which model each job uses, what happens when one is
not installed, and how calls are kept from loading two models at once.
Against a fake Ollama on loopback — nothing here needs a real one:

    python3 -m unittest tests.test_models
"""

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from grove import llm as llmm

QWEN = "qwen3:4b-instruct-2507-q4_K_M"
GEMMA = "gemma3:4b"
CLOUD = "deepseek-v4.1-flash:cloud"
CHOICE_JOB = "op"
PROSE_JOB = "chron"


class FakeOllama:
    """/api/tags, /api/show, /api/ps, /api/generate, /api/chat, /api/embed
    — just enough of Ollama, recording what it was sent."""

    def __init__(self, tags=(), cloud=(), ps=(), chat_404=(),
                 reply=None, delay=0.0, chat_500=(), show_fail=0):
        self.tags = list(tags)
        self.cloud = set(cloud)
        self.ps = list(ps)
        self.chat_404 = set(chat_404)
        self.chat_500 = set(chat_500)
        self.show_fail = show_fail        # fail this many /api/show first
        self.shows = 0
        self.reply = reply or {"why": "because", "intent": "so",
                               "verdict": "well", "answer": "yes"}
        self.delay = delay
        self.chats, self.unloads, self.embeds = [], [], []
        self.active = 0
        self.peak = 0
        lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/api/tags":
                    self._send(200, {"models": [{"name": n}
                                                for n in fake.tags]})
                elif self.path == "/api/ps":
                    self._send(200, {"models": [{"name": n}
                                                for n in fake.ps]})
                else:
                    self._send(404, {"error": "no"})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/api/show":
                    fake.shows += 1
                    if fake.show_fail > 0:
                        fake.show_fail -= 1
                        self._send(500, {"error": "busy"})
                    elif body.get("model") in fake.cloud:
                        self._send(200, {"details": {}})
                    else:
                        self._send(404, {"error": "not found"})
                elif self.path == "/api/generate":
                    fake.unloads.append(body)
                    fake.ps = [m for m in fake.ps
                               if m != body.get("model")]
                    self._send(200, {"done": True})
                elif self.path == "/api/embed":
                    fake.embeds.append(body)
                    if not any(llmm.same_model(body["model"], t)
                               for t in fake.tags):
                        self._send(404, {"error": "model not found"})
                    else:
                        self._send(200, {"embeddings": [[0.1, 0.2]]
                                         * len(body["input"])})
                elif self.path == "/api/chat":
                    with lock:
                        fake.active += 1
                        fake.peak = max(fake.peak, fake.active)
                    try:
                        fake.chats.append(body)
                        if body["model"] in fake.chat_404:
                            self._send(404, {"error": "model not found"})
                            return
                        if body["model"] in fake.chat_500:
                            self._send(500, {"error": "runner crashed"})
                            return
                        time.sleep(fake.delay)
                        if body["model"] not in fake.ps:
                            fake.ps.append(body["model"])
                        lines = [{"message": {"content":
                                              json.dumps(fake.reply)}},
                                 {"done": True, "prompt_eval_count": 3,
                                  "eval_count": 4}]
                        data = b"".join(json.dumps(x).encode() + b"\n"
                                        for x in lines)
                        self.send_response(200)
                        self.send_header("Content-Type",
                                         "application/x-ndjson")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                    finally:
                        with lock:
                            fake.active -= 1
                else:
                    self._send(404, {"error": "no"})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.host = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def dead_host():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return "http://127.0.0.1:%d" % port


class ChainTest(unittest.TestCase):
    """Which models a job tries, before anything is checked."""

    def test_defaults_are_the_pages_models(self):
        self.assertEqual(llmm.CHOICE_MODEL, QWEN)
        self.assertEqual(llmm.PROSE_MODEL, GEMMA)
        self.assertEqual(llmm.EMBED_MODEL, "nomic-embed-text")
        self.assertEqual(llmm.CLOUD_MODEL, CLOUD)

    def test_choice_jobs_want_qwen_and_prose_jobs_gemma(self):
        self.assertEqual(llmm.job_chain(CHOICE_JOB, "local")[:2],
                         [QWEN, GEMMA])
        self.assertEqual(llmm.job_chain(PROSE_JOB, "local")[:2],
                         [GEMMA, QWEN])

    def test_cloud_tier_tries_the_cloud_first(self):
        self.assertEqual(llmm.job_chain(CHOICE_JOB, "cloud")[:3],
                         [CLOUD, QWEN, GEMMA])
        self.assertNotIn(CLOUD, llmm.job_chain(CHOICE_JOB, "local"))

    def test_llama_is_only_the_last_resort(self):
        for job in llmm.JOB_ROLE:
            chain = llmm.job_chain(job, "cloud")
            self.assertEqual(chain[-1], "llama3.2:3b")
            self.assertNotEqual(chain[0], "llama3.2:3b")

    def test_a_pinned_model_is_the_whole_chain(self):
        self.assertEqual(llmm.job_chain(PROSE_JOB, "cloud", "x:1b"),
                         ["x:1b"])

    def test_a_bare_name_is_its_latest_tag(self):
        self.assertTrue(llmm.same_model("nomic-embed-text",
                                        "nomic-embed-text:latest"))
        self.assertFalse(llmm.same_model("gemma3:4b", "gemma3:4b-it"))

    def test_think_off_only_for_thinking_local_tags(self):
        self.assertTrue(llmm.needs_think_off("qwen3:4b"))
        self.assertTrue(llmm.needs_think_off("smollm3:3b"))
        self.assertFalse(llmm.needs_think_off(QWEN))
        self.assertFalse(llmm.needs_think_off(GEMMA))
        self.assertFalse(llmm.needs_think_off(CLOUD))


class SelectionTest(unittest.TestCase):

    def make(self, **kw):
        tags = kw.pop("tags", (QWEN, GEMMA, "nomic-embed-text:latest"))
        self.fake = FakeOllama(tags=tags, cloud=kw.pop("cloud", ()),
                               ps=kw.pop("ps", ()),
                               chat_404=kw.pop("chat_404", ()),
                               delay=kw.pop("delay", 0.0))
        self.addCleanup(self.fake.close)
        kw.setdefault("tier", "local")
        kw.setdefault("lock_path", "")
        return llmm.LLM(host=self.fake.host, timeout=10, **kw)

    def test_each_job_gets_its_own_model(self):
        llm = self.make()
        self.assertEqual(llm.job_models[CHOICE_JOB], QWEN)
        self.assertEqual(llm.job_models[PROSE_JOB], GEMMA)
        self.assertEqual(llm.missing, [])
        line = llmm.status_line(llm)
        self.assertNotIn("not installed", line)
        self.assertIn("qwen3:4b-instruct-2507", line)
        self.assertIn("gemma3:4b", line)

    def test_flags_choose_the_models(self):
        llm = self.make(tags=("a:1b", "b:2b"), choice_model="a:1b",
                        prose_model="b:2b")
        self.assertEqual(llm.job_models[CHOICE_JOB], "a:1b")
        self.assertEqual(llm.job_models[PROSE_JOB], "b:2b")

    def test_cloud_tier_uses_the_cloud_when_ollama_knows_it(self):
        llm = self.make(tier="cloud", cloud=(CLOUD,))
        self.assertEqual(llm.job_models[CHOICE_JOB], CLOUD)
        self.assertEqual(llm.job_state(CHOICE_JOB), "ok")

    def test_cloud_tier_falls_back_to_the_local_models(self):
        llm = self.make(tier="cloud")
        self.assertEqual(llm.job_models[CHOICE_JOB], QWEN)
        self.assertIn(CLOUD, llm.missing)
        self.assertIn("not installed: " + CLOUD, llmm.status_line(llm))

    def test_a_missing_model_is_named_not_a_silent_404(self):
        llm = self.make(tags=(GEMMA, "nomic-embed-text:latest"))
        self.assertEqual(llm.job_models[CHOICE_JOB], GEMMA)   # fallback
        self.assertEqual(llm.job_state(CHOICE_JOB), "fallback")
        self.assertIn(QWEN, llm.missing)
        line = llmm.status_line(llm)
        self.assertIn("not installed: " + QWEN, line)
        st = llm.model_status()
        self.assertEqual(st["jobs"][CHOICE_JOB]["wanted"], QWEN)
        self.assertEqual(st["jobs"][CHOICE_JOB]["model"], GEMMA)
        self.assertIn(QWEN, st["missing"])
        json.dumps(st)                    # the API can carry it

    def test_nothing_installed_says_so_and_never_calls(self):
        llm = self.make(tags=())
        self.assertIsNone(llm.job_models[CHOICE_JOB])
        self.assertFalse(llm.ready())
        self.assertIsNone(llm.chat_json("s", "u", {}, job=CHOICE_JOB))
        self.assertIn("no model installed", llm.reason)
        self.assertEqual(self.fake.chats, [])
        line = llmm.status_line(llm)
        self.assertIn("not installed", line)
        self.assertIn("on templates", line)
        self.assertEqual(llm.model_status()["jobs"][CHOICE_JOB]["state"],
                         "missing")

    def test_a_404_marks_the_model_missing_and_moves_on(self):
        # in /api/tags but the call says otherwise: a stale list
        llm = self.make(chat_404=(QWEN,))
        out = llm.chat_json("s", "u", {"type": "object"}, job=CHOICE_JOB)
        self.assertIsNotNone(out)                 # answered by gemma
        self.assertEqual([c["model"] for c in self.fake.chats],
                         [QWEN, GEMMA])
        self.assertIn(QWEN, llm.missing)
        self.assertEqual(llm.job_models[CHOICE_JOB], GEMMA)
        self.assertIn(QWEN, llmm.status_line(llm))
        # and it is not asked for again
        llm.chat_json("s", "u", {"type": "object"}, job=CHOICE_JOB)
        self.assertEqual(self.fake.chats[-1]["model"], GEMMA)

    def test_a_model_pulled_later_is_picked_up(self):
        llm = self.make(tags=(GEMMA,))
        self.assertEqual(llm.job_models[CHOICE_JOB], GEMMA)
        self.fake.tags.append(QWEN)
        llm.next_probe = 0
        llm.ready()                    # starts the probe, does not wait
        llm.wait_for_probe()
        self.assertEqual(llm.job_models[CHOICE_JOB], QWEN)
        self.assertNotIn(QWEN, llm.missing)

    def test_unreachable_is_retried_not_given_up(self):
        llm = llmm.LLM(host=dead_host(), timeout=1.0, lock_path="")
        self.assertFalse(llm.enabled)
        self.assertIn("unreachable", llm.reason)
        self.assertIn("retrying", llmm.status_line(llm))
        self.assertIsNone(llm.chat_json("s", "u", {}, job=CHOICE_JOB))
        self.assertEqual(llm.model_status()["jobs"][CHOICE_JOB]["state"],
                         "unreachable")

    def test_off_is_off(self):
        self.assertIn("AI off", llmm.status_line(None))


class PayloadTest(unittest.TestCase):

    def run_one(self, model, **kw):
        fake = FakeOllama(tags=(model,), cloud=(model,) if
                          llmm.is_cloud(model) else ())
        self.addCleanup(fake.close)
        llm = llmm.LLM(host=fake.host, timeout=10, tier="local",
                       model=model, lock_path="", **kw)
        schema = {"type": "object", "properties": {"why": {"type":
                                                            "string"}}}
        self.assertIsNotNone(llm.chat_json("s", "u", schema,
                                           job=CHOICE_JOB))
        return fake.chats[-1], schema

    def test_schema_goes_in_format_and_keep_alive_is_short(self):
        body, schema = self.run_one(QWEN)
        self.assertEqual(body["format"], schema)
        self.assertEqual(body["keep_alive"], "2m")
        self.assertNotIn("think", body)          # instruct build

    def test_keep_alive_is_configurable(self):
        body, _ = self.run_one(GEMMA, keep_alive="30s")
        self.assertEqual(body["keep_alive"], "30s")

    def test_thinking_local_tags_get_think_false(self):
        body, _ = self.run_one("qwen3:4b")
        self.assertIs(body["think"], False)

    def test_cloud_gets_no_think_key_and_headroom(self):
        body, _ = self.run_one(CLOUD)
        self.assertNotIn("think", body)
        self.assertGreater(body["options"]["num_predict"], 3000)


class MemoryTest(unittest.TestCase):
    """The station is a 16 GB Pi with its swap mostly used: qwen and
    gemma must never be resident together, and calls take turns."""

    def make(self, **kw):
        self.fake = FakeOllama(tags=(QWEN, GEMMA, "nomic-embed-text:latest"),
                               ps=kw.pop("ps", ()), delay=kw.pop("delay", 0))
        self.addCleanup(self.fake.close)
        kw.setdefault("lock_path", "")
        return llmm.LLM(host=self.fake.host, timeout=10, tier="local", **kw)

    def test_the_other_chat_model_is_unloaded_first(self):
        llm = self.make(ps=(QWEN, "nomic-embed-text:latest"))
        llm.chat_json("s", "u", {}, job=PROSE_JOB)          # gemma
        self.assertEqual([u["model"] for u in self.fake.unloads], [QWEN])
        self.assertEqual(self.fake.unloads[0]["keep_alive"], 0)
        llm.chat_json("s", "u", {}, job=CHOICE_JOB)         # qwen
        self.assertEqual(self.fake.unloads[-1]["model"], GEMMA)

    def test_resident_many_leaves_them_be(self):
        llm = self.make(ps=(QWEN,), resident="many")
        llm.chat_json("s", "u", {}, job=PROSE_JOB)
        self.assertEqual(self.fake.unloads, [])

    def test_calls_take_turns(self):
        llm = self.make(delay=0.2)
        ts = [threading.Thread(target=llm.chat_json,
                               args=("s", "u", {}),
                               kwargs={"job": j})
              for j in (CHOICE_JOB, PROSE_JOB, CHOICE_JOB, PROSE_JOB)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(self.fake.chats), 4)
        self.assertEqual(self.fake.peak, 1)

    def test_the_lock_file_is_shared_across_clients(self):
        path = tempfile.mktemp(prefix="llm-world-lock-")
        a = self.make(delay=0.2, lock_path=path)
        b = llmm.LLM(host=self.fake.host, timeout=10, tier="local",
                     lock_path=path)
        ts = [threading.Thread(target=c.chat_json, args=("s", "u", {}),
                               kwargs={"job": CHOICE_JOB}) for c in (a, b)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(self.fake.peak, 1)


class EmbedTest(unittest.TestCase):

    def test_a_bare_embed_name_matches_latest(self):
        fake = FakeOllama(tags=(QWEN, GEMMA, "nomic-embed-text:latest"))
        self.addCleanup(fake.close)
        llm = llmm.LLM(host=fake.host, timeout=10, tier="local",
                       lock_path="")
        self.assertTrue(llm.embed_ok)
        self.assertEqual(llm.embed(["a", "b"]), [[0.1, 0.2]] * 2)
        self.assertEqual(fake.embeds[-1]["model"], "nomic-embed-text")

    def test_a_missing_embedder_is_reported(self):
        fake = FakeOllama(tags=(QWEN, GEMMA))
        self.addCleanup(fake.close)
        llm = llmm.LLM(host=fake.host, timeout=10, tier="local",
                       lock_path="")
        self.assertFalse(llm.embed_ok)
        self.assertIsNone(llm.embed(["a"]))
        self.assertEqual(fake.embeds, [])
        self.assertIn("nomic-embed-text", llmm.status_line(llm))
        self.assertEqual(llm.model_status()["embed"]["state"], "missing")

    def test_memory_embeds_through_the_client(self):
        from grove import memory
        fake = FakeOllama(tags=(QWEN, GEMMA, "nomic-embed-text:latest"))
        self.addCleanup(fake.close)
        llm = llmm.LLM(host=fake.host, timeout=10, tier="local",
                       lock_path="", embed_model="nomic-embed-text")
        self.assertEqual(memory.embed(llm, ["x"]), [[0.1, 0.2]])
        self.assertIn("keep_alive", fake.embeds[-1])


if __name__ == "__main__":
    unittest.main()
