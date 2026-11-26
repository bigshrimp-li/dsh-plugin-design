import hashlib
import json
import shutil
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from poemfilm import core, funding
from poemfilm.workspace import init_work


class FakeKeychain:
    def __init__(self):
        self.items = {}

    def add(self, account, secret):
        self.items[account] = secret

    def remove(self, account):
        self.items.pop(account, None)

    def get(self, account):
        if account not in self.items:
            raise core.Fail("credential_missing", "测试钥匙串没有此条目。", 6)
        return self.items[account]

    def probe(self, account):
        self.get(account)


class FundingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.work = self.base / "诗"
        self.cache = FakeKeychain()
        self.enterContext(mock.patch.object(core, "state_dir", return_value=self.base / "state"))
        self.enterContext(mock.patch.object(funding, "Keychain", return_value=self.cache))
        self.enterContext(mock.patch.object(funding, "_prompt", return_value="fake-project-test-key"))
        self.check = self.enterContext(
            mock.patch.object(funding, "_read_models", side_effect=AssertionError("offline"))
        )
        source = self.base / "原词.txt"
        source.write_text("竹杖芒鞋轻胜马", encoding="utf-8")
        init_work(
            SimpleNamespace(
                dir=self.work, poem=source, edition="初稿", reference=[], title="试", author="检"
            )
        )
        self.command("auth", "login", org="org-example", project="proj_example")
        self.record = {
            "schema_version": 1,
            "organization_id": "org-example",
            "project_id": "proj_example",
            "source": "chatgpt_subscription_api_grant",
            "currency": "USD",
            "grant_remaining_usd": "3.00",
            "purchased_balance_usd": "0",
            "other_funds_usd": "0",
            "billing_mode": "prepaid",
            "auto_recharge": False,
            "exclusive_usage": True,
            "safety_reserve_usd": "0.50",
            "checked_by": "test-owner",
            "evidence_ref": "test/receipt",
            "checked_at": funding._iso(time.time() - 1),
            "valid_until": funding._iso(time.time() + 1200),
            "grant_expires_at": funding._iso(time.time() + 3600),
        }
        self.bind(self.record)

    def command(self, cmd, action, work=None, profile="demo", **kw):
        return funding.handle(
            SimpleNamespace(command=cmd, action=action, profile=profile, **kw), work or self.work
        )

    def bind(self, record, work=None, profile="demo"):
        path = self.base / "核对.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return self.command("funding", "bind", work, profile, record=path)

    def reserve(
        self, op="first", scope="voice:line-01", upper="1", work=None, profile="demo", job=None, **kw
    ):
        args = {
            "profile": profile,
            "job": job,
            "edition": "初稿",
            "scope": scope,
            "op_key": op,
            "target_key": scope,
            "upper_usd": upper,
            "max_usd": upper,
            "duration_s": 10,
            "model": "voice",
            "pricing_version": "p0",
        }
        args.update(kw)
        return funding.reserve(work or self.work, **args)

    def job(self, cap="2", count=2):
        return self.command(
            "job",
            "authorize",
            scope="voice:line-01",
            max_usd=cap,
            max_generations=count,
            edition="初稿",
        )["job"]

    def error(self, expected, fn, *args, **kwargs):
        with self.assertRaises(core.Fail) as ctx:
            fn(*args, **kwargs)
        self.assertEqual(expected, ctx.exception.code)

    def newer(self, **changes):
        return {**self.record, "checked_at": funding._iso(time.time()), **changes}

    def test_auth_status_and_rejection_do_not_misreport_funds(self):
        self.assertEqual(self.command("auth", "status")["credential_state"], "configured")
        self.check.side_effect = None
        self.check.return_value = (403, None)
        self.error("credential_permission_denied", self.command, "auth", "check")
        self.assertEqual(self.command("auth", "status")["credential_state"], "configured")
        self.check.return_value = (401, None)
        self.error("credential_rejected", self.command, "auth", "check")
        self.assertEqual(self.command("funding", "status")["state"], "blocked")
        self.error("credential_rejected", self.reserve)

    def test_mixed_or_unknown_funds_stop_before_sending(self):
        self.error("funding_mixed", self.bind, self.newer(purchased_balance_usd="0.01"))
        self.error("funding_mixed", self.reserve)
        self.error("funding_paid_fallback", self.bind, self.newer(auto_recharge=True))
        self.error("funding_paid_fallback", self.reserve)
        self.error("funding_unmanaged_traffic", self.bind, self.newer(exclusive_usage=False))
        self.error("funding_unmanaged_traffic", self.reserve)
        self.error("funding_expired", self.bind, self.newer(valid_until=funding._iso(time.time() - 2)))
        self.error("funding_expired", self.reserve)
        self.check.assert_not_called()

    def test_work_copy_and_credential_rotation_do_not_restore_authority(self):
        job = self.job()
        other = self.base / "copy"
        shutil.copytree(self.work, other)
        self.error("funding_profile_mismatch", self.reserve, work=other)
        self.bind(self.record, work=other)
        self.error("job_scope_denied", self.reserve, work=other, job=job)
        ticket = self.reserve(job=job)
        funding.settle(ticket, outcome="unknown")
        self.command("auth", "logout")
        self.assertEqual(self.command("auth", "status")["credential_state"], "missing")
        self.command("auth", "login", org="org-example", project="proj_example")
        self.error("funding_stale_record", self.bind, self.record)
        self.bind(self.newer())
        self.assertEqual(self.command("funding", "status")["reserved_usd"], "1")
        self.error("remote_outcome_unknown", self.reserve, op="other-take")
        self.error("job_scope_denied", self.reserve, op="another", scope="voice:other", job=job)

    def test_organization_limits_between_projects_and_works(self):
        other = self.base / "copy"
        shutil.copytree(self.work, other)
        self.command("auth", "login", profile="second", org="org-example", project="proj_second")
        self.bind({**self.record, "project_id": "proj_second"}, work=other, profile="second")
        first = self.reserve(upper="2")
        self.error(
            "funding_insufficient", self.reserve, op="sec", upper="1", work=other, profile="second"
        )
        funding.settle(first, actual_usd="0.25", usage={"tokens": 3})
        second = self.reserve(op="sec", upper="2", work=other, profile="second")
        funding.settle(second, actual_usd="0.4", usage={"tokens": 4})
        self.assertEqual(self.command("funding", "status")["after_snapshot_usd"], "0.65")

    def test_atomic_job_authorization_and_settlement(self):
        job = self.job(cap="0.5", count=2)

        def attempt(i):
            try:
                return self.reserve(op=str(i), upper=".3", job=job)
            except core.Fail as exc:
                return exc.code

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(attempt, [1, 2]))
        self.assertIn("job_budget_exceeded", results)
        winner = next(r for r in results if isinstance(r, funding.Ticket))
        self.assertNotIn("fake-project", repr(winner))
        funding.settle(winner, actual_usd="0.1", usage={"tokens": 4})
        other = self.reserve(op="take3", upper=".3", job=job)
        funding.settle(other, outcome="unknown")
        self.assertEqual(self.command("job", "status", job=job)["remaining_generations"], 0)
        self.assertEqual(self.command("funding", "status")["reserved_usd"], "0.3")

    def test_owner_reconciliation_is_explicit_and_idempotent(self):
        job = self.job(cap="2", count=2)
        ticket = self.reserve(job=job)
        entry = {
            "operation_id": ticket.id,
            "expected_reserved_usd": "1",
            "outcome": "charged",
            "actual_usd": "0.25",
            "reflected_in_snapshot": True,
            "evidence_ref": "billing/line-1",
        }
        self.error(
            "funding_reconciliation_conflict", self.bind, self.newer(reconciled_operations=[entry])
        )
        funding.settle(ticket, outcome="unknown")
        self.bind(self.newer())
        self.assertEqual(self.command("funding", "status")["reserved_usd"], "1")
        self.error("remote_outcome_unknown", self.reserve, op="take2", job=job)
        self.error(
            "funding_reconciliation_conflict",
            self.bind,
            self.newer(reconciled_operations=[{**entry, "expected_reserved_usd": "0.99"}]),
        )
        reconciled = self.newer(reconciled_operations=[entry], grant_remaining_usd="2.75")
        self.bind(reconciled)
        self.bind(reconciled)
        status = self.command("job", "status", job=job)
        self.assertEqual((status["remaining_usd"], status["remaining_generations"]), ("1.75", 1))
        self.assertEqual(self.command("funding", "status")["available_usd"], "2.25")
        self.error(
            "funding_reconciliation_conflict",
            self.bind,
            self.newer(reconciled_operations=[{**entry, "outcome": "not_sent", "actual_usd": "0"}]),
        )
        self.error("operation_already_completed", self.reserve, job=job)
        another = self.reserve(op="explicit-new-take", job=job)
        funding.settle(another, outcome="rejected")

    def test_accounted_costs_require_completed_operations(self):
        ticket = self.reserve()
        funding.settle(ticket, outcome="unknown")
        self.error(
            "funding_reconciliation_unknown", self.bind, self.newer(accounted_operations=[ticket.id])
        )
        record = self.newer(
            reconciled_operations=[
                {
                    "operation_id": ticket.id,
                    "expected_reserved_usd": "1",
                    "outcome": "not_charged",
                    "actual_usd": "0",
                    "evidence_ref": "billing/excluded",
                }
            ]
        )
        self.bind(record)
        self.assertEqual(self.command("funding", "status")["reserved_usd"], "0")
        fresh = self.reserve()
        funding.settle(fresh, outcome="success", actual_usd="0.15", usage={"tokens": 1})
        self.bind(self.newer(grant_remaining_usd="2.85", accounted_operations=[fresh.id]))
        self.assertEqual(self.command("funding", "status")["available_usd"], "2.35")

    def test_multiple_object_scopes_share_one_budget_and_reject_wildcard_calls(self):
        allowed = ["script", "voice:*", "art:single"]
        job = self.command(
            "job", "authorize", scope=allowed, max_usd=".6", max_generations=2, edition="初稿"
        )
        self.assertEqual(job["scopes"], allowed)
        self.error("job_scope_denied", self.reserve, scope="voice:*", job=job["job"])
        self.error(
            "job_scope_denied", self.reserve, scope="voice:other", job=job["job"], edition="另版"
        )
        script = self.reserve("script-take", scope="script", upper=".4", job=job["job"])
        funding.settle(script, outcome="success", actual_usd=".2", usage={"tokens": 2})
        self.error("job_budget_exceeded", self.reserve, scope="voice:any", upper=".5", job=job["job"])
        voice = self.reserve("voice-take", scope="voice:another", upper=".4", job=job["job"])
        funding.settle(voice, outcome="success", actual_usd=".25", usage={"tokens": 3})
        report = self.command("job", "status", job=job["job"])
        self.assertEqual((report["remaining_usd"], report["remaining_generations"]), ("0.15", 0))
        self.assertFalse(funding._allows_scope(["art:single"], "art:other"))
        self.assertTrue(funding._allows_scope(["art:*"], "art:other"))
        legacy = self.job()
        with funding._transaction() as db:
            db.execute("UPDATE jobs SET scope='voice:line-01' WHERE id=?", (legacy,))
        self.assertEqual(self.command("job", "status", job=legacy)["scopes"], ["voice:line-01"])
        self.error("job_scope_denied", self.reserve, scope="voice:another", job=legacy)

    def test_billing_rejection_blocks_org_but_rate_limit_is_per_request(self):
        ticket = self.reserve()
        funding.settle(ticket, outcome="rejected", reason="rate_limit_exceeded")
        self.assertEqual(self.command("funding", "status")["state"], "ready")
        for code in (
            "insufficient_quota",
            "billing_hard_limit_reached",
            "billing_not_active",
            "credit_balance_exhausted",
            "project_spend_limit_exceeded",
            "organization_spend_limit_exceeded",
        ):
            with self.subTest(code=code):
                ticket = self.reserve()
                funding.settle(ticket, outcome="rejected", reason=code)
                self.assertEqual(self.command("funding", "status")["reason"], code)
                self.error(code, self.reserve)
                self.bind(self.newer())

    def test_unknown_updated_review_and_lost_sender_stay_closed(self):
        bad = self.newer()
        del bad["auto_recharge"]
        self.error("funding_unverified", self.bind, bad)
        self.error("funding_unverified", self.reserve)
        self.bind(self.newer())
        ticket = self.reserve()
        ticket.lease.close()  # Model a process that died before recording the outcome.
        self.error("remote_outcome_unknown", self.reserve, op="new-take")
        review = {
            "operation_id": ticket.id,
            "expected_reserved_usd": "1",
            "outcome": "not_sent",
            "actual_usd": "0",
            "evidence_ref": "owner/provider-lookup",
        }
        self.bind(self.newer(reconciled_operations=[review]))
        self.assertEqual(self.command("funding", "status")["reserved_usd"], "0")

    def test_job_scope_deadline_and_request_cost(self):
        job = self.job()
        self.error("job_scope_denied", self.reserve, scope="voice:other", job=job)
        self.error("operation_budget_exceeded", self.reserve, max_usd=".5")
        self.error("funding_expired", self.reserve, duration_s=2000)
        self.error("generation_bound_unknown", self.reserve, duration_s=float("inf"))
        self.check.assert_not_called()

    def test_reloading_owner_quote_after_rebinding(self):
        doc = self.base / "quote.txt"
        doc.write_text("Owner-provided test fixture only")
        quote = {
            "model": "art-test",
            "endpoint": "/v1/images/generations",
            "size": "1536x864",
            "quality": "medium",
            "version": "test1",
            "provider": "openai",
            "basis": "supplier_guaranteed_per_request",
            "source_url": "https://openai.com/example",
            "evidence_file": str(doc),
            "evidence_sha256": hashlib.sha256(doc.read_bytes()).hexdigest(),
            "max_prompt_bytes": 100,
            "max_reference_count": 0,
            "max_reference_pixels": 0,
            "max_reference_bytes": 0,
            "valid_until": funding._iso(time.time() + 600),
            "upper_usd": "0.4",
        }
        self.bind(self.newer(vendor_price_bounds=[quote]))
        x = funding.price_bounds(self.work, "demo")[0]
        ticket = self.reserve(
            op="art1",
            scope="art:shot01",
            upper=".4",
            model="art-test",
            approval_digest=x["approval_digest"],
        )
        funding.settle(ticket, outcome="rejected")
        self.bind(self.newer())
        self.error(
            "generation_bound_unknown",
            self.reserve,
            op="art2",
            scope="art:shot02",
            upper=".4",
            model="art-test",
            approval_digest=x["approval_digest"],
        )
        self.error(
            "invalid_price_evidence",
            self.bind,
            self.newer(vendor_price_bounds=[{**quote, "evidence_file": str(self.work / "poem.txt")}]),
        )


if __name__ == "__main__":
    unittest.main()
