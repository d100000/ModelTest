#!/usr/bin/env python3
"""Security / capacity hardening core for the Model Fidelity Tester backend.

This module is intentionally framework-free and side-effect-free so it can be
unit-tested in isolation (see test_security.py). server.py wires it into the
HTTP layer.

It provides:
  * load_config()      - read mft_security.json (+ env overrides) over defaults.
  * CaptchaService     - slider-captcha challenge / verify / single-use token.
  * SessionManager     - bounded concurrent test slots, queue when full,
                         heartbeat-based reaping so dead clients free their slot.
  * RateLimiter        - per-client sliding-window limits + temporary bans
                         (anti-abuse / anti-pentest).

All time-dependent classes accept an injectable ``now`` callable (default
time.monotonic) so tests can drive the clock deterministically.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from collections import deque
from typing import Callable

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_CONFIG: dict = {
    # 站点同时最多多少个用户在跑测试
    "max_concurrent_tests": 100,
    # 达到上限后是否允许排队
    "queue_enabled": True,
    "max_queue": 500,
    # 心跳：超过该秒数没有心跳 -> 视为进程挂掉，释放该用户的测试额度
    "heartbeat_timeout_seconds": 30,
    # 单个测试会话最长存活时间（兜底，防止永不释放）
    "session_max_seconds": 3600,
    # 人机校验
    "captcha_required": True,
    "captcha_token_ttl_seconds": 300,
    "captcha_tolerance_px": 8,
    "captcha_min_drag_ms": 250,
    "captcha_max_drag_ms": 20000,
    "captcha_min_samples": 6,
    # 限流（每个客户端 = ip + 设备指纹）
    "rate_limit": {
        "proxy_window_seconds": 10,
        "proxy_max_per_window": 150,
        "start_window_seconds": 60,
        "start_max_per_window": 10,
        "captcha_window_seconds": 60,
        "captcha_max_per_window": 40,
        "ban_seconds": 120,
        "ban_threshold": 3,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config(path: str | None = None, env: dict | None = None) -> dict:
    """Load mft_security.json (if present) merged over DEFAULT_CONFIG, then apply
    a few MFT_* env overrides. Never raises on a malformed file - falls back to
    defaults so the site keeps running."""
    env = os.environ if env is None else env
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy

    candidate = path or env.get("MFT_SECURITY_CONFIG") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "mft_security.json"
    )
    try:
        with open(candidate, "r", encoding="utf-8") as fh:
            cfg = _deep_merge(cfg, json.load(fh))
    except FileNotFoundError:
        pass
    except (ValueError, OSError):
        # Malformed config must not take the site down.
        pass

    def _int_env(name: str, target: dict, key: str) -> None:
        raw = env.get(name)
        if raw is None:
            return
        try:
            target[key] = int(raw)
        except (TypeError, ValueError):
            pass

    _int_env("MFT_MAX_CONCURRENT_TESTS", cfg, "max_concurrent_tests")
    _int_env("MFT_HEARTBEAT_TIMEOUT_SECONDS", cfg, "heartbeat_timeout_seconds")
    _int_env("MFT_MAX_QUEUE", cfg, "max_queue")
    if env.get("MFT_CAPTCHA_REQUIRED") is not None:
        cfg["captcha_required"] = env.get("MFT_CAPTCHA_REQUIRED") not in ("0", "false", "False", "")
    return cfg


# --------------------------------------------------------------------------- #
# Client identity
# --------------------------------------------------------------------------- #

def client_key(ip: str, fingerprint: str | None) -> str:
    """Stable opaque key from IP + device fingerprint, used for limits/slots."""
    raw = f"{ip or '?'}|{(fingerprint or '').strip()[:128]}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Slider captcha
# --------------------------------------------------------------------------- #

class CaptchaService:
    """Lightweight slider captcha. The server picks a random gap X; the client
    renders the puzzle and drags a piece to it. Bot resistance comes from
    requiring a human-like drag (position match + duration window + sample
    count), plus single-use, short-TTL tokens."""

    def __init__(self, config: dict, now: Callable[[], float] = time.monotonic):
        self._cfg = config
        self._now = now
        self._lock = threading.Lock()
        self._challenges: dict[str, dict] = {}
        self._tokens: dict[str, float] = {}  # token -> expiry

    def _gc(self) -> None:
        t = self._now()
        for cid in [c for c, v in self._challenges.items() if v["expires"] <= t]:
            self._challenges.pop(cid, None)
        for tok in [k for k, exp in self._tokens.items() if exp <= t]:
            self._tokens.pop(tok, None)

    def new_challenge(self, width: int = 300, piece: int = 46) -> dict:
        with self._lock:
            self._gc()
            lo = piece + 12
            hi = max(lo + 1, width - piece - 12)
            gap = secrets.randbelow(hi - lo) + lo
            cid = secrets.token_urlsafe(12)
            self._challenges[cid] = {
                "gap": gap,
                "expires": self._now() + 120,
            }
            piece_y = 18 + secrets.randbelow(40)
            return {
                "challenge_id": cid,
                "width": width,
                "height": 160,
                "piece": piece,
                "gap": gap,        # sent for client-side rendering of the notch
                "piece_y": piece_y,
                "seed": secrets.randbelow(1_000_000),
            }

    def verify(self, challenge_id: str, position: float, duration_ms: float,
               samples: int) -> dict:
        cfg = self._cfg
        with self._lock:
            self._gc()
            ch = self._challenges.pop(challenge_id, None)
            if not ch:
                return {"ok": False, "reason": "challenge_expired"}
            if abs(float(position) - ch["gap"]) > cfg["captcha_tolerance_px"]:
                return {"ok": False, "reason": "position_mismatch"}
            if not (cfg["captcha_min_drag_ms"] <= float(duration_ms) <= cfg["captcha_max_drag_ms"]):
                return {"ok": False, "reason": "drag_timing"}
            if int(samples) < cfg["captcha_min_samples"]:
                return {"ok": False, "reason": "trajectory_too_simple"}
            token = secrets.token_urlsafe(18)
            self._tokens[token] = self._now() + cfg["captcha_token_ttl_seconds"]
            return {"ok": True, "token": token}

    def consume_token(self, token: str) -> bool:
        """Validate + single-use consume a captcha token."""
        if not self._cfg.get("captcha_required", True):
            return True
        if not token:
            return False
        with self._lock:
            self._gc()
            exp = self._tokens.pop(token, None)
            return exp is not None and exp > self._now()


# --------------------------------------------------------------------------- #
# Concurrent test-slot manager (with queue + heartbeat reaping)
# --------------------------------------------------------------------------- #

class SessionManager:
    """Bounded set of concurrent test slots. When full, new requests queue.
    Sessions must heartbeat; a session whose heartbeat stops (process died) is
    reaped and its slot freed, after which the next queued session is promoted.
    """

    def __init__(self, config: dict, now: Callable[[], float] = time.monotonic):
        self._cfg = config
        self._now = now
        self._lock = threading.Lock()
        self._active: dict[str, dict] = {}   # sid -> {key, started, beat}
        self._queue: deque[str] = deque()     # queued sids (FIFO)
        self._queued: dict[str, dict] = {}    # sid -> {key, queued_at, beat}

    # ---- internal (caller holds lock) ----
    def _reap_locked(self) -> None:
        t = self._now()
        timeout = self._cfg["heartbeat_timeout_seconds"]
        max_life = self._cfg["session_max_seconds"]
        dead = [
            sid for sid, s in self._active.items()
            if (t - s["beat"]) > timeout or (t - s["started"]) > max_life
        ]
        for sid in dead:
            self._active.pop(sid, None)
        # queued clients that stopped polling also drop out
        stale_q = [sid for sid in list(self._queue) if (t - self._queued[sid]["beat"]) > timeout]
        for sid in stale_q:
            self._drop_queued_locked(sid)
        self._promote_locked()

    def _drop_queued_locked(self, sid: str) -> None:
        self._queued.pop(sid, None)
        try:
            self._queue.remove(sid)
        except ValueError:
            pass

    def _promote_locked(self) -> None:
        limit = self._cfg["max_concurrent_tests"]
        while self._queue and len(self._active) < limit:
            sid = self._queue.popleft()
            info = self._queued.pop(sid, None)
            if info is None:
                continue
            self._active[sid] = {"key": info["key"], "started": self._now(), "beat": self._now()}

    def _position_locked(self, sid: str) -> int:
        try:
            return list(self._queue).index(sid) + 1
        except ValueError:
            return 0

    # ---- public ----
    def acquire(self, key: str) -> dict:
        with self._lock:
            self._reap_locked()
            sid = secrets.token_urlsafe(16)
            limit = self._cfg["max_concurrent_tests"]
            if len(self._active) < limit:
                self._active[sid] = {"key": key, "started": self._now(), "beat": self._now()}
                return {"status": "running", "session_id": sid,
                        "active": len(self._active), "capacity": limit}
            if not self._cfg.get("queue_enabled", True):
                return {"status": "full", "active": len(self._active), "capacity": limit}
            if len(self._queue) >= self._cfg["max_queue"]:
                return {"status": "full", "active": len(self._active), "capacity": limit,
                        "queued": len(self._queue)}
            self._queued[sid] = {"key": key, "queued_at": self._now(), "beat": self._now()}
            self._queue.append(sid)
            return {"status": "queued", "session_id": sid,
                    "position": self._position_locked(sid), "queued": len(self._queue),
                    "active": len(self._active), "capacity": limit}

    def heartbeat(self, sid: str) -> dict:
        with self._lock:
            self._reap_locked()
            if sid in self._active:
                self._active[sid]["beat"] = self._now()
                return {"status": "running", "session_id": sid}
            if sid in self._queued:
                self._queued[sid]["beat"] = self._now()
                self._promote_locked()
                if sid in self._active:
                    return {"status": "running", "session_id": sid}
                return {"status": "queued", "session_id": sid,
                        "position": self._position_locked(sid)}
            return {"status": "expired", "session_id": sid}

    def release(self, sid: str) -> dict:
        with self._lock:
            existed = sid in self._active or sid in self._queued
            self._active.pop(sid, None)
            self._drop_queued_locked(sid)
            self._promote_locked()
            return {"ok": True, "released": existed,
                    "active": len(self._active), "queued": len(self._queue)}

    def stats(self) -> dict:
        with self._lock:
            self._reap_locked()
            return {
                "active": len(self._active),
                "capacity": self._cfg["max_concurrent_tests"],
                "queued": len(self._queue),
                "queue_enabled": bool(self._cfg.get("queue_enabled", True)),
            }


# --------------------------------------------------------------------------- #
# Sliding-window rate limiter with temporary bans
# --------------------------------------------------------------------------- #

class RateLimiter:
    """Per (key, bucket) sliding-window counter. Repeated breaches within a
    short period escalate to a temporary ban (anti-abuse / anti-scripted-start).
    """

    def __init__(self, config: dict, now: Callable[[], float] = time.monotonic):
        self._cfg = config["rate_limit"]
        self._now = now
        self._lock = threading.Lock()
        self._hits: dict[tuple, deque] = {}
        self._breaches: dict[str, list] = {}   # key -> [count, window_start]
        self._bans: dict[str, float] = {}       # key -> ban_until

    def _limit_for(self, bucket: str) -> tuple[int, int]:
        c = self._cfg
        if bucket == "proxy":
            return c["proxy_max_per_window"], c["proxy_window_seconds"]
        if bucket == "start":
            return c["start_max_per_window"], c["start_window_seconds"]
        if bucket == "captcha":
            return c["captcha_max_per_window"], c["captcha_window_seconds"]
        return c["proxy_max_per_window"], c["proxy_window_seconds"]

    def is_banned(self, key: str) -> bool:
        with self._lock:
            until = self._bans.get(key)
            if until is None:
                return False
            if until <= self._now():
                self._bans.pop(key, None)
                return False
            return True

    def check(self, key: str, bucket: str) -> dict:
        """Return {allowed: bool, retry_after: int, banned: bool}."""
        max_n, window = self._limit_for(bucket)
        t = self._now()
        with self._lock:
            until = self._bans.get(key)
            if until is not None:
                if until > t:
                    return {"allowed": False, "banned": True, "retry_after": int(until - t) + 1}
                self._bans.pop(key, None)

            dq = self._hits.setdefault((key, bucket), deque())
            cutoff = t - window
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if len(dq) >= max_n:
                self._register_breach_locked(key, t)
                retry = int(dq[0] + window - t) + 1 if dq else window
                banned = key in self._bans and self._bans[key] > t
                return {"allowed": False, "banned": banned, "retry_after": retry}
            dq.append(t)
            return {"allowed": True, "banned": False, "retry_after": 0}

    def _register_breach_locked(self, key: str, t: float) -> None:
        threshold = self._cfg["ban_threshold"]
        rec = self._breaches.get(key)
        # Count breaches within a rolling 60s window.
        if rec is None or (t - rec[1]) > 60:
            self._breaches[key] = [1, t]
            rec = self._breaches[key]
        else:
            rec[0] += 1
        if rec[0] >= threshold:
            self._bans[key] = t + self._cfg["ban_seconds"]
            self._breaches.pop(key, None)
