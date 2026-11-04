# Gem Finder

Point a phone at a gravel bed and get back the stones worth picking up — ranked, highest confidence first.

Full project built Oct 27 – Nov 4, 2026, for the Meta AI Hackathon, using the Meta Model API: SAM 3.1 for segmentation of stones in a gravel-bed photo, and Muse Spark for multimodal anomaly ranking and close-up assessment. The result is a phone PWA that scans a gravel bed, ranks the candidates worth picking up, and guides a close-up check on any stone you tap — with a Node proxy and Python CLI behind it, over Tailscale.

Demo video (2:32, live phone flow over cellular): https://youtu.be/oZZ8nfgzwYs

## What it does

- **Bed scan — rank only, never a species ID.** A bed photo returns ranked candidates with boxes, confidence scores, and plain-language reasons ("worth picking up"). The list shows entries at **85% confidence or above only**, in confidence order. No stone is ever named to species on the bed list.
- **Close-up — guided, one stone.** Tap a candidate to open its close-up panel: clean-the-stone prompt, one close-up photo, tap-to-focus the stone, then a guided scratch test (fingernail → coin → glass → steel) that locks in a hardness range. The scan returns a single-stone read: description, hardness used, and up to 3 *possible — not confirmed* identities, each with supporting points, contradicting or uncertain points, and a next check. The suggestions panel is the only place species names may appear, and never as a definitive claim.
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

Prereqs: Python 3.12+ with a `.venv` (`pip install -r requirements.txt`), Node 18+, and a Meta Model API key (see below — never commit it).
