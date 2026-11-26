"""Provider contracts and spending failure paths are always tested without network or account access."""

import base64
import io
import json
import tempfile
import time
import unittest
import wave
from contextlib import ExitStack
from decimal import Decimal
from email import policy
from email.parser import BytesParser
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from PIL import Image

from poemfilm import core, funding
from poemfilm import generate as g
from poemfilm import providers as p


def args(kind, **extra):
    values = {
        "action": kind,
        "edition": "demo",
        "line": "p1",
        "shot": "s1",
        "delivery": "平静",
        "take": "1",
        "max_usd": ".40",
        "estimate_only": False,
        "job": "job1",
    }
    return SimpleNamespace(**dict(values, **extra))


class Generation(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        poem = "谁怕？"
        (self.work / "poem.txt").write_text(poem)
        self.lines = [{"id": "p1", "kind": "poem", "text": poem}]
        self.shots = [{"id": "s1", "line_id": "p1", "prompt": "苏轼抬眼望向湿竹林。"}]
        self.cfg = {
            "schema_version": 1,
            "id": "work",
            "title": "定风波",
            "author": "苏轼",
            "default_edition": "demo",
            "profile": "office",
            "poem": {"path": "poem.txt", "sha256": g.digest(poem.encode())},
            "lines": self.lines,
            "references": [],
        }
        core.save_work(self.work, self.cfg)
        core.write_yaml(
            core.edition_path(self.work, "demo"),
            {"name": "demo", "script": None, "art": {}, "voice": {}, "shots": self.shots},
        )
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.reserve = self.stack.enter_context(
            patch.object(
                funding,
                "reserve",
                return_value=SimpleNamespace(
                    id="op1", org="org1", project="proj1", profile="office", key="mock"
                ),
            )
        )
        self.settle = self.stack.enter_context(
            patch.object(funding, "settle", return_value={"state": "success"})
        )
        self.bounds = self.stack.enter_context(
            patch.object(funding, "price_bounds", create=True, return_value=[])
        )
        self.http = self.stack.enter_context(patch.object(p, "post"))
        self.ws = self.stack.enter_context(patch.object(p, "voice"))
        self.text_usage = {
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
            "input_tokens_details": {"cached_tokens": 0},
        }
        self.voice_usage = {
            "input_tokens": 100,
            "output_tokens": 21,
            "total_tokens": 121,
            "input_token_details": {"text_tokens": 100, "audio_tokens": 0, "cached_tokens": 10},
            "output_token_details": {"text_tokens": 5, "audio_tokens": 16},
        }
        self.story = {"lines": self.lines, "shots": self.shots}
        self.png = io.BytesIO()
        Image.new("RGB", (1536, 864), "gray").save(self.png, format="PNG")
        self.quote = {
            "basis": "supplier_guaranteed_per_request",
            "provider": "openai",
            "model": p.ART_MODEL,
            "endpoint": "/v1/images/generations",
            "quality": "medium",
            "size": "1536x864",
            "valid_until": "2090-01-01T00:00:00Z",
            "upper_usd": ".21",
            "max_prompt_bytes": 10000,
            "max_reference_count": 0,
            "max_reference_pixels": 0,
            "max_reference_bytes": 0,
            "source_url": "https://help.openai.com/quote/example",
            "evidence_sha256": "a" * 64,
            "approval_digest": "b" * 64,
            "version": "contract-1",
        }

    def story_reply(self):
        self.http.return_value = p.Reply(
            {
                "status": "completed",
                "usage": self.text_usage,
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(self.story)}],
                    }
                ],
            },
            "req-1",
        )

    def art_reply(self):
        usage = {
            "input_tokens": 80,
            "output_tokens": 5300,
            "total_tokens": 5380,
            "input_tokens_details": {"text_tokens": 20, "image_tokens": 60},
        }
        self.http.return_value = p.Reply(
            {
                "data": [{"b64_json": base64.b64encode(self.png.getvalue()).decode()}],
                "usage": usage,
            },
            "req-1",
        )

    def voice_reply(self, transcript="谁怕？"):
        self.ws.return_value = p.Reply(
            {"status": "completed", "usage": self.voice_usage}, "r-audio", b"\0\1" * 480, transcript
        )

    def test_text_receipt_cache_and_schema(self):
        self.story_reply()
        result = g.handle(args("script"), self.work)
        self.assertEqual(self.http.call_args.args[1], "responses")
        request = self.http.call_args.args[2]
        self.assertTrue(request["text"]["format"]["strict"])
        self.assertEqual(request["max_output_tokens"], p.TEXT_LIMIT)
        self.assertFalse(request["store"])
        self.assertEqual(result["target"], "script")
        self.assertEqual(json.loads((self.work / result["path"]).read_text()), self.story)
        self.assertEqual(result["actual_usd"], "0.000165")
        self.assertTrue(g.handle(args("script"), self.work)["cached"])
        self.assertEqual(g.handle(args("script", estimate_only=True), self.work)["upper_usd"], "0")
        self.http.assert_called_once()
        self.reserve.assert_called_once()
        (self.work / result["path"]).write_text("{}")
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("script"), self.work)
        self.assertEqual(ctx.exception.code, "cache_corrupt")

    def test_changed_poem_is_billed_but_never_published(self):
        self.story = {"lines": [dict(self.lines[0], text="谁惧？")], "shots": self.shots}
        self.story_reply()
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("script"), self.work)
        self.assertEqual(ctx.exception.code, "paid_result_invalid")
        self.assertEqual(self.settle.call_args.kwargs["actual_usd"], Decimal(".000165"))
        self.assertFalse(list((self.work / "candidates").glob("*/record.json")))

    def test_unknown_line_no_remote(self):
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("voice", line="nonexistent"), self.work)
        self.assertEqual(ctx.exception.code, "unknown_target")
        self.reserve.assert_not_called()

    def test_image_request_guard_and_scoped_contract(self):
        self.assertIsNone(g.handle(args("art", estimate_only=True), self.work)["upper_usd"])
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("art"), self.work)
        self.assertEqual(ctx.exception.code, "pricing_unbounded")
        self.bounds.return_value = [
            dict(self.quote, max_prompt_bytes=1),
            dict(self.quote, valid_until="2000-01-01T00:00:00Z"),
            dict(self.quote, source_url="https://fake-openai.com/q"),
        ]
        self.assertIsNone(g.handle(args("art", estimate_only=True), self.work)["upper_usd"])
        self.http.assert_not_called()
        self.reserve.assert_not_called()
        self.bounds.return_value = [self.quote]
        self.art_reply()
        result = g.handle(args("art"), self.work)
        self.assertEqual(result["kind"], "art")
        self.assertEqual(self.http.call_args.args[1], "images/generations")
        self.assertEqual(self.reserve.call_args.kwargs["approval_digest"], "b" * 64)
        self.assertEqual((self.work / result["path"]).read_bytes(), self.png.getvalue())

    def test_high_quality_custom_dimensions_and_uncredentialed_reference_price(self):
        core.save_work(
            self.work, dict(self.cfg, profile=None, image={"size": "2048x1152", "quality": "high"})
        )
        estimate = g.handle(args("art", estimate_only=True), self.work)
        self.bounds.assert_not_called()
        self.assertIsNone(estimate["upper_usd"])
        self.assertEqual(estimate["reference_output_price"]["usd"], "0.165")
        self.assertFalse(estimate["reference_output_price"]["matches_requested_size"])
        core.save_work(self.work, dict(self.cfg, image={"size": "2048x1152", "quality": "high"}))
        self.bounds.return_value = [dict(self.quote, size="2048x1152", quality="high")]
        self.png = io.BytesIO()
        Image.new("RGB", (2048, 1152)).save(self.png, format="PNG")
        self.art_reply()
        out = g.handle(args("art"), self.work)
        self.assertEqual(out["size"], "2048x1152")
        self.assertEqual(out["quality"], "high")
        self.assertEqual(self.http.call_args.args[2]["size"], "2048x1152")

    def test_invalid_image_dimensions_never_send(self):
        for size in ("1920x1080", "128x128", "4096x2048", "3072x736", "x"):
            with self.subTest(size=size):
                core.save_work(self.work, dict(self.cfg, image={"size": size}))
                with self.assertRaises(core.Fail) as caught:
                    g.handle(args("art"), self.work)
                self.assertEqual(caught.exception.code, "invalid_image_settings")
        self.reserve.assert_not_called()

    def test_error_classification_and_improper_billing(self):
        for status, flag in [(401, True), (403, True), (429, True), (408, False), (500, False)]:
            self.assertEqual(p._response_error(status, "id").rejected, flag)
        err = p._response_error(
            429, "id", b'{"error":{"code":"credit_balance_exhausted","message":"sensitive"}}'
        )
        self.assertEqual(err.reason, "credit_balance_exhausted")
        self.bounds.return_value = [dict(self.quote, upper_usd="0.005")]
        self.art_reply()
        with self.assertRaises(core.Fail) as caught:
            g.handle(args("art"), self.work)
        self.assertEqual(caught.exception.code, "price_bound_exceeded")
        self.assertEqual(self.settle.call_args.kwargs["outcome"], "success")

    def test_image_edit_fingerprint_includes_content_and_model_input(self):
        ref = self.work / "ref.png"
        Image.new("RGB", (32, 32), "red").save(ref)
        core.save_work(self.work, dict(self.cfg, references=["ref.png"]))
        self.bounds.return_value = [
            dict(
                self.quote,
                endpoint="/v1/images/edits",
                max_reference_count=1,
                max_reference_pixels=1024,
                max_reference_bytes=4096,
            )
        ]
        self.art_reply()
        a = g.handle(args("art"), self.work)
        self.assertEqual(self.http.call_args.args[1], "images/edits")
        payload = self.http.call_args.args[2]
        self.assertEqual(payload["images"], [{"mime": "image/png", "data": ref.read_bytes()}])
        self.assertNotIn("input_fidelity", payload)
        Image.new("RGB", (32, 32), "blue").save(ref)
        b = g.handle(args("art"), self.work)
        self.assertNotEqual(a["id"], b["id"])

    def test_voice_transcript_audio_and_two_deliveries(self):
        self.voice_reply("谁怕")
        a = g.handle(args("voice"), self.work)
        with wave.open(str(self.work / a["path"]), "rb") as wav:
            self.assertEqual(
                (wav.getnchannels(), wav.getframerate(), wav.getnframes()), (1, 24000, 480)
            )
        self.assertTrue(a["text_match"])
        self.assertFalse(a["reviewed"])
        self.voice_reply("谁说怕")
        b = g.handle(args("voice", delivery="带笑"), self.work)
        self.assertNotEqual(a["id"], b["id"])
        self.assertFalse(b["text_match"])
        self.assertEqual(b["review_status"], "needs_review")
        self.assertEqual((self.work / b["path"]).with_name("transcript.txt").read_text(), "谁说怕")
        self.assertEqual(self.reserve.call_args.kwargs["scope"], "voice:p1")
        self.assertIsNone(core.load_edition(self.work, "demo")["script"])
        self.assertFalse(core.load_edition(self.work, "demo")["voice"])

    def test_budget_before_network_and_uncertain_usage(self):
        before = g.handle(args("voice", estimate_only=True), self.work)
        self.assertLess(Decimal(before["upper_usd"]), Decimal(".40"))
        self.reserve.side_effect = core.Fail("job_budget_exceeded", "no funds")
        with self.assertRaises(core.Fail):
            g.handle(args("voice"), self.work)
        self.ws.assert_not_called()
        self.reserve.side_effect = None
        self.ws.return_value = p.Reply({"status": "completed"}, "r")
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("voice"), self.work)
        self.assertEqual(ctx.exception.code, "remote_outcome_unknown")
        self.assertEqual(self.settle.call_args.kwargs["outcome"], "unknown")

    def test_interrupt_does_not_retry(self):
        self.ws.side_effect = p.RemoteProblem("deadline", request_id="rr")
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("voice"), self.work)
        self.assertEqual(ctx.exception.code, "remote_outcome_unknown")
        self.ws.assert_called_once()
        self.assertEqual(self.settle.call_args.kwargs["request_id"], "rr")

    def test_realtime_decodes_each_delta_and_waits_for_completed_response(self):
        from poemfilm.providers import _audio_events

        st = MagicMock()
        events = [
            {"type": "session.created"},
            {"type": "session.updated"},
            {"type": "response.created", "response": {"id": "r"}},
            {"type": "response.output_audio.delta", "response_id": "unrelated", "delta": "aGk="},
            {"type": "response.output_audio.delta", "response_id": "r", "delta": "AAE="},
            {"type": "response.output_audio.delta", "response_id": "r", "delta": "AgM="},
            {
                "type": "response.output_audio_transcript.done",
                "response_id": "r",
                "transcript": "谁怕？",
            },
            {
                "type": "response.done",
                "response": {"id": "r", "status": "completed", "usage": self.voice_usage},
            },
        ]
        st.recv.side_effect = [json.dumps(ev) for ev in events]
        got = _audio_events(
            st,
            {"voice": "marin", "text": "谁怕？", "instructions": "逐字读"},
            time.monotonic() + 10,
        )
        self.assertEqual(got.pcm, b"\0\1\2\3")
        self.assertEqual(got.transcript, "谁怕？")
        self.assertEqual(st.send.call_count, 2)
        self.assertEqual(
            json.loads(st.send.call_args.args[0])["response"]["max_output_tokens"], p.VOICE_LIMIT
        )

    def test_failed_image_processing_charges_known_cost(self):
        self.bounds.return_value = [self.quote]
        self.art_reply()
        self.http.return_value.payload["data"][0]["b64_json"] = "!!!!"
        with self.assertRaises(core.Fail) as ctx:
            g.handle(args("art"), self.work)
        self.assertEqual(ctx.exception.code, "paid_result_invalid")
        self.assertIn("actual_usd", self.settle.call_args.kwargs)


class TransportContract(unittest.TestCase):
    def test_image_edit_posts_ordered_reference_files_and_utf8_form_fields(self):
        ticket = SimpleNamespace(key="test-fake", org="org-test", project="project-test")
        fields = {
            "model": p.ART_MODEL,
            "prompt": "苏轼回首。\n衣袖沾雨。",
            "size": "2048x1152",
            "quality": "high",
            "n": 1,
            "output_format": "png",
        }
        images = []
        for fmt, color in (("PNG", "black"), ("JPEG", "red")):
            buffer = io.BytesIO()
            Image.new("RGB", (16, 16), color).save(buffer, format=fmt)
            images.append({"mime": Image.MIME[fmt], "data": buffer.getvalue()})
        with patch.object(p, "build_opener") as opener:
            transport = opener.return_value.open
            response = transport.return_value.__enter__.return_value
            response.read.return_value = b'{"data":[]}'
            p.perform(ticket, "art", {**fields, "images": images})
            transport.assert_called_once()
            request = transport.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://api.openai.com/v1/images/edits")
        content_type = request.get_header("Content-type")
        body = b"".join(request.data)
        self.assertEqual(request.get_header("Content-length"), str(len(body)))
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        self.assertEqual(message.get_content_type(), "multipart/form-data")
        self.assertFalse(message.defects)
        parts = list(message.iter_parts())
        self.assertEqual(
            [part.get_param("name", header="Content-Disposition") for part in parts],
            [*fields, "image[]", "image[]"],
        )
        self.assertEqual(
            [part.get_payload(decode=True) for part in parts[:-2]],
            [str(value).encode() for value in fields.values()],
        )
        self.assertEqual(
            [part.get_filename() for part in parts[-2:]], ["reference-01.png", "reference-02.jpeg"]
        )
        for part, ref in zip(parts[-2:], images):
            self.assertEqual(part.get_content_type(), ref["mime"])
            self.assertEqual(part.get_payload(decode=True), ref["data"])

    def test_image_generation_posts_json(self):
        ticket = SimpleNamespace(key="test-fake", org="org-test", project="project-test")
        spec = {"model": p.ART_MODEL, "prompt": "黄州烟雨"}
        with patch.object(p, "build_opener") as opener:
            transport = opener.return_value.open
            transport.return_value.__enter__.return_value.read.return_value = b'{"data":[]}'
            p.perform(ticket, "art", spec)
            transport.assert_called_once()
            request = transport.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.openai.com/v1/images/generations")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data), spec)

    def test_http_is_single_attempt_and_will_not_read_proxy_environment(self):
        from urllib.request import ProxyHandler

        from poemfilm import providers

        ticket = SimpleNamespace(key="test-fake", org="org-test", project="project-test")
        with patch.object(providers, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'{"id":"test"}'
            response.headers = {"x-request-id": "test-id"}
            self.assertEqual(providers.post(ticket, "responses", {}).request_id, "test-id")
            handlers = opener.call_args.args
            self.assertTrue(any(isinstance(h, ProxyHandler) and h.proxies == {} for h in handlers))
            self.assertTrue(any(isinstance(h, providers.NoRedirect) for h in handlers))
            opener.return_value.open.assert_called_once()

    def test_upgraded_socket_errors_are_uncertain_and_quota_codes_are_distinct(self):
        from poemfilm import providers

        ws = MagicMock()
        ws.recv.return_value = json.dumps(
            {"type": "error", "error": {"message": "misleading response"}}
        )
        with self.assertRaises(providers.RemoteProblem) as caught:
            providers._audio_events(ws, {}, time.monotonic() + 1)
        self.assertFalse(caught.exception.rejected)
        for status, code in (
            (429, "insufficient_quota"),
            (429, "rate_limit_exceeded"),
            (401, "credential_rejected"),
            (403, "permission_denied"),
        ):
            result = providers._response_error(
                status, "r", json.dumps({"error": {"code": code}}).encode()
            )
            self.assertTrue(result.rejected)
            self.assertEqual(result.reason, code)
