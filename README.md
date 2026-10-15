# Score Four — 3D Connect Four

A turn-based 3D board game for two (4×4 pegs × 4 levels, 76 winning lines). Vanilla JS + Three.js via CDN importmap — **no build step**.

## Run

ES modules need http(s), not `file://`:

```bash
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

Tests (pure game logic + AI): `npm test`

## Structure

| File | Role |
| --- | --- |
| `js/gamestate.js` | Pure rules: board, 76 precomputed lines, move validation, win/draw, undo |
| `js/renderer.js`  | Three.js scene, materials, drop physics, picking, camera, win FX |
| `js/ai.js`        | Negamax + alpha-beta, open-lines heuristic, 3 difficulties |
| `js/net.js`       | PeerJS (WebRTC) room-code multiplayer, heartbeat + disconnect handling |
| `js/audio.js`     | Synthesized sound effects (WebAudio) |
| `js/main.js`      | Controller: UI, input, game flow, online protocol |
| `sw.js`, `manifest.webmanifest` | PWA (installable, offline shell) |

## Online play

Host creates a room (4-letter code / `?room=ABCD` link); the guest joins. Only moves are synced; both sides
validate every move (turn order, move number, peg capacity). Signalling uses the public PeerJS broker.

## Controls

Mouse: hover to preview, click to drop · Touch: tap to preview, tap again to drop (toggle in menu) ·
Keyboard: arrows + Enter, `Z` undo, `R` reset view.
