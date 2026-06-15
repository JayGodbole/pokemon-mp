/* ============================================================
   MULTIPLAYER JOURNEY MODULE  (non-invasive overlay)
   - Adds a title-menu button + lobby UI
   - Connects to the ws server, syncs overworld position
   - Renders peers on the world canvas by wrapping renderWorld()
   Designed to NOT modify the existing single-player game logic.
   ============================================================ */
(function () {
  "use strict";

  const MP = {
    ws: null,
    connected: false,
    me: null,            // my player id
    isHost: false,
    code: null,
    started: false,
    peers: new Map(),    // id -> { name, partner, tileX, tileY, dir, moving, area, px, py, t, fx, fy, last }
    lastSent: 0,
    lastSig: "",
    name: "Trainer",
    battling: [],        // ids of players currently in a battle
    battle: null,        // active PvP battle state for ME
    pendingInvite: null, // incoming invite {from, fromName}
  };
  window.MP = MP; // for debugging

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- current "area" so peers in different sub-maps don't overlap ----
  function currentArea() {
    const g = window.G || {};
    if (g._inTournament) return "tournament";
    if (g._inGym) return "gym";
    if (g._inMart) return "mart";
    if (g._inSubCave) return "subcave";
    if (g._inCave) return "cave";
    if (g._inNewTown) return "newtown";
    return "overworld";
  }

  /* ---------------- UI ---------------- */
  function injectStyles() {
    const css = `
    #mp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:none;
      align-items:center;justify-content:center;font-family:'Press Start 2P',monospace;}
    #mp-panel{background:#16213e;border:3px solid #FFD700;border-radius:10px;width:460px;max-width:94vw;
      max-height:90vh;overflow:auto;padding:18px;color:#fff;box-shadow:0 10px 40px rgba(0,0,0,.6);}
    #mp-panel h3{color:#FFD700;font-size:14px;text-align:center;margin-bottom:14px;letter-spacing:1px;}
    #mp-panel label{display:block;font-size:9px;color:#9fb3d1;margin:10px 0 5px;}
    #mp-panel input{width:100%;padding:9px;border-radius:6px;border:2px solid #0f3460;background:#0f1830;
      color:#fff;font-family:'Press Start 2P',monospace;font-size:10px;outline:none;}
    #mp-panel input.code{text-transform:uppercase;letter-spacing:6px;text-align:center;font-size:14px;}
    .mp-btn{width:100%;padding:11px;border:none;border-radius:6px;font-family:'Press Start 2P',monospace;
      font-size:10px;cursor:pointer;margin-top:12px;color:#111;background:#FFD700;box-shadow:0 4px 0 #b8860b;}
    .mp-btn.alt{background:#4fc3f7;box-shadow:0 4px 0 #0277bd;color:#062a3a;}
    .mp-btn.gray{background:#888;box-shadow:0 4px 0 #555;color:#111;}
    .mp-btn:active{transform:translateY(2px);box-shadow:0 1px 0 #b8860b;}
    .mp-divider{text-align:center;color:#6c7aa0;font-size:8px;margin:14px 0 2px;}
    #mp-close{position:absolute;top:14px;right:18px;color:#fff;background:#8B0000;border:none;border-radius:6px;
      padding:8px 12px;font-family:'Press Start 2P',monospace;font-size:9px;cursor:pointer;z-index:10000;}
    #mp-players{list-style:none;margin:6px 0;padding:0;}
    #mp-players li{display:flex;justify-content:space-between;align-items:center;background:#0f1830;
      border:2px solid #0f3460;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:9px;}
    #mp-players .nm{color:#fff;}
    #mp-players .tag{font-size:7px;padding:3px 6px;border-radius:4px;margin-left:6px;}
    .tag.host{background:#FFD700;color:#111;}
    .tag.ready{background:#4CAF50;color:#fff;}
    .tag.wait{background:#555;color:#ddd;}
    #mp-room-code{color:#FFD700;letter-spacing:4px;}
    #mp-hint{font-size:7px;color:#9fb3d1;line-height:1.6;margin-top:8px;text-align:center;}
    /* in-game HUD */
    #mp-hud{position:fixed;left:12px;bottom:12px;z-index:9000;font-family:'Press Start 2P',monospace;
      display:none;flex-direction:column;gap:6px;}
    #mp-chatlog{width:240px;max-height:120px;overflow-y:auto;background:rgba(15,24,48,.85);
      border:2px solid #0f3460;border-radius:6px;padding:6px;color:#fff;font-size:7px;line-height:1.7;}
    #mp-chatlog .nm{color:#FFD700;}
    #mp-chatrow{display:flex;gap:4px;}
    #mp-chatinput{flex:1;padding:6px;border-radius:5px;border:2px solid #0f3460;background:#0f1830;color:#fff;
      font-family:'Press Start 2P',monospace;font-size:7px;outline:none;}
    #mp-chatsend{padding:0 8px;border:none;border-radius:5px;background:#FFD700;color:#111;
      font-family:'Press Start 2P',monospace;font-size:7px;cursor:pointer;}
    #mp-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#8B0000;color:#fff;
      padding:9px 16px;border-radius:6px;font-family:'Press Start 2P',monospace;font-size:8px;z-index:10001;display:none;}
    #mp-badge{position:fixed;top:10px;right:10px;background:#4CAF50;color:#fff;font-family:'Press Start 2P',monospace;
      font-size:7px;padding:5px 8px;border-radius:5px;z-index:9000;display:none;}

    /* ===== always-on bottom chat bar ===== */
    #mp-chatbar{position:fixed;left:0;right:0;bottom:0;z-index:9500;background:rgba(12,18,38,.95);
      border-top:2px solid #FFD700;font-family:'Press Start 2P',monospace;display:none;
      flex-direction:column;max-height:38vh;}
    #mp-chatbar-head{display:flex;justify-content:space-between;align-items:center;padding:5px 10px;
      font-size:7px;color:#FFD700;cursor:pointer;user-select:none;background:rgba(0,0,0,.25);}
    #mp-chatbar-log{overflow-y:auto;padding:6px 10px;font-size:8px;color:#fff;line-height:1.8;max-height:22vh;}
    #mp-chatbar-log .nm{color:#FFD700;}
    #mp-chatbar-log em{color:#9fb3d1;}
    #mp-chatbar-row{display:flex;gap:6px;padding:6px 10px 8px;}
    #mp-chatbar-input{flex:1;padding:8px;border-radius:6px;border:2px solid #0f3460;background:#0f1830;color:#fff;
      font-family:'Press Start 2P',monospace;font-size:8px;outline:none;}
    #mp-chatbar-send{padding:0 14px;border:none;border-radius:6px;background:#FFD700;color:#111;
      font-family:'Press Start 2P',monospace;font-size:8px;cursor:pointer;}
    #mp-chatbar.collapsed #mp-chatbar-log,#mp-chatbar.collapsed #mp-chatbar-row{display:none;}

    /* ===== peer context menu ===== */
    #mp-menu{position:fixed;z-index:10002;background:#16213e;border:2px solid #FFD700;border-radius:8px;
      font-family:'Press Start 2P',monospace;padding:8px;display:none;min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,.5);}
    #mp-menu .mp-menu-name{font-size:8px;color:#FFD700;text-align:center;margin-bottom:6px;}
    #mp-menu button{width:100%;margin:4px 0;padding:8px;border:none;border-radius:5px;font-size:7px;
      font-family:'Press Start 2P',monospace;cursor:pointer;background:#4fc3f7;color:#062a3a;}
    #mp-menu button.warn{background:#FFD700;color:#111;}
    #mp-menu button.gray{background:#777;color:#fff;}

    /* ===== PvP battle overlay ===== */
    #mp-battle{position:fixed;inset:0;z-index:9800;background:#1a1a2e;display:none;
      font-family:'Press Start 2P',monospace;color:#fff;flex-direction:column;}
    #mp-battle-arena{flex:1;position:relative;background:linear-gradient(180deg,#7ec0ee 0%,#a8e063 70%);}
    .mp-mon{position:absolute;text-align:center;}
    .mp-mon img{width:120px;height:120px;image-rendering:pixelated;}
    #mp-foe{top:24px;right:40px;}
    #mp-me{bottom:90px;left:40px;}
    .mp-hpbox{background:rgba(15,24,48,.92);border:2px solid #FFD700;border-radius:8px;padding:6px 10px;
      position:absolute;min-width:160px;}
    #mp-foe-hpbox{top:20px;left:20px;}
    #mp-me-hpbox{bottom:150px;right:20px;}
    .mp-hpbox .nm{font-size:8px;color:#FFD700;margin-bottom:5px;}
    .mp-hpbar-bg{height:8px;background:#333;border-radius:4px;overflow:hidden;}
    .mp-hpbar{height:100%;background:#4CAF50;transition:width .3s;}
    .mp-hpbox .hpnum{font-size:7px;margin-top:3px;color:#cfe;}
    #mp-battle-ui{background:#0f1830;border-top:3px solid #FFD700;padding:10px;min-height:120px;}
    #mp-battle-text{font-size:9px;line-height:1.7;min-height:34px;margin-bottom:8px;}
    #mp-moves{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    #mp-moves button{padding:10px;border:none;border-radius:6px;font-family:'Press Start 2P',monospace;
      font-size:8px;cursor:pointer;background:#4fc3f7;color:#062a3a;text-align:left;}
    #mp-moves button:disabled{background:#555;color:#aaa;cursor:not-allowed;}
    #mp-battle-flee{margin-top:8px;padding:8px 14px;border:none;border-radius:6px;background:#8B0000;color:#fff;
      font-family:'Press Start 2P',monospace;font-size:7px;cursor:pointer;}
    #mp-battle-end{position:absolute;inset:0;background:rgba(0,0,0,.78);display:none;flex-direction:column;
      align-items:center;justify-content:center;gap:16px;z-index:5;}
    #mp-battle-end h2{font-size:18px;color:#FFD700;text-shadow:3px 3px 0 #333;}
    #mp-battle-end button{padding:12px 24px;border:none;border-radius:8px;background:#FFD700;color:#111;
      font-family:'Press Start 2P',monospace;font-size:10px;cursor:pointer;}

    /* ===== spectator ===== */
    #mp-spectate-note{position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:9700;
      background:rgba(15,24,48,.95);border:2px solid #4fc3f7;border-radius:8px;padding:8px 14px;
      font-family:'Press Start 2P',monospace;font-size:8px;color:#fff;display:none;}
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectDOM() {
    const overlay = document.createElement("div");
    overlay.id = "mp-overlay";
    overlay.innerHTML = `
      <div id="mp-panel">
        <button id="mp-close">X</button>
        <!-- ENTRY -->
        <div id="mp-entry">
          <h3>MULTIPLAYER JOURNEY</h3>
          <label>YOUR NAME</label>
          <input id="mp-name" maxlength="16" placeholder="Trainer">
          <button class="mp-btn" id="mp-create">CREATE ROOM</button>
          <div class="mp-divider">— OR JOIN A ROOM —</div>
          <label>ROOM CODE</label>
          <input id="mp-join-code" class="code" maxlength="4" placeholder="ABCD">
          <button class="mp-btn alt" id="mp-join">JOIN ROOM</button>
          <div id="mp-hint">Up to 8 trainers can journey together.<br>See each other walk the same world in real time.</div>
        </div>
        <!-- LOBBY -->
        <div id="mp-lobby" style="display:none;">
          <h3>LOBBY · <span id="mp-room-code">----</span></h3>
          <ul id="mp-players"></ul>
          <button class="mp-btn" id="mp-ready">I'M READY</button>
          <button class="mp-btn alt" id="mp-startbtn" style="display:none;">START JOURNEY (HOST)</button>
          <div id="mp-hint">Share the room code with friends.<br>Host starts when everyone is ready.<br>You'll pick your partner after starting.</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // ALWAYS-ON bottom chat bar
    const bar = document.createElement("div");
    bar.id = "mp-chatbar";
    bar.innerHTML = `
      <div id="mp-chatbar-head"><span>💬 LIVE CHAT (press T) — <span id="mp-bar-room"></span></span><span id="mp-bar-toggle">▾ hide</span></div>
      <div id="mp-chatbar-log"></div>
      <div id="mp-chatbar-row">
        <input id="mp-chatbar-input" maxlength="200" placeholder="Type a message…">
        <button id="mp-chatbar-send">SEND</button>
      </div>`;
    document.body.appendChild(bar);

    // peer context menu
    const menu = document.createElement("div");
    menu.id = "mp-menu";
    document.body.appendChild(menu);

    // PvP battle overlay
    const battle = document.createElement("div");
    battle.id = "mp-battle";
    battle.innerHTML = `
      <div id="mp-battle-arena">
        <div class="mp-hpbox" id="mp-foe-hpbox"><div class="nm" id="mp-foe-name">FOE</div>
          <div class="mp-hpbar-bg"><div class="mp-hpbar" id="mp-foe-hp"></div></div><div class="hpnum" id="mp-foe-hpnum"></div></div>
        <div class="mp-mon" id="mp-foe"><img id="mp-foe-img" alt=""></div>
        <div class="mp-mon" id="mp-me"><img id="mp-me-img" alt=""></div>
        <div class="mp-hpbox" id="mp-me-hpbox"><div class="nm" id="mp-me-name">YOU</div>
          <div class="mp-hpbar-bg"><div class="mp-hpbar" id="mp-me-hp"></div></div><div class="hpnum" id="mp-me-hpnum"></div></div>
        <div id="mp-battle-end"><h2 id="mp-battle-end-text">VICTORY!</h2><button id="mp-battle-end-btn">RETURN TO JOURNEY</button></div>
      </div>
      <div id="mp-battle-ui">
        <div id="mp-battle-text">What will you do?</div>
        <div id="mp-moves"></div>
        <button id="mp-battle-flee">RUN AWAY</button>
      </div>`;
    document.body.appendChild(battle);

    const specNote = document.createElement("div");
    specNote.id = "mp-spectate-note";
    document.body.appendChild(specNote);

    const toast = document.createElement("div"); toast.id = "mp-toast"; document.body.appendChild(toast);
    const badge = document.createElement("div"); badge.id = "mp-badge"; document.body.appendChild(badge);
  }

  function injectTitleButton() {
    const menu = document.getElementById("title-menu");
    if (!menu) return;
    const btn = document.createElement("button");
    btn.className = "title-btn alt";
    btn.id = "btn-mp-journey";
    btn.textContent = "MULTIPLAYER JOURNEY";
    // place it right after NEW JOURNEY for visibility
    const after = document.getElementById("btn-new-journey");
    if (after && after.nextSibling) menu.insertBefore(btn, after.nextSibling);
    else menu.appendChild(btn);
    btn.addEventListener("click", openOverlay);
  }

  function openOverlay() {
    document.getElementById("mp-overlay").style.display = "flex";
    showEntry();
  }
  function closeOverlay() { document.getElementById("mp-overlay").style.display = "none"; }
  function showEntry() {
    document.getElementById("mp-entry").style.display = "block";
    document.getElementById("mp-lobby").style.display = "none";
  }
  function showLobby() {
    document.getElementById("mp-entry").style.display = "none";
    document.getElementById("mp-lobby").style.display = "block";
    // reset ready button to a known state on entering a fresh lobby
    const rb = document.getElementById("mp-ready");
    rb.dataset.r = "0"; rb.textContent = "I'M READY"; rb.classList.remove("gray");
  }

  function toast(msg) {
    const t = document.getElementById("mp-toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(t._tm); t._tm = setTimeout(() => (t.style.display = "none"), 2800);
  }

  /* ---------------- WS ---------------- */
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  function connect() {
    return new Promise((resolve, reject) => {
      if (location.protocol === "file:") {
        toast("Run the server, then open http://localhost:3000");
        return reject(new Error("file://"));
      }
      try { MP.ws = new WebSocket(wsUrl()); }
      catch (e) { toast("Cannot connect."); return reject(e); }
      let done = false;
      const fail = (m) => { if (!done) { done = true; toast(m); reject(new Error(m)); } };
      const timer = setTimeout(() => fail("Server not reachable."), 4500);
      MP.ws.onopen = () => { done = true; MP.connected = true; clearTimeout(timer); resolve(); };
      MP.ws.onerror = () => fail("Connection failed. Is the server running?");
      MP.ws.onclose = () => { MP.connected = false; if (MP.started) toast("Disconnected from server."); };
      MP.ws.onmessage = (e) => handle(JSON.parse(e.data));
    });
  }
  function sendMsg(type, payload = {}) {
    if (MP.ws && MP.ws.readyState === WebSocket.OPEN) MP.ws.send(JSON.stringify({ type, ...payload }));
  }

  function handle(msg) {
    switch (msg.type) {
      case "joined":
        MP.me = msg.you; MP.isHost = !!msg.host; MP.code = msg.code;
        document.getElementById("mp-room-code").textContent = msg.code;
        showLobby();
        showChatBar(); // chat available from the lobby onward
        break;
      case "lobby":
        renderLobby(msg);
        break;
      case "peer_joined":
        addChat(null, `${msg.player.name} joined.`);
        break;
      case "peer_left":
        if (MP.peers.has(msg.id)) { addChat(null, `${MP.peers.get(msg.id).name} left.`); }
        MP.peers.delete(msg.id);
        break;
      case "start":
        MP.started = true;
        closeOverlay();
        document.getElementById("mp-badge").style.display = "block";
        document.getElementById("mp-badge").textContent = "MP · " + MP.code;
        showChatBar();
        addChat(null, "Multiplayer journey started! Click a trainer to battle them.");
        // when our world is ready we will request a snapshot (see ensureSyncLoop)
        startNewJourneyFlow();
        break;
      case "snapshot":
        (msg.peers || []).forEach(upsertPeer);
        break;
      case "peer_pos":
        upsertPeer(msg);
        break;
      case "chat":
        addChat(msg.name, msg.text);
        break;
      case "battle_status":
        MP.battling = msg.battling || [];
        break;
      case "battle_invited":
        MP.pendingInvite = { from: msg.from, fromName: msg.fromName };
        showInvitePrompt(msg.fromName, msg.from);
        break;
      case "battle_invite_sent":
        toast("Battle request sent to " + msg.toName + "…");
        break;
      case "battle_declined":
        toast(msg.byName + " declined your battle.");
        break;
      case "battle_start":
        openBattle(msg);
        break;
      case "battle_waiting":
        if (MP.battle && msg.chosen !== MP.me) setBattleText("Opponent locked in their move…");
        break;
      case "battle_turn":
        playBattleTurn(msg);
        break;
      case "battle_end":
        finishBattle(msg);
        break;
      case "error":
        toast(msg.message || "Error");
        break;
    }
  }

  function renderLobby(state) {
    document.getElementById("mp-room-code").textContent = state.code;
    const ul = document.getElementById("mp-players");
    ul.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      const tags =
        (p.isHost ? `<span class="tag host">HOST</span>` : "") +
        (p.ready ? `<span class="tag ready">READY</span>` : `<span class="tag wait">WAIT</span>`);
      li.innerHTML = `<span class="nm">${esc(p.name)}${p.id === MP.me ? " (you)" : ""}</span><span>${tags}</span>`;
      ul.appendChild(li);
    });
    // host start button enabled only when all ready and >=2 players
    const allReady = state.players.length >= 2 && state.players.every((p) => p.ready);
    const startBtn = document.getElementById("mp-startbtn");
    startBtn.style.display = MP.isHost ? "block" : "none";
    startBtn.disabled = !allReady;
    startBtn.classList.toggle("gray", !allReady);
    startBtn.textContent = allReady ? "START JOURNEY (HOST)" :
      (state.players.length < 2 ? "WAITING FOR PLAYERS…" : "WAITING: ALL READY?");
  }

  /* --------------- Peer interpolation/state --------------- */
  function upsertPeer(d) {
    if (d.id === MP.me) return;
    let p = MP.peers.get(d.id);
    const TILE = window.TILE || 16;
    if (!p) {
      p = { name: d.name, partner: d.partner, tileX: d.tileX, tileY: d.tileY, dir: d.dir,
            moving: d.moving, area: d.area, px: d.tileX * TILE, py: d.tileY * TILE,
            tx: d.tileX, ty: d.tileY, fx: d.tileX, fy: d.tileY, t: 1, last: Date.now() };
      MP.peers.set(d.id, p);
    } else {
      p.name = d.name || p.name; p.partner = d.partner || p.partner;
      p.dir = d.dir; p.moving = d.moving; p.area = d.area; p.last = Date.now();
      // set up smooth interpolation toward new tile target
      p.fx = p.px / TILE; p.fy = p.py / TILE;
      p.tx = d.tileX; p.ty = d.tileY; p.t = 0;
      p.tileX = d.tileX; p.tileY = d.tileY;
    }
  }

  // advance peer interpolation each frame (called from render hook)
  function stepPeers() {
    const TILE = window.TILE || 16;
    const now = Date.now();
    for (const [id, p] of MP.peers) {
      if (now - p.last > 15000) { MP.peers.delete(id); continue; } // stale cleanup
      if (p.t < 1) {
        p.t = Math.min(1, p.t + 0.18);
        p.px = (p.fx + (p.tx - p.fx) * p.t) * TILE;
        p.py = (p.fy + (p.ty - p.fy) * p.t) * TILE;
      } else {
        p.px = p.tx * TILE; p.py = p.ty * TILE;
      }
    }
  }

  /* --------------- Render hook --------------- */
  // Wrap renderWorld so we draw peers right before it finishes a frame.
  function hookRender() {
    if (typeof window.renderWorld !== "function") return false;
    if (window.__mpRenderHooked) return true;
    const orig = window.renderWorld;
    window.renderWorld = function () {
      const r = orig.apply(this, arguments);
      try { drawPeers(); } catch (e) { /* never break the game loop */ }
      return r;
    };
    window.__mpRenderHooked = true;
    return true;
  }

  function drawPeers() {
    const G = window.G;
    const World = window.World;
    if (!MP.started || !G || !G.player || !World || !World.ctx) return;
    if (document.getElementById("world-screen").style.display !== "flex") return;
    stepPeers();

    const TILE = window.TILE || 16;
    const VIEW_W = window.VIEW_W || 240, VIEW_H = window.VIEW_H || 160;
    const ctx = World.ctx;
    // recompute the same camera the game uses
    const pw = G.player.px, ph = G.player.py;
    const maxX = World.W * TILE - VIEW_W, maxY = World.H * TILE - VIEW_H;
    let camX = pw - VIEW_W / 2 + 8; camX = Math.max(0, Math.min(maxX, camX));
    let camY = ph - VIEW_H / 2 + 8; camY = Math.max(0, Math.min(maxY, camY));

    const myArea = currentArea();
    const frame = (World.frame || 0);

    for (const p of MP.peers.values()) {
      if (p.area !== myArea) continue; // only same map
      const sx = p.px - camX, sy = p.py - camY;
      if (sx < -24 || sx > VIEW_W + 8 || sy < -28 || sy > VIEW_H + 8) continue;
      // shadow
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath(); ctx.ellipse(sx + 8, sy + 14, 6, 2, 0, 0, Math.PI * 2); ctx.fill();
      // sprite (reuse player char art; fall back to oak)
      const pf = p.moving ? (1 + (Math.floor(frame / 5) % 2)) : 0;
      const bob = p.moving ? ((Math.floor(frame / 5) % 2) ? 0 : -1) : 0;
      let cv;
      try { cv = window.getCharCanvas("player", p.dir || "down", pf); }
      catch (e) { cv = null; }
      if (cv) ctx.drawImage(cv, Math.round(sx), Math.round(sy - 4 + bob));
      // name tag
      ctx.font = "5px 'Press Start 2P', monospace";
      ctx.textAlign = "center";
      const name = (p.name || "?").slice(0, 10);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(sx + 8 - (name.length * 3) - 2, sy - 14, name.length * 6 + 4, 8);
      ctx.fillStyle = "#FFD700";
      ctx.fillText(name, sx + 8, sy - 8);
      // "in battle" marker
      if (MP.battling.includes(getPeerId(p))) {
        ctx.fillStyle = "#ff5d6c";
        ctx.fillText("\u2694", sx + 8, sy - 16);
      }
      ctx.textAlign = "start";
    }
  }
  function getPeerId(peerObj) {
    for (const [id, p] of MP.peers) if (p === peerObj) return id;
    return -1;
  }

  /* --------------- Position sync loop --------------- */
  function syncLoop() {
    if (MP.started && MP.connected && !MP.battle) {
      const G = window.G;
      if (G && G.player) {
        const now = Date.now();
        const sig = [G.player.tileX, G.player.tileY, G.player.dir, G.player.moving, currentArea()].join(",");
        // send on change OR at least every 1s as heartbeat, throttled to 10/s
        if ((sig !== MP.lastSig || now - MP.lastSent > 1000) && now - MP.lastSent > 90) {
          MP.lastSig = sig; MP.lastSent = now;
          sendMsg("pos", {
            tileX: G.player.tileX, tileY: G.player.tileY,
            dir: G.player.dir, moving: !!G.player.moving,
            area: currentArea(),
            name: MP.name,
            partner: G.partner ? G.partner.name : null,
          });
        }
      }
    }
    requestAnimationFrame(syncLoop);
  }

  // After "start", run the existing NEW JOURNEY flow (partner select -> world).
  function startNewJourneyFlow() {
    // Trigger the game's own partner-select screen, exactly like single player.
    if (typeof window.openPartnerSelect === "function") {
      window.openPartnerSelect();
    } else {
      const b = document.getElementById("btn-new-journey");
      if (b) b.click();
    }
    // Once we actually enter the world, ask the server for a snapshot of peers.
    waitForWorldThenSnapshot();
  }

  function waitForWorldThenSnapshot() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const ws = document.getElementById("world-screen");
      if (ws && ws.style.display === "flex" && window.G && window.G.player) {
        clearInterval(iv);
        hookRender();
        sendMsg("snapshot_request", {});
      }
      if (tries > 1200) clearInterval(iv); // ~2 min safety
    }, 100);
  }

  /* --------------- Chat (always-on bottom bar) --------------- */
  function showChatBar() {
    const bar = document.getElementById("mp-chatbar");
    bar.style.display = "flex";
    const r = document.getElementById("mp-bar-room");
    if (r) r.textContent = MP.code ? "Room " + MP.code : "";
  }
  function addChat(name, text) {
    const log = document.getElementById("mp-chatbar-log");
    if (!log) return;
    const row = document.createElement("div");
    if (name) row.innerHTML = `<span class="nm">${esc(name)}:</span> ${esc(text)}`;
    else row.innerHTML = `<em>${esc(text)}</em>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function sendChat() {
    const inp = document.getElementById("mp-chatbar-input");
    const t = inp.value.trim();
    if (!t) return;
    sendMsg("chat", { text: t });
    addChat(MP.name, t); // echo locally
    inp.value = "";
  }

  /* ============================================================
     PvP: peer click detection -> context menu -> invite -> battle
     ============================================================ */

  // Build a server-safe mon from my current partner.
  function myBattleMon() {
    const G = window.G;
    const p = (G && G.partner) ? G.partner : null;
    if (!p) return { id: 1, name: "Pokemon", type: "normal", level: 50,
      attack: 50, defense: 50, spAtk: 50, spDef: 50, speed: 50, maxHp: 100,
      moves: [{ name: "Tackle", type: "normal", power: 40, special: false, pp: 35 }] };
    return {
      id: p.id, name: p.name, type: p.type, level: p.level || 50,
      attack: p.attack, defense: p.defense, spAtk: p.spAtk, spDef: p.spDef, speed: p.speed,
      maxHp: p.maxHp, hp: p.maxHp,
      moves: (p.moves || []).map((m) => ({ name: m.name, type: m.type, power: m.power, special: !!m.special, pp: m.pp })),
    };
  }

  // Detect a click on the world canvas, find the nearest peer, open menu.
  function onCanvasClick(e) {
    if (!MP.started || MP.battle) return;
    const G = window.G;
    const World = window.World;
    if (!G || !G.player || !World) return;
    const canvas = document.getElementById("world-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const TILE = window.TILE || 16;
    const VIEW_W = window.VIEW_W || 240, VIEW_H = window.VIEW_H || 160;
    // map screen click to canvas internal coords
    const cx = (e.clientX - rect.left) * (VIEW_W / rect.width);
    const cy = (e.clientY - rect.top) * (VIEW_H / rect.height);
    // camera (same as renderWorld)
    const pw = G.player.px, ph = G.player.py;
    const maxX = World.W * TILE - VIEW_W, maxY = World.H * TILE - VIEW_H;
    let camX = Math.max(0, Math.min(maxX, pw - VIEW_W / 2 + 8));
    let camY = Math.max(0, Math.min(maxY, ph - VIEW_H / 2 + 8));
    const myArea = currentArea();

    // Forgiving hit test: pick the closest peer whose sprite box contains/near the click.
    let best = null, bestD = 1e9;
    for (const [id, p] of MP.peers) {
      if (p.area !== myArea) continue;
      const sx = p.px - camX, sy = p.py - camY; // sprite top-left (16x20)
      const centerX = sx + 8, centerY = sy + 6;
      // inside the sprite bounding box (with padding) OR within a generous radius
      const inBox = cx >= sx - 6 && cx <= sx + 22 && cy >= sy - 10 && cy <= sy + 24;
      const d = Math.hypot(centerX - cx, centerY - cy);
      if (inBox || d < 22) {
        if (d < bestD) { bestD = d; best = { id, p }; }
      }
    }
    if (best) {
      openPeerMenu(best.id, best.p, e.clientX, e.clientY);
    } else if (MP.peers.size === 0) {
      toast("No other trainers here yet.");
    } else {
      toast("Click directly on a trainer to interact.");
    }
  }

  function openPeerMenu(id, peer, x, y) {
    const menu = document.getElementById("mp-menu");
    const isBattling = MP.battling.includes(id);
    let html = `<div class="mp-menu-name">${esc(peer.name)}</div>`;
    if (isBattling) {
      // They are battling -> the clicker chooses what to do (your requested options)
      html += `<button class="gray" data-act="explore">KEEP EXPLORING</button>`;
      html += `<button data-act="spectate">SPECTATE BATTLE</button>`;
      html += `<button class="warn" data-act="notice">"BATTLE IN PROGRESS"</button>`;
    } else {
      html += `<button class="warn" data-act="invite">⚔ CHALLENGE TO BATTLE</button>`;
      html += `<button class="gray" data-act="close">CANCEL</button>`;
    }
    menu.innerHTML = html;
    menu.style.left = Math.min(x, window.innerWidth - 190) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 160) + "px";
    menu.style.display = "block";
    menu.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        menu.style.display = "none";
        if (act === "invite") {
          sendMsg("battle_invite", { target: id, mon: myBattleMon() });
        } else if (act === "spectate") {
          startSpectate(id, peer);
        } else if (act === "notice") {
          toast(peer.name + " is in a battle. Please wait.");
        }
        // explore / close / cancel -> just dismiss
      };
    });
  }

  function startSpectate(id, peer) {
    // Lightweight spectate: a non-interactive notice that tracks the battler.
    // (Full live battle mirroring would need server spectate channels; this keeps
    //  non-battlers from interfering while acknowledging your spectate option.)
    const note = document.getElementById("mp-spectate-note");
    note.textContent = "👀 Spectating " + peer.name + "'s battle…";
    note.style.display = "block";
    clearTimeout(note._tm);
    note._tm = setInterval(() => {
      if (!MP.battling.includes(id)) { note.style.display = "none"; clearInterval(note._tm); }
    }, 1000);
  }

  function showInvitePrompt(fromName, fromId) {
    const menu = document.getElementById("mp-menu");
    menu.innerHTML = `<div class="mp-menu-name">${esc(fromName)} challenges you!</div>
      <button class="warn" data-act="accept">⚔ ACCEPT</button>
      <button class="gray" data-act="decline">DECLINE</button>`;
    menu.style.left = (window.innerWidth / 2 - 90) + "px";
    menu.style.top = (window.innerHeight / 2 - 60) + "px";
    menu.style.display = "block";
    menu.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        menu.style.display = "none";
        if (b.dataset.act === "accept") sendMsg("battle_accept", { from: fromId, mon: myBattleMon() });
        else sendMsg("battle_decline", { from: fromId });
        MP.pendingInvite = null;
      };
    });
  }

  /* ============================================================
     PvP BATTLE OVERLAY
     ============================================================ */
  function spriteFront(id) { return (window.SPRITE_ANIM || "") + id + ".gif"; }
  function spriteBack(id) { return (window.SPRITE_BACK_ANIM || "") + id + ".gif"; }
  function spriteBaseFront(id) { return (window.SPRITE_BASE || "") + id + ".png"; }
  function spriteBaseBack(id) { return (window.SPRITE_BACK || "") + id + ".png"; }

  function openBattle(msg) {
    MP.battle = { id: msg.battleId, you: msg.you, opp: msg.opponent, state: msg.state, locked: false };
    if (window.G) window.G.worldPaused = true; // pause overworld for us
    const me = msg.state.mons[msg.you], foe = msg.state.mons[msg.opponent];
    document.getElementById("mp-me-name").textContent = (msg.yourName || "YOU") + " Lv" + (me.level || 50);
    document.getElementById("mp-foe-name").textContent = (msg.opponentName || "FOE") + " Lv" + (foe.level || 50);
    const meImg = document.getElementById("mp-me-img");
    meImg.src = spriteBack(me.id); meImg.onerror = function () { this.onerror = null; this.src = spriteBaseBack(me.id); };
    const foeImg = document.getElementById("mp-foe-img");
    foeImg.src = spriteFront(foe.id); foeImg.onerror = function () { this.onerror = null; this.src = spriteBaseFront(foe.id); };
    document.getElementById("mp-battle-end").style.display = "none";
    document.getElementById("mp-battle").style.display = "flex";
    renderBattleHp();
    renderMoves();
    setBattleText("Battle! " + foe.name + " vs " + me.name + ". Choose a move!");
  }

  function renderBattleHp() {
    const b = MP.battle; if (!b) return;
    const me = b.state.mons[b.you], foe = b.state.mons[b.opp];
    const setBar = (barId, numId, m) => {
      const pct = Math.max(0, (m.currentHp / m.maxHp) * 100);
      const bar = document.getElementById(barId);
      bar.style.width = pct + "%";
      bar.style.background = pct < 20 ? "#f44336" : pct < 50 ? "#FFD700" : "#4CAF50";
      document.getElementById(numId).textContent = Math.max(0, m.currentHp) + "/" + m.maxHp;
    };
    setBar("mp-me-hp", "mp-me-hpnum", me);
    setBar("mp-foe-hp", "mp-foe-hpnum", foe);
  }

  function renderMoves() {
    const b = MP.battle; if (!b) return;
    const me = b.state.mons[b.you];
    const wrap = document.getElementById("mp-moves");
    wrap.innerHTML = "";
    (me.moves || []).forEach((mv, i) => {
      const btn = document.createElement("button");
      btn.innerHTML = `${esc(mv.name)}<br><span style="font-size:6px;opacity:.8">${esc(mv.type)} · PP ${mv.currentPp}/${mv.pp}</span>`;
      btn.disabled = b.locked || mv.currentPp <= 0;
      btn.onclick = () => chooseMove(i);
      wrap.appendChild(btn);
    });
  }

  function chooseMove(i) {
    const b = MP.battle; if (!b || b.locked) return;
    b.locked = true;
    renderMoves();
    setBattleText("You chose " + b.state.mons[b.you].moves[i].name + ". Waiting for opponent…");
    sendMsg("battle_move", { index: i });
  }

  function setBattleText(t) { const el = document.getElementById("mp-battle-text"); if (el) el.textContent = t; }

  // Play a resolved turn's events with simple sequential timing.
  function playBattleTurn(msg) {
    const b = MP.battle; if (!b || msg.battleId !== b.id) return;
    b.state = msg.state;
    const events = msg.events || [];
    let i = 0;
    const step = () => {
      if (i >= events.length) {
        renderBattleHp();
        if (!b.state.over) { b.locked = false; renderMoves(); setBattleText("Choose your next move!"); }
        return;
      }
      const ev = events[i++];
      if (ev.kind === "use") {
        const who = ev.attacker === b.you ? b.state.mons[b.you].name : b.state.mons[b.opp].name;
        setBattleText(who + " used " + ev.move + "!");
      } else if (ev.kind === "damage") {
        renderBattleHp();
        flashHit(ev.defender === b.you ? "mp-me-img" : "mp-foe-img");
      } else if (ev.kind === "text") {
        setBattleText(ev.text);
      } else if (ev.kind === "faint") {
        const name = ev.who === b.you ? b.state.mons[b.you].name : b.state.mons[b.opp].name;
        setBattleText(name + " fainted!");
      }
      setTimeout(step, 900);
    };
    step();
  }

  function flashHit(imgId) {
    const el = document.getElementById(imgId);
    if (!el) return;
    el.style.filter = "brightness(3)";
    setTimeout(() => (el.style.filter = ""), 140);
  }

  function finishBattle(msg) {
    const b = MP.battle; if (!b || msg.battleId !== b.id) return;
    const end = document.getElementById("mp-battle-end");
    const txt = document.getElementById("mp-battle-end-text");
    let label = msg.youWon ? "VICTORY!" : "DEFEAT…";
    if (msg.reason === "opponent_left") label = "VICTORY!\n(opponent left)";
    if (msg.reason === "opponent_fled") label = "VICTORY!\n(opponent fled)";
    if (msg.reason === "you_fled") label = "YOU FLED";
    txt.textContent = label;
    end.style.display = "flex";
  }

  function closeBattle() {
    MP.battle = null;
    document.getElementById("mp-battle").style.display = "none";
    if (window.G) window.G.worldPaused = false; // resume overworld
  }

  /* --------------- Wire up --------------- */
  function wire() {
    document.getElementById("mp-close").addEventListener("click", closeOverlay);
    document.getElementById("mp-create").addEventListener("click", async () => {
      MP.name = (document.getElementById("mp-name").value || "Trainer").slice(0, 16);
      try { await connect(); sendMsg("create", { name: MP.name }); } catch (e) {}
    });
    document.getElementById("mp-join").addEventListener("click", async () => {
      const code = (document.getElementById("mp-join-code").value || "").toUpperCase().trim();
      if (code.length !== 4) return toast("Enter a 4-letter code");
      MP.name = (document.getElementById("mp-name").value || "Trainer").slice(0, 16);
      try { await connect(); sendMsg("join", { code, name: MP.name }); } catch (e) {}
    });
    document.getElementById("mp-join-code").addEventListener("input", (e) =>
      (e.target.value = e.target.value.toUpperCase()));
    document.getElementById("mp-ready").addEventListener("click", () => {
      const btn = document.getElementById("mp-ready");
      const nowReady = btn.dataset.r !== "1"; // toggle
      btn.dataset.r = nowReady ? "1" : "0";
      btn.textContent = nowReady ? "READY ✓ (CLICK TO UNREADY)" : "I'M READY";
      btn.classList.toggle("gray", nowReady === false);
      sendMsg("ready", { ready: nowReady, partner: (window.G && window.G.partner) ? window.G.partner.name : null });
    });
    document.getElementById("mp-startbtn").addEventListener("click", () => {
      if (MP.isHost) sendMsg("start", {});
    });
    // chat bar
    document.getElementById("mp-chatbar-send").addEventListener("click", sendChat);
    document.getElementById("mp-chatbar-input").addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't let game movement keys fire while typing
      if (e.key === "Enter") sendChat();
    });
    document.getElementById("mp-chatbar-head").addEventListener("click", () => {
      const bar = document.getElementById("mp-chatbar");
      bar.classList.toggle("collapsed");
      document.getElementById("mp-bar-toggle").textContent = bar.classList.contains("collapsed") ? "▴ show" : "▾ hide";
    });
    // T to focus chat (not while a battle/lobby input is focused)
    window.addEventListener("keydown", (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((MP.started || MP.code) && e.key.toLowerCase() === "t") {
        const inp = document.getElementById("mp-chatbar-input");
        if (inp && inp.offsetParent !== null) { e.preventDefault(); inp.focus(); }
      }
    });

    // PvP: click a peer in the overworld. Attach to the canvas AND the world
    // container so a click can't be swallowed by a layered element.
    const wc = document.getElementById("world-canvas");
    if (wc) wc.addEventListener("click", (e) => { e.stopPropagation(); onCanvasClick(e); });
    const ws = document.getElementById("world-screen");
    if (ws) ws.addEventListener("click", (e) => {
      // only handle if the click was on the canvas region (ignore HUD buttons)
      if (e.target && (e.target.id === "world-canvas" || e.target.id === "world-screen")) {
        e.stopPropagation(); onCanvasClick(e);
      }
    });
    // dismiss context menu on outside click
    document.addEventListener("click", (e) => {
      const menu = document.getElementById("mp-menu");
      if (menu.style.display === "block" && !menu.contains(e.target) &&
          e.target.id !== "world-canvas" && e.target.id !== "world-screen") {
        menu.style.display = "none";
      }
    });

    // battle overlay buttons
    document.getElementById("mp-battle-flee").addEventListener("click", () => {
      if (MP.battle) sendMsg("battle_flee", {});
    });
    document.getElementById("mp-battle-end-btn").addEventListener("click", closeBattle);
  }

  /* ============================================================
     MOBILE TOUCH CONTROLS  (on-screen D-pad + buttons)
     Works by dispatching synthetic keyboard events so the game's
     existing key handlers do all the work (movement, talk, advance text,
     and battle menus that already respond to taps).
     ============================================================ */
  const KEYCODES = {
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    a: { key: "Enter", code: "Enter", keyCode: 13 },
    space: { key: " ", code: "Space", keyCode: 32 },
    b: { key: "Escape", code: "Escape", keyCode: 27 },
  };
  function fireKey(name, type) {
    const k = KEYCODES[name];
    if (!k) return;
    // Dispatch ONCE. The event bubbles, so a single dispatch on document reaches
    // both document-level and window-level listeners (the game binds keydown on
    // document and keyup on window). Dispatching multiple times caused the action
    // to fire twice (e.g. opening then instantly closing a dialogue).
    const ev = new KeyboardEvent(type, {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
  }

  function mq(q) {
    try { return window.matchMedia ? window.matchMedia(q).matches : false; }
    catch (e) { return false; }
  }
  function isSmallScreen() {
    return mq("(max-width: 700px)") || (window.innerWidth && window.innerWidth <= 700);
  }
  function isTouchDevice() {
    return ("ontouchstart" in window) || (navigator.maxTouchPoints > 0) || mq("(pointer: coarse)");
  }

  function injectTouchStyles() {
    const css = `
    /* responsive: scale the WHOLE gameboy down with transform so every internal
       pixel position (world AND battle sprites/HP boxes) stays perfectly aligned.
       We do NOT resize #game-screen itself — that would misplace absolutely-positioned
       battle sprites and status bars. */
    @media (max-width: 700px) {
      body { align-items:flex-start; justify-content:flex-start; padding:0; overflow-y:auto;
        padding-bottom:210px; }
      #mp-scale-wrap { transform-origin:top center; }
    }

    /* on-screen controls */
    #mp-touch{position:fixed;left:0;right:0;bottom:0;z-index:9600;display:none;
      pointer-events:none;padding:8px 10px calc(8px + env(safe-area-inset-bottom));
      justify-content:space-between;align-items:flex-end;
      font-family:'Press Start 2P',monospace;}
    #mp-touch.on{display:flex;}
    #mp-dpad{position:relative;width:150px;height:150px;pointer-events:auto;}
    .mp-dbtn{position:absolute;width:50px;height:50px;background:#2b2f44;border:2px solid #FFD700;
      color:#FFD700;font-size:16px;display:flex;align-items:center;justify-content:center;
      border-radius:10px;user-select:none;-webkit-user-select:none;touch-action:none;
      box-shadow:0 3px 0 #1a1d2e;}
    .mp-dbtn:active,.mp-dbtn.pressed{background:#FFD700;color:#111;box-shadow:0 1px 0 #1a1d2e;transform:translateY(2px);}
    #mp-d-up{top:0;left:50px;} #mp-d-down{bottom:0;left:50px;}
    #mp-d-left{left:0;top:50px;} #mp-d-right{right:0;top:50px;}
    #mp-d-center{top:50px;left:50px;width:50px;height:50px;background:#1a1d2e;border:2px solid #555;border-radius:8px;}
    #mp-actions{display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:auto;}
    .mp-abtn{min-width:64px;height:64px;border-radius:50%;background:#8B0000;border:3px solid #FFD700;
      color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;
      user-select:none;-webkit-user-select:none;touch-action:none;box-shadow:0 4px 0 #5a0000;padding:0 6px;}
    .mp-abtn.b{background:#1565c0;border-color:#90caf9;box-shadow:0 4px 0 #0d3c75;}
    .mp-abtn:active,.mp-abtn.pressed{transform:translateY(2px);box-shadow:0 1px 0 #5a0000;filter:brightness(1.2);}
    .mp-row{display:flex;gap:8px;}
    .mp-minibtn{padding:8px 10px;border-radius:8px;background:#2b2f44;border:2px solid #FFD700;color:#FFD700;
      font-size:7px;user-select:none;-webkit-user-select:none;touch-action:none;box-shadow:0 3px 0 #1a1d2e;}
    .mp-minibtn:active{transform:translateY(2px);box-shadow:0 1px 0 #1a1d2e;}
    #mp-touch-toggle{position:fixed;right:8px;bottom:calc(200px + env(safe-area-inset-bottom));z-index:9601;
      background:#FFD700;color:#111;border:none;border-radius:8px;padding:8px 10px;font-size:8px;
      font-family:'Press Start 2P',monospace;display:none;box-shadow:0 3px 0 #b8860b;}
    /* on touch, lift the chat bar above the control pad so they don't overlap */
    body.mp-has-touch #mp-chatbar{bottom:200px;max-height:30vh;}
    body.mp-has-touch #mp-chatbar-log{max-height:16vh;}
    @media (max-width: 700px){
      /* keep the PvP battle move buttons reachable above the pad */
      #mp-battle-ui{padding-bottom:210px;}
    }
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectTouchDOM() {
    const pad = document.createElement("div");
    pad.id = "mp-touch";
    pad.innerHTML = `
      <div id="mp-dpad">
        <div class="mp-dbtn" id="mp-d-up" data-dir="up">▲</div>
        <div class="mp-dbtn" id="mp-d-left" data-dir="left">◀</div>
        <div id="mp-d-center"></div>
        <div class="mp-dbtn" id="mp-d-right" data-dir="right">▶</div>
        <div class="mp-dbtn" id="mp-d-down" data-dir="down">▼</div>
      </div>
      <div id="mp-actions">
        <div class="mp-row">
          <div class="mp-minibtn" id="mp-t-bag">BAG</div>
          <div class="mp-minibtn" id="mp-t-party">PARTY</div>
        </div>
        <div class="mp-row">
          <div class="mp-abtn b" id="mp-b-btn">B</div>
          <div class="mp-abtn" id="mp-a-btn">A</div>
        </div>
      </div>`;
    document.body.appendChild(pad);

    const toggle = document.createElement("button");
    toggle.id = "mp-touch-toggle";
    toggle.textContent = "🎮 CONTROLS";
    document.body.appendChild(toggle);
  }

  function wireTouch() {
    // D-pad: hold to move (keydown on press, keyup on release)
    document.querySelectorAll(".mp-dbtn[data-dir]").forEach((el) => {
      const dir = el.dataset.dir;
      const press = (e) => { e.preventDefault(); el.classList.add("pressed"); fireKey(dir, "keydown"); };
      const release = (e) => { e.preventDefault(); el.classList.remove("pressed"); fireKey(dir, "keyup"); };
      el.addEventListener("touchstart", press, { passive: false });
      el.addEventListener("touchend", release, { passive: false });
      el.addEventListener("touchcancel", release, { passive: false });
      // mouse fallback (desktop testing)
      el.addEventListener("mousedown", press);
      el.addEventListener("mouseup", release);
      el.addEventListener("mouseleave", (e) => { if (el.classList.contains("pressed")) release(e); });
    });

    // A button = interact / talk / advance text / confirm.
    // Fire a SINGLE synthetic Space keydown per tap (the game advances on keydown).
    // We intentionally do NOT also click game-screen, which would double-advance and
    // instantly close a dialogue right after opening it.
    const tapButton = (el, keyName) => {
      let handled = false;
      const trigger = (e) => {
        e.preventDefault();
        el.classList.add("pressed");
        fireKey(keyName, "keydown");
        fireKey(keyName, "keyup");
        setTimeout(() => el.classList.remove("pressed"), 120);
      };
      // Use touchend for touch (avoids the browser also firing a ghost click),
      // and click for mouse/desktop. Guard so only one path runs per interaction.
      el.addEventListener("touchend", (e) => { handled = true; trigger(e); setTimeout(() => (handled = false), 400); }, { passive: false });
      el.addEventListener("click", (e) => { if (handled) return; trigger(e); });
    };
    tapButton(document.getElementById("mp-a-btn"), "space"); // SPACE = interact/advance
    tapButton(document.getElementById("mp-b-btn"), "b");       // ESC = back/close

    // BAG / PARTY -> click the game's own buttons (they exist in the world UI)
    const clickGame = (id) => { const b = document.getElementById(id); if (b) b.click(); };
    document.getElementById("mp-t-bag").addEventListener("click", () => clickGame("world-bag-btn"));
    document.getElementById("mp-t-party").addEventListener("click", () => clickGame("world-party-btn"));

    // show/hide toggle
    document.getElementById("mp-touch-toggle").addEventListener("click", () => {
      document.getElementById("mp-touch").classList.toggle("on");
    });
  }

  function maybeShowTouch() {
    if (isTouchDevice() || isSmallScreen()) {
      document.getElementById("mp-touch").classList.add("on");
      document.getElementById("mp-touch-toggle").style.display = "block";
      document.body.classList.add("mp-has-touch");
      setupResponsiveScale();
    }
  }

  // Scale the entire gameboy frame to fit narrow screens, preserving all internal
  // pixel layout (world + battle). Wrap #gameboy once, then scale the wrapper.
  function setupResponsiveScale() {
    const gb = document.getElementById("gameboy");
    if (!gb) return;
    let wrap = document.getElementById("mp-scale-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "mp-scale-wrap";
      gb.parentNode.insertBefore(wrap, gb);
      wrap.appendChild(gb);
    }
    const apply = () => {
      // only scale on small screens; otherwise reset
      if (!isSmallScreen()) {
        wrap.style.transform = "";
        wrap.style.height = "";
        return;
      }
      const frameW = gb.offsetWidth || 640;
      const frameH = gb.offsetHeight || 520;
      const margin = 8;
      const scale = Math.min(1, (window.innerWidth - margin) / frameW);
      wrap.style.transform = `scale(${scale})`;
      wrap.style.transformOrigin = "top center";
      // reserve the post-scale height so the page doesn't leave a huge gap / clip
      wrap.style.height = (frameH * scale) + "px";
      wrap.style.width = "100%";
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", () => setTimeout(apply, 200));
    // re-apply when switching between world/battle (sizes can change)
    setInterval(apply, 1500);
  }

  function init() {
    injectStyles();
    injectTouchStyles();
    injectDOM();
    injectTouchDOM();
    injectTitleButton();
    wire();
    wireTouch();
    maybeShowTouch();
    requestAnimationFrame(syncLoop);
    // try to hook render early (and keep trying until renderWorld exists)
    const h = setInterval(() => { if (hookRender()) clearInterval(h); }, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
