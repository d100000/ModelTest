#!/usr/bin/env python3
"""Static file server with a tiny same-origin API proxy.

The browser cannot call many relay APIs directly because their OPTIONS
preflight is blocked by CORS. This server keeps the app static from the user's
point of view, while forwarding /api/proxy?target=... requests from localhost.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
import ipaddress
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import security

try:
    import brotli  # type: ignore
except Exception:  # noqa: BLE001 - optional runtime dependency.
    brotli = None


# Security / capacity hardening singletons (configured at startup in main()).
SECURITY_CONFIG: dict = security.load_config()
CAPTCHA = security.CaptchaService(SECURITY_CONFIG)
SESSIONS = security.SessionManager(SECURITY_CONFIG)
RATE_LIMITER = security.RateLimiter(SECURITY_CONFIG)

# Max body for non-proxy control endpoints (captcha/session). Proxy bodies may
# be large (1M-context tests), so the cap only applies to control endpoints.
CONTROL_MAX_BODY = 16 * 1024


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "origin",
    "referer",
    "content-length",
}

TRANSIENT_UPSTREAM_STATUSES = {429, 502, 503, 504, 529}
DEFAULT_PROXY_RETRIES = int(os.environ.get("MFT_PROXY_RETRIES", "2"))
UPSTREAM_MAX_CONCURRENCY = max(1, int(os.environ.get("MFT_UPSTREAM_CONCURRENCY", "6")))
UPSTREAM_MIN_INTERVAL_MS = max(0, int(os.environ.get("MFT_UPSTREAM_MIN_INTERVAL_MS", "120")))
UPSTREAM_TIMEOUT_SECONDS = max(30, int(os.environ.get("MFT_UPSTREAM_TIMEOUT_SECONDS", "1800")))

_UPSTREAM_LOCK = threading.Lock()
_UPSTREAM_ACTIVE: dict[str, int] = defaultdict(int)
_UPSTREAM_LAST_STARTED: dict[str, float] = defaultdict(float)

FORWARD_PREFIXES = (
    "authorization",
    "x-api-key",
    "content-type",
    "accept",
    "anthropic-",
    "openai-",
)


class ProxyStaticHandler(SimpleHTTPRequestHandler):
    server_version = "MFTProxy/1.0"

    def _is_proxy_path(self) -> bool:
        return self.path.startswith("/api/proxy") or self.path.startswith("/__proxy")

    def end_headers(self) -> None:
        # Harmless for static files, useful when a browser probes the proxy.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, x-api-key, anthropic-version, "
            "anthropic-beta, anthropic-dangerous-direct-browser-access",
        )
        super().end_headers()

    def do_OPTIONS(self) -> None:
        if self._is_proxy_path():
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_OPTIONS()

    def do_GET(self) -> None:
        if self._is_proxy_path():
            self._handle_proxy("GET")
            return
        if self.path.startswith("/api/health"):
            self._send_json(200, {"ok": True, "service": "mft-local-backend"})
            return
        if self.path.startswith("/api/session/stats"):
            self._send_json(200, SESSIONS.stats())
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self._is_proxy_path():
            self._handle_proxy("POST")
            return
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/captcha/new":
            self._handle_captcha_new()
            return
        if path == "/api/captcha/verify":
            self._handle_captcha_verify()
            return
        if path == "/api/session/acquire":
            self._handle_session_acquire()
            return
        if path == "/api/session/heartbeat":
            self._handle_session_heartbeat()
            return
        if path == "/api/session/release":
            self._handle_session_release()
            return
        self.send_error(404, "Not found")

    # ------------------------------------------------------------------ #
    # Security helpers
    # ------------------------------------------------------------------ #
    def _client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
        try:
            return self.client_address[0]
        except Exception:  # noqa: BLE001
            return "?"

    def _client_key(self) -> str:
        return security.client_key(self._client_ip(), self.headers.get("X-MFT-Fingerprint"))

    def _read_control_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or "0")
        if length > CONTROL_MAX_BODY:
            self._send_json(413, {"error": {"message": "请求体过大"}})
            return None
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": {"message": "请求体不是合法 JSON"}})
            return None

    def _rate_guard(self, bucket: str) -> bool:
        """Return True if allowed; otherwise emit 429 and return False."""
        key = self._client_key()
        res = RATE_LIMITER.check(key, bucket)
        if res["allowed"]:
            return True
        msg = "请求过于频繁，已被临时封禁" if res.get("banned") else "请求过于频繁，请稍后再试"
        self._send_json(429, {"error": {"message": msg, "type": "rate_limited",
                                        "retry_after": res["retry_after"]}},
                        {"Retry-After": str(res["retry_after"])})
        return False

    def _handle_captcha_new(self) -> None:
        if not self._rate_guard("captcha"):
            return
        if self._read_control_body() is None:
            return
        self._send_json(200, CAPTCHA.new_challenge())

    def _handle_captcha_verify(self) -> None:
        if not self._rate_guard("captcha"):
            return
        body = self._read_control_body()
        if body is None:
            return
        res = CAPTCHA.verify(
            str(body.get("challenge_id", "")),
            body.get("position", -999),
            body.get("duration_ms", 0),
            body.get("samples", 0),
        )
        self._send_json(200 if res.get("ok") else 400, res)

    def _handle_session_acquire(self) -> None:
        if not self._rate_guard("start"):
            return
        body = self._read_control_body()
        if body is None:
            return
        if SECURITY_CONFIG.get("captcha_required", True):
            if not CAPTCHA.consume_token(str(body.get("captcha_token", ""))):
                self._send_json(403, {"error": {"message": "人机校验未通过或已过期，请重新验证",
                                                "type": "captcha_required"}})
                return
        result = SESSIONS.acquire(self._client_key())
        status = 200 if result.get("status") in {"running", "queued"} else 503
        self._send_json(status, result)

    def _handle_session_heartbeat(self) -> None:
        body = self._read_control_body()
        if body is None:
            return
        self._send_json(200, SESSIONS.heartbeat(str(body.get("session_id", ""))))

    def _handle_session_release(self) -> None:
        body = self._read_control_body()
        if body is None:
            return
        self._send_json(200, SESSIONS.release(str(body.get("session_id", ""))))

    def _target_is_private(self, host: str) -> bool:
        """SSRF guard: does the proxy target resolve to a private/loopback IP?"""
        hostname = host.split(":")[0]
        try:
            infos = socket.getaddrinfo(hostname, None)
        except Exception:  # noqa: BLE001 - unresolved host: let upstream fail normally.
            return False
        for info in infos:
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr.split("%")[0])
            except ValueError:
                continue
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return True
        return False

    def _handle_proxy(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("target") or [""])[0]
        if not target:
            self._send_json(400, {"error": {"message": "Missing proxy target"}})
            return
        target_url = urllib.parse.urlparse(target)
        if target_url.scheme not in {"https", "http"} or not target_url.netloc:
            self._send_json(400, {"error": {"message": "Invalid proxy target"}})
            return

        # Anti-abuse: per-client sliding-window rate limit on the proxy.
        if not self._rate_guard("proxy"):
            return

        # SSRF guard (configurable): block proxying to internal/loopback hosts.
        if SECURITY_CONFIG.get("block_private_targets") and self._target_is_private(target_url.netloc):
            self._send_json(403, {"error": {"message": "出于安全策略，禁止代理到内网/本地地址",
                                            "type": "ssrf_blocked"}})
            return

        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(length) if length > 0 else b""

        headers = {}
        for key, value in self.headers.items():
            lk = key.lower()
            if lk in HOP_BY_HOP:
                continue
            if lk == "anthropic-dangerous-direct-browser-access":
                continue
            if lk == "accept-encoding":
                continue
            if lk.startswith("sec-") or lk.startswith("cf-"):
                continue
            if lk in {"user-agent", "accept-language"} or any(lk.startswith(p) for p in FORWARD_PREFIXES):
                headers[key] = value
        headers["Accept-Encoding"] = "identity"

        max_retries = max(0, DEFAULT_PROXY_RETRIES)
        queue_wait_ms = self._acquire_upstream_slot(target_url.netloc)
        try:
            for attempt_index in range(max_retries + 1):
                req = urllib.request.Request(target, data=body, headers=headers, method=method)
                try:
                    with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT_SECONDS) as resp:
                        status = resp.status
                        response_headers = resp.headers
                        data, decoded_encoding = self._decode_upstream_body(resp.read(), response_headers)
                        self.send_response(status)
                        self._copy_response_headers(response_headers, decoded_encoding=decoded_encoding)
                        self.send_header("X-MFT-Proxy", "1")
                        self.send_header("X-MFT-Retry-Count", str(attempt_index))
                        self.send_header("X-MFT-Queue-Wait-Ms", str(queue_wait_ms))
                        self.send_header("X-MFT-Upstream-Concurrency", str(UPSTREAM_MAX_CONCURRENCY))
                        if decoded_encoding:
                            self.send_header("X-MFT-Decoded", decoded_encoding)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                except urllib.error.HTTPError as e:
                    data, decoded_encoding = self._decode_upstream_body(e.read(), e.headers)
                    content_type = e.headers.get("Content-Type", "")
                    if self._should_retry_upstream(e.code, content_type, data) and attempt_index < max_retries:
                        self._sleep_before_retry(e.headers, attempt_index)
                        continue
                    if self._looks_like_html_error(content_type, data):
                        payload = self._upstream_html_error(e.code, e.reason, target, data, e.headers, attempt_index)
                        self._send_json(e.code, payload, {
                            "X-MFT-Retry-Count": str(attempt_index),
                            "X-MFT-Queue-Wait-Ms": str(queue_wait_ms),
                            "X-MFT-Upstream-Concurrency": str(UPSTREAM_MAX_CONCURRENCY),
                        })
                        return
                    self.send_response(e.code)
                    self._copy_response_headers(e.headers, decoded_encoding=decoded_encoding)
                    self.send_header("X-MFT-Proxy", "1")
                    self.send_header("X-MFT-Retry-Count", str(attempt_index))
                    self.send_header("X-MFT-Queue-Wait-Ms", str(queue_wait_ms))
                    self.send_header("X-MFT-Upstream-Concurrency", str(UPSTREAM_MAX_CONCURRENCY))
                    if decoded_encoding:
                        self.send_header("X-MFT-Decoded", decoded_encoding)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as e:  # noqa: BLE001 - this is a local diagnostic proxy.
                    if attempt_index < max_retries:
                        self._sleep_before_retry(None, attempt_index)
                        continue
                    self._send_json(
                        502,
                        {"error": {"message": str(e), "type": "proxy_error", "retry_count": attempt_index}},
                        {
                            "X-MFT-Retry-Count": str(attempt_index),
                            "X-MFT-Queue-Wait-Ms": str(queue_wait_ms),
                            "X-MFT-Upstream-Concurrency": str(UPSTREAM_MAX_CONCURRENCY),
                        },
                    )
                    return
        finally:
            self._release_upstream_slot(target_url.netloc)

    def _looks_like_html_error(self, content_type: str, data: bytes) -> bool:
        prefix = data[:256].lstrip().lower()
        return "text/html" in (content_type or "").lower() or prefix.startswith(b"<!doctype html") or prefix.startswith(b"<html")

    def _should_retry_upstream(self, status: int, content_type: str, data: bytes) -> bool:
        if status not in TRANSIENT_UPSTREAM_STATUSES:
            return False
        if status in {502, 503, 504}:
            return self._looks_like_html_error(content_type, data)
        return True

    def _sleep_before_retry(self, headers, attempt_index: int) -> None:
        retry_after = None
        if headers is not None:
            raw = headers.get("Retry-After")
            if raw:
                try:
                    retry_after = float(raw)
                except ValueError:
                    retry_after = None
        delay = retry_after if retry_after is not None else (1.5 + attempt_index * 2.5)
        time.sleep(max(0.5, min(delay, 8.0)))

    def _acquire_upstream_slot(self, host: str) -> int:
        wait_started = time.monotonic()
        min_interval = UPSTREAM_MIN_INTERVAL_MS / 1000
        while True:
            with _UPSTREAM_LOCK:
                now = time.monotonic()
                active = _UPSTREAM_ACTIVE[host]
                next_allowed = _UPSTREAM_LAST_STARTED[host] + min_interval
                if active < UPSTREAM_MAX_CONCURRENCY and now >= next_allowed:
                    _UPSTREAM_ACTIVE[host] += 1
                    _UPSTREAM_LAST_STARTED[host] = now
                    return int((now - wait_started) * 1000)

                if active >= UPSTREAM_MAX_CONCURRENCY:
                    sleep_for = 0.1
                else:
                    sleep_for = max(0.02, min(0.25, next_allowed - now))
            time.sleep(sleep_for)

    def _release_upstream_slot(self, host: str) -> None:
        with _UPSTREAM_LOCK:
            _UPSTREAM_ACTIVE[host] = max(0, _UPSTREAM_ACTIVE[host] - 1)

    def _upstream_html_error(self, status: int, reason: str, target: str, data: bytes, headers, retry_count: int = 0) -> dict:
        host = urllib.parse.urlparse(target).netloc
        excerpt = data[:1200].decode("utf-8", errors="replace")
        retry_after = headers.get("Retry-After")
        message = (
            f"上游 {host} 返回 HTTP {status} {reason or ''} 的 HTML 错误页。"
            "本地后端已成功转发请求，但上游网关/Cloudflare 到源站失败。"
        )
        if retry_count:
            message += f" 本地后端已自动重试 {retry_count} 次仍失败。"
        if retry_after:
            message += f" 建议 {retry_after} 秒后重试。"
        return {
            "error": {
                "message": message,
                "type": "upstream_html_error",
                "upstream_status": status,
                "upstream_host": host,
                "upstream_url": target,
                "retry_after": retry_after,
                "retry_count": retry_count,
                "body_excerpt": excerpt,
            }
        }

    def _decode_upstream_body(self, data: bytes, headers) -> tuple[bytes, str | None]:
        encoding = (headers.get("Content-Encoding") or "").strip().lower()
        sniffed = None
        if data.startswith(b"\x1f\x8b"):
            sniffed = "gzip"
        elif data.startswith((b"\x78\x01", b"\x78\x9c", b"\x78\xda")):
            sniffed = "deflate"

        candidates = []
        if encoding:
            candidates.extend(x.strip() for x in encoding.split(",") if x.strip())
        if sniffed and sniffed not in candidates:
            candidates.append(sniffed)

        decoded = data
        applied = []
        for enc in reversed(candidates):
            try:
                if enc == "gzip":
                    decoded = gzip.decompress(decoded)
                elif enc in {"deflate", "zlib"}:
                    decoded = zlib.decompress(decoded)
                elif enc == "br" and brotli is not None:
                    decoded = brotli.decompress(decoded)
                else:
                    continue
                applied.append(enc)
            except Exception:
                # If decompression fails, keep the original body and original
                # headers. A broken upstream should be visible in diagnostics.
                return data, None
        return decoded, ",".join(applied) if applied else None

    def _copy_response_headers(self, headers, decoded_encoding: str | None = None) -> None:
        for key, value in headers.items():
            lk = key.lower()
            if lk in HOP_BY_HOP or lk in {"content-length"}:
                continue
            if decoded_encoding and lk == "content-encoding":
                continue
            self.send_header(key, value)

    def _send_json(self, status: int, payload: dict, extra_headers: dict | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-MFT-Proxy", "1")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ProxyStaticHandler)
    print(f"Serving Model Fidelity Tester on http://{args.host}:{args.port}/index.html")
    print("Local API endpoint: /api/proxy?target=https%3A%2F%2Fexample.com%2Fv1%2Fmessages")
    print(
        "Security: max_concurrent_tests={mc} queue={q} heartbeat_timeout={hb}s "
        "captcha={cap} block_private_targets={bp}".format(
            mc=SECURITY_CONFIG["max_concurrent_tests"],
            q=SECURITY_CONFIG["queue_enabled"],
            hb=SECURITY_CONFIG["heartbeat_timeout_seconds"],
            cap=SECURITY_CONFIG["captcha_required"],
            bp=SECURITY_CONFIG.get("block_private_targets", False),
        )
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
