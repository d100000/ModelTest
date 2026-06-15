#!/usr/bin/env python3
"""Unit tests for security.py (slot manager, queue, heartbeat reaping,
rate limiter, slider captcha, config loading).

Run:  python3 -m unittest test_security -v
"""

import unittest

import security


class FakeClock:
    """Deterministic monotonic clock for tests."""

    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def make_cfg(**overrides):
    cfg = security.load_config(path="/nonexistent-on-purpose.json", env={})
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


class ConfigTests(unittest.TestCase):
    def test_defaults_when_missing_file(self):
        cfg = security.load_config(path="/does/not/exist.json", env={})
        self.assertEqual(cfg["max_concurrent_tests"], 100)
        self.assertTrue(cfg["queue_enabled"])
        self.assertIn("rate_limit", cfg)

    def test_env_overrides(self):
        cfg = security.load_config(
            path="/does/not/exist.json",
            env={"MFT_MAX_CONCURRENT_TESTS": "3", "MFT_HEARTBEAT_TIMEOUT_SECONDS": "5"},
        )
        self.assertEqual(cfg["max_concurrent_tests"], 3)
        self.assertEqual(cfg["heartbeat_timeout_seconds"], 5)

    def test_bad_env_ignored(self):
        cfg = security.load_config(path="/x.json", env={"MFT_MAX_CONCURRENT_TESTS": "abc"})
        self.assertEqual(cfg["max_concurrent_tests"], 100)

    def test_client_key_stable_and_distinct(self):
        a = security.client_key("1.2.3.4", "fpA")
        b = security.client_key("1.2.3.4", "fpA")
        c = security.client_key("1.2.3.4", "fpB")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class SessionManagerTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cfg = make_cfg(max_concurrent_tests=2, max_queue=3,
                            heartbeat_timeout_seconds=10, session_max_seconds=3600)
        self.sm = security.SessionManager(self.cfg, now=self.clock)

    def test_acquire_up_to_limit(self):
        r1 = self.sm.acquire("k1")
        r2 = self.sm.acquire("k2")
        self.assertEqual(r1["status"], "running")
        self.assertEqual(r2["status"], "running")
        self.assertEqual(self.sm.stats()["active"], 2)

    def test_queue_when_full(self):
        self.sm.acquire("k1")
        self.sm.acquire("k2")
        r3 = self.sm.acquire("k3")
        self.assertEqual(r3["status"], "queued")
        self.assertEqual(r3["position"], 1)
        r4 = self.sm.acquire("k4")
        self.assertEqual(r4["position"], 2)

    def test_release_promotes_queued(self):
        a = self.sm.acquire("k1")
        self.sm.acquire("k2")
        q = self.sm.acquire("k3")
        self.assertEqual(q["status"], "queued")
        self.sm.release(a["session_id"])
        # queued session is promoted on next heartbeat
        hb = self.sm.heartbeat(q["session_id"])
        self.assertEqual(hb["status"], "running")

    def test_heartbeat_keeps_alive_and_expiry_frees_slot(self):
        a = self.sm.acquire("k1")
        self.sm.acquire("k2")  # k2 will be left to die (never heartbeats)
        q = self.sm.acquire("k3")
        # advance just under timeout; the active one and the queued one both poll
        self.clock.advance(8)
        self.sm.heartbeat(a["session_id"])
        self.sm.heartbeat(q["session_id"])  # queued client keeps polling
        # advance past timeout for k2 (never beat) -> reaped, q promoted
        self.clock.advance(5)  # k2 last beat at t0, now t0+13 > 10; q beat at t0+8
        stats = self.sm.stats()  # reaps k2, promotes q
        self.assertLessEqual(stats["active"], 2)
        hb = self.sm.heartbeat(q["session_id"])
        self.assertEqual(hb["status"], "running")

    def test_dead_session_released_by_heartbeat_timeout(self):
        a = self.sm.acquire("k1")
        self.assertEqual(self.sm.stats()["active"], 1)
        # No heartbeat; advance beyond timeout -> reaped
        self.clock.advance(11)
        self.assertEqual(self.sm.stats()["active"], 0)
        # session no longer known
        self.assertEqual(self.sm.heartbeat(a["session_id"])["status"], "expired")

    def test_queue_full_returns_full(self):
        self.sm.acquire("k1")
        self.sm.acquire("k2")
        for i in range(3):
            self.assertEqual(self.sm.acquire(f"q{i}")["status"], "queued")
        self.assertEqual(self.sm.acquire("overflow")["status"], "full")

    def test_release_idempotent(self):
        a = self.sm.acquire("k1")
        self.assertTrue(self.sm.release(a["session_id"])["released"])
        self.assertFalse(self.sm.release(a["session_id"])["released"])

    def test_queue_disabled(self):
        cfg = make_cfg(max_concurrent_tests=1, queue_enabled=False)
        sm = security.SessionManager(cfg, now=self.clock)
        sm.acquire("k1")
        self.assertEqual(sm.acquire("k2")["status"], "full")

    def test_stale_queued_dropped(self):
        self.sm.acquire("k1")
        self.sm.acquire("k2")
        q = self.sm.acquire("k3")
        self.clock.advance(11)  # queued client stops polling -> dropped on reap
        self.sm.stats()
        self.assertEqual(self.sm.heartbeat(q["session_id"])["status"], "expired")


class RateLimiterTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cfg = make_cfg(rate_limit={
            "proxy_window_seconds": 10, "proxy_max_per_window": 3,
            "start_window_seconds": 60, "start_max_per_window": 2,
            "captcha_window_seconds": 60, "captcha_max_per_window": 5,
            "ban_seconds": 30, "ban_threshold": 2,
        })
        self.rl = security.RateLimiter(self.cfg, now=self.clock)

    def test_allows_under_limit(self):
        for _ in range(3):
            self.assertTrue(self.rl.check("k", "proxy")["allowed"])

    def test_blocks_over_limit(self):
        for _ in range(3):
            self.rl.check("k", "proxy")
        res = self.rl.check("k", "proxy")
        self.assertFalse(res["allowed"])
        self.assertGreater(res["retry_after"], 0)

    def test_window_slides(self):
        for _ in range(3):
            self.rl.check("k", "proxy")
        self.assertFalse(self.rl.check("k", "proxy")["allowed"])
        self.clock.advance(11)  # window passed
        self.assertTrue(self.rl.check("k", "proxy")["allowed"])

    def test_repeated_breach_triggers_ban(self):
        # ban_threshold=2 breaches -> ban
        for _ in range(3):
            self.rl.check("k", "proxy")
        self.rl.check("k", "proxy")  # breach 1
        self.rl.check("k", "proxy")  # breach 2 -> ban
        self.assertTrue(self.rl.is_banned("k"))
        res = self.rl.check("k", "proxy")
        self.assertFalse(res["allowed"])
        self.assertTrue(res["banned"])

    def test_ban_expires(self):
        for _ in range(3):
            self.rl.check("k", "proxy")
        self.rl.check("k", "proxy")
        self.rl.check("k", "proxy")
        self.assertTrue(self.rl.is_banned("k"))
        self.clock.advance(31)
        self.assertFalse(self.rl.is_banned("k"))

    def test_buckets_independent(self):
        for _ in range(2):
            self.assertTrue(self.rl.check("k", "start")["allowed"])
        self.assertFalse(self.rl.check("k", "start")["allowed"])
        # proxy bucket unaffected
        self.assertTrue(self.rl.check("k", "proxy")["allowed"])

    def test_keys_independent(self):
        for _ in range(3):
            self.rl.check("a", "proxy")
        self.assertFalse(self.rl.check("a", "proxy")["allowed"])
        self.assertTrue(self.rl.check("b", "proxy")["allowed"])


class CaptchaTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cfg = make_cfg()
        self.cap = security.CaptchaService(self.cfg, now=self.clock)

    def _solve(self, ch, **over):
        args = dict(position=ch["gap"], duration_ms=1200, samples=20)
        args.update(over)
        return self.cap.verify(ch["challenge_id"], **args)

    def test_happy_path_issues_token(self):
        ch = self.cap.new_challenge()
        res = self._solve(ch)
        self.assertTrue(res["ok"])
        self.assertTrue(self.cap.consume_token(res["token"]))

    def test_token_single_use(self):
        ch = self.cap.new_challenge()
        token = self._solve(ch)["token"]
        self.assertTrue(self.cap.consume_token(token))
        self.assertFalse(self.cap.consume_token(token))

    def test_position_mismatch_rejected(self):
        ch = self.cap.new_challenge()
        res = self._solve(ch, position=ch["gap"] + 40)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "position_mismatch")

    def test_too_fast_rejected(self):
        ch = self.cap.new_challenge()
        res = self._solve(ch, duration_ms=50)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "drag_timing")

    def test_too_few_samples_rejected(self):
        ch = self.cap.new_challenge()
        res = self._solve(ch, samples=2)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "trajectory_too_simple")

    def test_challenge_single_use(self):
        ch = self.cap.new_challenge()
        self.assertTrue(self._solve(ch)["ok"])
        # second verify on same challenge id fails (consumed)
        self.assertFalse(self._solve(ch)["ok"])

    def test_token_expires(self):
        ch = self.cap.new_challenge()
        token = self._solve(ch)["token"]
        self.clock.advance(self.cfg["captcha_token_ttl_seconds"] + 1)
        self.assertFalse(self.cap.consume_token(token))

    def test_captcha_not_required_accepts_any(self):
        cfg = make_cfg(captcha_required=False)
        cap = security.CaptchaService(cfg, now=self.clock)
        self.assertTrue(cap.consume_token(""))


if __name__ == "__main__":
    unittest.main()
