# Gem Finder

Point a phone at a gravel bed and get back the stones worth picking up — ranked, highest confidence first.

Built Oct 27 – Nov 1, 2026, for the Meta AI Hackathon, using the Meta Model API: SAM 3.1 for segmentation of stones in a gravel-bed photo, and Muse Spark for multimodal anomaly ranking and close-up assessment. The result is a phone PWA that scans a gravel bed, ranks the candidates worth picking up, and guides a close-up check on any stone you tap — with a Node proxy and Python CLI behind it, over Tailscale.

Demo video (2:32, live phone flow over cellular): https://youtu.be/oZZ8nfgzwYs

## What it does

- **Bed scan — rank only, never a species ID.** A bed photo returns ranked candidates with boxes, confidence scores, and plain-language reasons ("worth picking up"). The list shows entries at **85% confidence or above only**, in confidence order. No stone is ever named to species on the bed list.
- **Close-up — guided, one stone.** Tap a candidate to open its close-up panel: clean-the-stone prompt, one close-up photo, tap-to-focus the stone, then a guided scratch test (fingernail → copper → glass → steel) that locks in a hardness range. The scan returns a single-stone read: description, hardness used, and up to 3 *possible — not confirmed* identities, each with supporting points, contradicting or uncertain points, and a next check. The suggestions panel is the only place species names may appear, and never as a definitive claim.
- **Splash prompt.** If a live bed scan finds nothing at 85% or above, the app suggests splashing the bed with water and reshooting — wet stones show color dry stones hide — with "Splash and reshoot" and "Dismiss" actions. The banked Demo never triggers it.
- **Saved rocks — device only.** "Save this rock" stores the close-up photo, description, hardness, cleaned state, note, and identities in on-phone storage.
- **Modes are Live and Demo only.** Demo serves a fixed banked report and is always labeled "banked" — it is never presented as a live scan.

## Architecture

Phone PWA → Tailscale → Node proxy → Python CLI → SAM 3.1 (segmentation) + Muse Spark (ranking/assessment), via the Meta Model API (`https://api.meta.ai/v1`).

- The PWA is a static Vite/React build with no pipeline code and no API key. All inference runs through the proxy.
- The proxy (`web/proxy/server.js`) shells out to the Python CLI. Routes: `POST /scan`, `POST /closeup`, `POST /project`, `GET /demo/photo`, `GET /demo/report`, `GET /health`.
- The Meta API key lives server-side only. It never appears in the client, logs, or UI. `/health` reports availability without exposing the value.
- Access is Tailscale-only; no public ports.

## How to run it

Prereqs: Python 3.12+ with a `.venv` (`pip install -r requirements.txt`), Node 18+, the API key in `~/.model_api_key`.

```
# 1. Start the proxy (default port 8741)
./web/proxy/start.sh

# 2. Check it (key present, banked demo available)
curl localhost:8741/health

# 3. Serve the PWA: the proxy serves web/pwa/dist automatically.
#    Rebuild after PWA changes:
cd web/pwa && npm run build

# 4. On the phone (Tailscale on): open http://<build-box>:8741
```

CLI directly (same pipeline the proxy shells out to):

```
.venv/bin/python cli.py assets/testbed/dry.jpg --dry-run   # tiling + local stats, no API calls
.venv/bin/python cli.py assets/testbed/dry.jpg --project   # spend projection, exits before any API call
.venv/bin/python cli.py assets/testbed/dry.jpg             # live bed scan
.venv/bin/python cli.py --pair assets/testbed/dry.jpg assets/testbed/splash.jpg  # dry + wet comparison
```

## What the demo video shows

A live phone flow over cellular (WiFi off): open the PWA over Tailscale, shoot the gravel bed, confirm the live scan, get back the ranked 85%+ list, tap a candidate to zoom, run the guided close-up (clean → photo → focus → scratch test → single-stone read with possible identities), and save the rock on-device. No banked content appears except where the video says so.

## Measured evidence

Formal scoring against the registered ground-truth manifest (`assets/testbed/ground-truth-registered.json`, ring center inside candidate box, strict): dry run 8/12, wet run 10/12 on the Oct 29 pair — wet beats dry. Live phone scans return 300 ranked candidates in ~200s.

## Tests

```
.venv/bin/python -m unittest discover -s tests -t .  # CLI: 61 tests
node --test web/pwa/*.test.js                        # PWA pure modules: 48 tests
node --test web/proxy/*.test.js                      # proxy: 17 tests
```

All suites green as of Nov 1. Browser verification is done in headless Chromium at a phone viewport against the live proxy with Demo/banked data or intercepted responses.

## Layout

- `cli.py` — the pipeline (tiling, SAM segmentation, flagging, stitching, Spark ranking, close-up assessment). The proxy shells out to it; nothing reimplements it.
- `web/proxy/` — Node/Express proxy: `/scan`, `/closeup`, `/project`, demo + health routes, key loading, `start.sh` restart script.
- `web/pwa/` — static PWA (`src/`, tests beside it, `dist/` build output, `public/sw.js` service worker).
- `assets/testbed/` — before/dry/splash/answer-key photos, registered ground truth, ring labels.
- `tests/` — CLI unit tests (stdlib only).
