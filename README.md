# Pokemon Dino Edition — Multiplayer Journey

Adds an **8-player multiplayer journey mode with a lobby system** to your existing
Pokemon Dino Edition game, **without changing the single-player game logic**.

## What you get

- 🎮 **MULTIPLAYER JOURNEY** button on the title screen
- 🧑‍🤝‍🧑 **Lobby system**: create/join a room by 4-letter code, see all players, ready-up,
  host starts the journey (supports **more than 2 players** — up to 8)
- 🚶 **See each other in the overworld**: every player's trainer is drawn on the shared
  map in real time, with name tags, smooth movement, and direction/walk animation
- 💬 **In-journey chat** (press **T** to type)
- 🟢 Live "MP · CODE" badge while connected

The original single-player modes (New Journey, Continue, Battle) are untouched.

## How it works (architecture)

- **Server (`mp-server.js`)** — Node + Express + `ws`.
  - Lobby: `create` / `join` / `ready` / `start` (host-only).
  - In-journey: a **relay model** — each client sends its `{tileX,tileY,dir,moving,area}`
    and the server rebroadcasts to peers. No server-side game simulation, so nothing
    can desync the actual gameplay.
- **Client (`mp-client.js`)** — injected into the game HTML. It:
  - adds the lobby UI overlay + HUD,
  - exposes the game's globals via a tiny bridge,
  - **wraps** `renderWorld()` to draw remote trainers each frame (never replaces the loop),
  - throttles position updates (~10/s, only on change) to keep traffic light.

`build.py` regenerates `public/index.html` from the original game + bridge + client.

## Run locally

```bash
cd pokemon-mp
npm install
npm start
```

Open **http://localhost:3000** in multiple tabs/devices. One player clicks
**MULTIPLAYER JOURNEY → Create room**, shares the code; others **Join**, everyone
clicks **Ready**, host clicks **Start**. Pick a partner, then you'll all spawn in
the same world and see each other walking around.

## Deploy (Render)

This is a **Node** app. Use the included `render.yaml` (Blueprint) or set
**Build Command** = `npm install`, **Start Command** = `node mp-server.js`,
**Runtime** = Node. See your earlier Tic-Tac-Toe deploy steps — identical flow.

## Updating the game

If you change the base game, drop the new HTML in and rebuild:

```bash
GAME_SRC="/path/to/new-game.html" python3 build.py
```

## Known limitations

- Battles are still single-player (wild/CPU). Multiplayer here means a **shared
  overworld journey + lobby + chat**, not synchronized PvP battles.
- Peers in different sub-areas (cave/gym/mart) are only drawn when you're in the
  same area, so you won't see "ghosts" through walls.
- Free hosting tiers sleep when idle; the first load after a while can be slow.
