# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**模型保真测试 (Model Fidelity Tester)** — a single-page browser-based tool that probes an OpenAI- or Anthropic-compatible LLM endpoint and reports:
- whether the model is genuinely what the API claims (identity / behavior fingerprinting)
- which supply-chain channel served it (official, Bedrock, Vertex, Claude.ai reverse, NewAPI/OneAPI proxies, OpenRouter, etc.)
- a 6-layer scorecard with ~40 individual checks (protocol / metering / capability / behavior / cryptographic / adversarial)

It is **vanilla HTML/CSS/JS — no build step, no npm**. All code lives in `index.html`, `styles.css`, and `js/*.js` files loaded as global scripts.

## Running the project

### Recommended: Python proxy server
The browser can't call most relay APIs directly because of CORS preflight blocks. `server.py` runs a tiny same-origin proxy at `/api/proxy?target=<url>` that the JS uses for **every** outbound request (see `ApiClient._proxyUrl` / `_requestUrl` in `js/api.js`).

```bash
python3 server.py --port 8000
# open http://127.0.0.1:8000/index.html
```

Tunables (env vars in `server.py`):
- `MFT_PROXY_RETRIES` — retries on transient 429/502/503/504/529 (default 2)
- `MFT_UPSTREAM_CONCURRENCY` — max parallel requests per upstream host (default 6)
- `MFT_UPSTREAM_MIN_INTERVAL_MS` — min spacing between requests to same host (default 120ms)
- `MFT_UPSTREAM_TIMEOUT_SECONDS` — upstream socket timeout (default 1800s)

### Alt: plain static server (no proxy, will hit CORS on many providers)
`.claude/launch.json` is configured for `python3 -m http.server 8765` — used only when previewing the UI itself, NOT for real API calls.

### Tests
The **JS frontend has no test suite** — validate it interactively in the browser preview, often by injecting a mock `window.fetch` via `mcp__Claude_Preview__preview_eval` to simulate specific HTTP statuses / SSE streams.

The **Python backend is unit-tested**. `test_security.py` exercises `security.py` (slot manager, queue, heartbeat reaping, rate limiter, slider captcha, config loading) against a deterministic fake clock — no network, no real time:
```bash
python3 -m unittest test_security -v                     # all
python3 -m unittest test_security.RateLimiterTests -v    # one class
```

## Cache-busting protocol (important when editing JS)

Every `<script>` and `<link>` tag in `index.html` carries `?v=NN`. **When you change any `js/*.js` or `styles.css`, bump the version in `index.html`**, otherwise the browser preview will serve stale code. There is no automatic invalidation.

Current versions are grep-able (note: the stylesheet `<link>` and the `js/*.js` `<script>` tags carry **separate** counters and can legitimately drift — bump whichever you touched):
```bash
grep -o '?v=[0-9]*' index.html | sort -u
```

## Architecture (the big picture)

### Module layout & dependency order
Scripts are loaded as plain globals in this order (see bottom of `index.html`):

```
prompts.js       → DEFAULT_PROMPTS, FOLLOWUP_QUESTIONS, TAG_LABELS, PromptStore
fingerprints.js  → MODEL_FINGERPRINTS, STYLE_SIGNATURES (Claude/GPT/Gemini/Qwen/...)
channels.js     → CHANNEL_FINGERPRINTS, ChannelDetector (Anthropic/Bedrock/Vertex/...)
scorecard.js    → SCORECARD_LAYERS, SCORECARD_CHECKS, ScorecardEngine
analyzer.js     → Analyzer.analyze(ctx) — model-identity verdict from results + consistency + refusal
api.js          → ApiClient — protocol bodies, SSE consumer, conversation task scheduler
charts.js       → Charts.histogram / scatter (canvas, no library)
app.js          → App.state + App._start / _renderXxx / event handlers (the controller)
```

Each module exposes globals via `const X = {...}`. There are no ES modules and no bundler — everything is in `window` scope.

### The concurrency model (critical to understand)

Old (deprecated): tasks = prompts × concurrency × rounds (each task = one independent request).

**Current model** (`ApiClient.buildConversationTasks` / `runConversationTasks` in `api.js`):
- **Each enabled prompt → one `ConversationTask`** that runs `rounds` turns sequentially, sharing accumulated `messages: [{role, content}, ...]` history.
- **Turn 1** sends the prompt body; **turn 2+** sends `FOLLOWUP_QUESTIONS[t]` (defined in `prompts.js`) which forces the model to re-confirm identity.
- A `concurrency`-sized **worker pool** picks tasks off a queue; one worker holds a task until all its turns are done.
- Total requests = `enabledPrompts × rounds`. Don't multiply by concurrency.

Each turn result is pushed into the **flat** `App.state.results[]` for cross-task aggregate analysis (model fingerprint voting, channel detection), AND attached to `task.turnResults[]` for the per-conversation bubble view.

### Outbound request path
Every request goes through `ApiClient._requestUrl` → `/api/proxy?target=<encoded-target>`. The proxy in `server.py`:
- forwards Auth/`x-api-key`/`Content-Type`/`anthropic-*`/`openai-*` headers
- strips `Origin`/`Referer`/CF headers
- decompresses gzip/deflate/br bodies (preserves SSE streaming)
- retries on transient upstream errors and HTML error pages
- annotates response with `X-MFT-Proxy: 1` + `X-MFT-Retry-Count` + `X-MFT-Queue-Wait-Ms` for diagnostics

This means **`response.headers` in JS contains everything the upstream returned plus those `X-MFT-*` markers**. Channel detection (`channels.js`) leverages this — it can see `anthropic-ratelimit-*`, `request-id`, `cf-ray` etc. that a direct browser fetch couldn't access (no `Access-Control-Expose-Headers` from upstream).

### Security / anti-abuse layer (`security.py`)
`server.py` is more than a proxy — it imports `security.py`, which gates a public deployment. `server.py` instantiates `CaptchaService`, `SessionManager`, `RateLimiter` from `security.load_config()` and adds endpoints:
- `/api/captcha/new` + `/api/captcha/verify` — slider CAPTCHA (human verification before a run is allowed); the JS init flow (`App._initSecurity`) drives this.
- `/api/session/acquire` / `heartbeat` / `release` / `stats` — a concurrency-slot manager with a wait queue. Sessions are reaped if their heartbeat lapses (`heartbeat_timeout_seconds`).
- `/api/health` — liveness.
- `RateLimiter` throttles `/api/proxy`, `/api/session/acquire`, `/api/captcha/*` per client and issues temp bans.

Clients are keyed by `security.client_key(ip, X-MFT-Fingerprint)` — the JS sends an `X-MFT-Fingerprint` request header. Config lives in **`mft_security.json`** (and `MFT_*` env overrides); notably `block_private_targets` is an SSRF guard that should be `true` for public deploys and `false` to test a local model. This whole layer is what `test_security.py` covers.

### SSE streaming with safety
`ApiClient._consumeSSEStream(res, format, result, onChunk, signal)`:
- per-`read()` 60-second timeout (prevents infinite hang if upstream goes silent mid-stream)
- abort signal propagation cancels the reader explicitly
- finally block always releases the reader lock
- handles Anthropic event types (`message_start` / `content_block_start` / `_delta` / `_stop` / `message_delta` / `message_stop` with `signature_delta` for thinking blocks) and OpenAI `delta.content`

When changing streaming code, preserve the abort/timeout/lock-release patterns — earlier versions caused the entire tool to hang.

### State container
`App.state` (in `app.js`) holds **everything** — there is no Redux/MobX/etc., direct mutation is intentional. The result buckets, each fed by its own test suite:

| Field | Suite |
|---|---|
| `results[]` / `probeTasks[]` | core identity probes (flat + per-conversation, see concurrency model) |
| `cacheResults[]` | prompt-caching behaviour |
| `convResults[]` | conversation-continuity |
| `thinkingResult` / `signatureReplayResult` | Extended Thinking + cryptographic signature replay (L5) |
| `presetResults[]` / `presetSummary` | hidden/preset system-prompt detection |
| `multimodalResults` | `{image, pdf}` capability probes |
| `paramResults` | `{stopSequences, outputFormat, thinkingDisplay}` |
| `adversarialResults[]` / `adversarialSummary` | jailbreak / name-swap / adulteration probes |
| `capacityResults` | context- and output-window capacity probing → `{context, output, channelHint, modelHint}` |
| `advancedResults` | **advanced fingerprinting** → `{tokenizer, glitch, fingerprint, distribution}` — tokenizer boundary probes, glitch tokens, seed determinism, MMD distribution stats |
| `availableModels[]` | auto-fetched model list (`ApiClient.fetchModels`; the app tests every model, no manual selection) |

Plus control fields: `running`, `abortController`, `lastReport`, `runProgress`. Each suite has a matching `_render*` in `app.js` and is cleared by `_resetAnalysisPanels` / `_resetMetrics` on a new run.

`App._start()`'s `finally` block must always:
1. set `state.running = false`
2. abort + null the `abortController`
3. call `_analyzeAndRender()` to regenerate the report

If you add a new test suite, follow this pattern and respect `signal.aborted` checks between phases.

### Scoring engine
`scorecard.js` defines `SCORECARD_CHECKS` (array of `{id, layer: 'L1'..'L6', name, weight, evaluate(ctx)}`). Each check returns `{status: 'pass'|'partial'|'fail'|'skip', detail}`. Score = Σ(score×weight) / Σ(weight excluding skips) × 100.

The `ctx` passed in by `App._renderScorecard` includes: `allResults`, `successResults`, `convResults`, `thinkingResult`, `report` (from `Analyzer.analyze`), `cfg`. Adding a new check = appending an object to `SCORECARD_CHECKS`.

### Channel detection (`channels.js`)
`CHANNEL_FINGERPRINTS` is a list of channels (e.g. `anthropic_official`, `aws_bedrock`, `aggregator_proxy`). Each carries weighted rules of types: `header_exists` / `header_missing` / `header_value` (regex) / `body_field` / `body_field_missing` / `url_host` / `url_path` / `request_header_*` / `header_count_below` / `all_anthropic_ratelimit_missing`. `ChannelDetector.summarize(result)` scores all candidates and ranks them; `aggregate(results)` votes across the batch.

`requiresClaude: true` means the channel only competes when the response looks Claude-shaped (so a real OpenAI request doesn't get tagged as a "Claude proxy").

## Common edits

| Goal | File(s) |
|---|---|
| Add a probe prompt | `js/prompts.js` (`DEFAULT_PROMPTS`); user customizations persist in `localStorage` via `PromptStore` |
| Add a model fingerprint | `js/fingerprints.js` (`MODEL_FINGERPRINTS`) |
| Add a channel signature | `js/channels.js` (`CHANNEL_FINGERPRINTS`) |
| Add a scorecard check | `js/scorecard.js` (`SCORECARD_CHECKS`) |
| Change request body shape | `ApiClient._buildOpenAIBody` / `_buildAnthropicBody` / `_buildConversationBody` in `js/api.js` |
| Change request routing/headers | `_proxyUrl` / `_requestUrl` in `js/api.js`, plus `server.py` if it's a proxy concern |
| Add a UI tab/section | `index.html` (markup) + `js/app.js` (`_render*` functions + `_resetAnalysisPanels` reset list) |
| Change anti-abuse limits / captcha / SSRF guard | `mft_security.json` or `MFT_*` env vars (logic in `security.py`, tests in `test_security.py`) |

## Conventions / gotchas

- **`js/app.js` looks like a *binary* file to `grep`/`file`/`rg`.** It contains 2 raw NUL bytes (~line 917 — a `url + '\0' + key + '\0' + format` dedup signature in `_maybeAutoLoadModels`). Consequences: plain `grep "foo" js/app.js` silently returns **nothing** (exits 1) and `file` reports `data`. **Always search this file with `grep -a`** (or use the Read/Glob tools, which are unaffected). This is a real footgun — it can make a present function look deleted. Functionally harmless (JS permits NUL in string literals) but would be cleaner written as the `'\x00'` escape; don't "fix" it blind without verifying the dedup key still works.
- **No frameworks.** Use plain DOM APIs in `app.js`. HTML strings are escaped via `App._esc(...)`.
- **Chinese-aware regex**: model/channel rules use both English (`\b...\b`) and CJK alternatives. CJK chars don't form `\b` boundaries; if you need CJK matching, omit `\b` (see comment in `fingerprints.js` around the Qwen rules).
- **localStorage keys**: `mft.prompts` (user prompt edits), `mft.config` (config minus API key). API key is **never** persisted.
- **Abort etiquette**: in any long-running loop (worker pool, multi-turn cache test, conversation test), check `signal.aborted` between iterations. The user expects ▍Stop to actually stop within ~1 turn.
- **DOM IDs are not always unique-per-render**: when re-rendering panels, prefer replacing innerHTML or clearing children rather than relying on stable IDs across runs.
- **Cache-bust query string** must be bumped on every JS/CSS change. The browser preview is aggressive about caching `js/*.js`.

## Reference

- The proxy log markers (`X-MFT-*` headers) double as channel-detection inputs and operator debug clues.
- The scorecard report is exportable as JSON via the "下载报告" button in the UI.
- `README.md` is the long-form (Chinese) explanation of the detection methodology; `docs/检测能力对比与建议.md` is a landscape gap-analysis of where detection is still weak — read it before extending fingerprinting.
