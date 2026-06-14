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

    const hud = document.createElement("div");
    hud.id = "mp-hud";
    hud.innerHTML = `
      <div id="mp-chatlog"></div>
      <div id="mp-chatrow">
        <input id="mp-chatinput" maxlength="200" placeholder="Press T to chat…">
        <button id="mp-chatsend">SEND</button>
      </div>`;
    document.body.appendChild(hud);

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
        document.getElementById("mp-hud").style.display = "flex";
        addChat(null, "Multiplayer journey started!");
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
    if (!MP.started || !G || !G.player || !window.World || !World.ctx) return;
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
      ctx.textAlign = "start";
    }
  }

  /* --------------- Position sync loop --------------- */
  function syncLoop() {
    if (MP.started && MP.connected) {
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

  /* --------------- Chat --------------- */
  function addChat(name, text) {
    const log = document.getElementById("mp-chatlog");
    const row = document.createElement("div");
    if (name) row.innerHTML = `<span class="nm">${esc(name)}:</span> ${esc(text)}`;
    else row.innerHTML = `<em style="color:#9fb3d1">${esc(text)}</em>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function sendChat() {
    const inp = document.getElementById("mp-chatinput");
    const t = inp.value.trim();
    if (!t) return;
    sendMsg("chat", { text: t });
    addChat(MP.name, t); // echo locally
    inp.value = "";
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
    document.getElementById("mp-chatsend").addEventListener("click", sendChat);
    document.getElementById("mp-chatinput").addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't let game movement keys fire while typing
      if (e.key === "Enter") sendChat();
    });
    // T to focus chat (only in journey, not while a game text input is active)
    window.addEventListener("keydown", (e) => {
      if (!MP.started) return;
      if (e.key.toLowerCase() === "t" && document.activeElement.id !== "mp-chatinput") {
        const inp = document.getElementById("mp-chatinput");
        if (inp && inp.offsetParent !== null) { e.preventDefault(); inp.focus(); }
      }
    });
  }

  function init() {
    injectStyles();
    injectDOM();
    injectTitleButton();
    wire();
    requestAnimationFrame(syncLoop);
    // try to hook render early (and keep trying until renderWorld exists)
    const h = setInterval(() => { if (hookRender()) clearInterval(h); }, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
