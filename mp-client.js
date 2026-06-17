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
    pendingTrade: null,  // outgoing trade I offered {kind,to,idx,payload}
    incomingTrade: null, // offer I received, awaiting my accept/decline
    talkTo: null,        // {id, p} of the player I'm currently talking to
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
    #mp-menu{min-width:200px;max-width:260px;}

    /* ===== Dedicated trade/interaction modal ===== */
    #mp-trade{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.72);display:none;
      align-items:center;justify-content:center;font-family:'Press Start 2P',monospace;padding:16px;}
    #mp-trade.show{display:flex;}
    #mp-trade-box{background:#16213e;border:3px solid #FFD700;border-radius:12px;width:330px;max-width:94vw;
      max-height:88vh;overflow:auto;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.6);}
    #mp-trade-title{color:#FFD700;font-size:11px;text-align:center;margin-bottom:12px;line-height:1.5;}
    #mp-trade-body{display:flex;flex-direction:column;gap:8px;}
    .mp-tbtn{width:100%;padding:12px;border:none;border-radius:8px;cursor:pointer;color:#062a3a;
      background:#4fc3f7;font-family:'Press Start 2P',monospace;font-size:9px;text-align:center;}
    .mp-tbtn.warn{background:#FFD700;color:#111;}
    .mp-tbtn.gray{background:#8893b0;color:#10182e;}
    .mp-tbtn.green{background:#4CAF50;color:#fff;}
    .mp-tbtn.red{background:#e0556a;color:#fff;}
    .mp-tbtn:active{transform:translateY(2px);filter:brightness(1.1);}
    .mp-tinfo{font-size:8px;color:#cfe;text-align:center;line-height:1.6;}
    .mp-tinput{width:100%;padding:11px;border-radius:8px;border:2px solid #0f3460;background:#0f1830;color:#fff;
      font-family:'Press Start 2P',monospace;font-size:12px;text-align:center;outline:none;}
    .mp-tlist{display:flex;flex-direction:column;gap:6px;max-height:46vh;overflow-y:auto;}
    .mp-titem{display:flex;justify-content:space-between;align-items:center;padding:11px;border:none;border-radius:8px;
      cursor:pointer;background:#2b3350;color:#fff;font-family:'Press Start 2P',monospace;font-size:8px;text-align:left;}
    .mp-titem:active{background:#3a4470;}
    .mp-titem .q{color:#FFD700;margin-left:10px;}
    .mp-trade-row{font-size:7px;color:#cfe;text-align:center;margin:6px 0;}
    .mp-trade-input{width:100%;padding:8px;margin:6px 0;border-radius:6px;border:2px solid #0f3460;
      background:#0f1830;color:#fff;font-family:'Press Start 2P',monospace;font-size:9px;outline:none;text-align:center;}
    .mp-list{max-height:160px;overflow-y:auto;margin:4px 0;}
    .mp-list-btn{width:100%;margin:3px 0;padding:8px;border:none;border-radius:5px;cursor:pointer;
      background:#2b3350;color:#fff;font-family:'Press Start 2P',monospace;font-size:7px;text-align:left;
      display:flex;justify-content:space-between;align-items:center;}
    .mp-list-btn:active{background:#3a4470;}
    .mp-list-btn .mp-qty{color:#FFD700;margin-left:8px;}

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

    // Dedicated full-screen trade/interaction modal (robust, self-contained).
    const trade = document.createElement("div");
    trade.id = "mp-trade";
    trade.innerHTML = `<div id="mp-trade-box">
        <div id="mp-trade-title">Trainer</div>
        <div id="mp-trade-body"></div>
      </div>`;
    document.body.appendChild(trade);

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
    // Robust: retry until the title menu exists, never double-insert, and give the
    // button a distinct look + clear position so it's always visible.
    let tries = 0;
    const tryInsert = () => {
      const menu = document.getElementById("title-menu");
      if (!menu) { if (tries++ < 100) setTimeout(tryInsert, 100); return; }
      if (document.getElementById("btn-mp-journey")) return; // already there
      const btn = document.createElement("button");
      btn.className = "title-btn alt";
      btn.id = "btn-mp-journey";
      btn.textContent = "🌐 MULTIPLAYER";
      // distinct, eye-catching style so it stands out from the other buttons
      btn.style.background = "linear-gradient(135deg,#7C4DFF,#4fc3f7)";
      btn.style.color = "#fff";
      btn.style.boxShadow = "0 4px 0 #4527a0";
      // place it directly after NEW JOURNEY (skip whitespace text nodes)
      const after = document.getElementById("btn-new-journey");
      if (after) after.insertAdjacentElement("afterend", btn);
      else menu.appendChild(btn);
      btn.addEventListener("click", openOverlay);
    };
    tryInsert();
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
    // builder-mode messages are handled by the builder module
    if (typeof msg.type === "string" && msg.type.indexOf("builder_") === 0) {
      if (MP._builderHandle && MP._builderHandle(msg)) return;
    }
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
      case "trade_offer":
        showTradeOffer(msg);
        break;
      case "trade_confirm":
        finalizeGivenTrade(msg);
        break;
      case "trade_cancel":
        MP.pendingTrade = null;
        toast((msg.fromName || "Player") + " declined the trade.");
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
  // Find a peer standing on a tile adjacent to me (up/down/left/right), same area.
  // Prefers the peer in the direction I'm facing, else any adjacent peer.
  /* ============================================================
     PLAYER INTERACTION + TRADING  (clean, modal-based)
     Stand next to another player and press A/Space to open this.
       1) Request Battle
       2) Exchange Money  (you = giver; recipient must accept)
       3) Give Items / Pokemon (separate lists; recipient must accept)
     ============================================================ */

  function adjacentPeer() {
    const G = window.G;
    if (!G || !G.player) return null;
    const myArea = currentArea();
    const px = G.player.tileX, py = G.player.tileY;
    const dv = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[G.player.dir] || [0,1];
    const cells = [
      { x:px+dv[0], y:py+dv[1] },
      { x:px, y:py-1 }, { x:px, y:py+1 }, { x:px-1, y:py }, { x:px+1, y:py },
    ];
    for (const c of cells) {
      for (const [id, p] of MP.peers) {
        if (p.area !== myArea) continue;
        if (p.tileX === c.x && p.tileY === c.y) return { id, p };
      }
    }
    return null;
  }

  function tryPeerInteract() {
    if (!MP.started || MP.battle) return false;
    if (tradeModalOpen()) return false;
    const hit = adjacentPeer();
    if (!hit) return false;
    MP.talkTo = hit;
    openTalkMenu(hit.id, hit.p);
    return true;
  }

  function tradeModalOpen() { return document.getElementById("mp-trade").classList.contains("show"); }
  function openModal(title, bodyHtml) {
    document.getElementById("mp-trade-title").innerHTML = title;
    document.getElementById("mp-trade-body").innerHTML = bodyHtml;
    document.getElementById("mp-trade").classList.add("show");
  }
  function closeModal() { document.getElementById("mp-trade").classList.remove("show"); }

  const moneyOf = () => (window.G && typeof window.G.money === "number") ? window.G.money : 0;
  function itemDefs() { return window.ITEM_DEFS || []; }

  function openTalkMenu(id, peer) {
    if (MP.battling.includes(id)) {
      openModal(esc(peer.name) + " is in a battle", '<button class="mp-tbtn gray" data-act="close">CLOSE</button>');
      return;
    }
    openModal("Talk to " + esc(peer.name),
      '<button class="mp-tbtn warn" data-act="battle">\u2694 REQUEST BATTLE</button>' +
      '<button class="mp-tbtn" data-act="money">\ud83d\udcb0 EXCHANGE MONEY</button>' +
      '<button class="mp-tbtn" data-act="items">\ud83c\udf92 GIVE AN ITEM</button>' +
      '<button class="mp-tbtn" data-act="pokemon">\ud83d\udd34 GIVE A POKEMON</button>' +
      '<button class="mp-tbtn gray" data-act="close">CANCEL</button>');
  }

  function screenMoney(peer) {
    openModal("Give money to " + esc(peer.name),
      '<div class="mp-tinfo">You have $' + moneyOf() + '</div>' +
      '<input id="mp-money-amt" class="mp-tinput" type="number" min="1" inputmode="numeric" placeholder="0">' +
      '<button class="mp-tbtn green" data-act="money-send">SEND OFFER</button>' +
      '<button class="mp-tbtn gray" data-act="back">BACK</button>');
    setTimeout(function(){ var i=document.getElementById("mp-money-amt"); if(i) i.focus(); }, 30);
  }

  function screenItems(peer) {
    const bag = (window.G && window.G.bag) || {};
    const owned = itemDefs().filter(function(d){ return (bag[d.key]||0) > 0; });
    const rows = owned.length
      ? owned.map(function(d){ return '<button class="mp-titem" data-act="item-pick" data-key="'+d.key+'"><span>'+esc(d.name)+'</span><span class="q">x'+bag[d.key]+'</span></button>'; }).join("")
      : '<div class="mp-tinfo">You have no items to give.</div>';
    openModal("Give an item to " + esc(peer.name), '<div class="mp-tlist">'+rows+'</div><button class="mp-tbtn gray" data-act="back">BACK</button>');
  }

  function screenPokemon(peer) {
    const party = (window.G && window.G.party) || [];
    const rows = party.length > 1
      ? party.map(function(m,idx){ return '<button class="mp-titem" data-act="poke-pick" data-idx="'+idx+'"><span>'+esc(m.name)+'</span><span class="q">Lv'+(m.level||50)+'</span></button>'; }).join("")
      : '<div class="mp-tinfo">You cannot give your only Pokemon.</div>';
    openModal("Give a Pokemon to " + esc(peer.name), '<div class="mp-tlist">'+rows+'</div><button class="mp-tbtn gray" data-act="back">BACK</button>');
  }

  function showTradeOffer(msg) {
    MP.incomingTrade = msg;
    var desc = "";
    if (msg.kind === "money") desc = "wants to give you<br>$" + msg.payload.amount;
    else if (msg.kind === "item") desc = "wants to give you<br>" + esc(msg.payload.name || msg.payload.key);
    else if (msg.kind === "pokemon") desc = "wants to give you<br>" + esc(msg.payload.mon.name) + " (Lv" + (msg.payload.mon.level||50) + ")";
    openModal(esc(msg.fromName) + " " + desc,
      '<button class="mp-tbtn green" data-act="offer-accept">ACCEPT</button>' +
      '<button class="mp-tbtn red" data-act="offer-decline">DECLINE</button>');
  }

  function showInvitePrompt(fromName, fromId) {
    MP.pendingInvite = { from: fromId, fromName: fromName };
    openModal(esc(fromName) + " challenges you<br>to a battle!",
      '<button class="mp-tbtn warn" data-act="inv-accept">\u2694 ACCEPT</button>' +
      '<button class="mp-tbtn gray" data-act="inv-decline">DECLINE</button>');
  }

  function wireTradeModal() {
    const modal = document.getElementById("mp-trade");
    modal.addEventListener("click", function(e){
      if (e.target === modal) { closeModal(); return; }
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      const act = btn.dataset.act;
      const t = MP.talkTo;
      const peer = t ? t.p : null;
      const id = t ? t.id : null;

      if (act === "close") { closeModal(); return; }
      if (act === "back") { openTalkMenu(id, peer); return; }
      if (act === "battle") { closeModal(); sendMsg("battle_invite", { target:id, mon:myBattleMon() }); toast("Battle request sent to " + (peer?peer.name:"player") + "\u2026"); return; }
      if (act === "money") { screenMoney(peer); return; }
      if (act === "items") { screenItems(peer); return; }
      if (act === "pokemon") { screenPokemon(peer); return; }

      if (act === "money-send") {
        const el = document.getElementById("mp-money-amt");
        const amt = Math.floor(Number(el ? el.value : 0) || 0);
        if (amt <= 0) return toast("Enter a valid amount.");
        if (amt > moneyOf()) return toast("You don't have that much money.");
        MP.pendingTrade = { kind:"money", to:id, payload:{ amount:amt } };
        sendMsg("trade_offer", { target:id, kind:"money", payload:{ amount:amt } });
        closeModal(); toast("Offered $" + amt + " to " + peer.name + ". Waiting\u2026"); return;
      }
      if (act === "item-pick") {
        const key = btn.dataset.key;
        const def = itemDefs().find(function(d){ return d.key === key; });
        MP.pendingTrade = { kind:"item", to:id, payload:{ key:key, name: def?def.name:key } };
        sendMsg("trade_offer", { target:id, kind:"item", payload:{ key:key, name: def?def.name:key } });
        closeModal(); toast("Offered " + (def?def.name:key) + " to " + peer.name + ". Waiting\u2026"); return;
      }
      if (act === "poke-pick") {
        const idx = Number(btn.dataset.idx);
        const party = (window.G && window.G.party) || [];
        const mon = party[idx];
        if (!mon) return;
        const monData = JSON.parse(JSON.stringify(mon));
        MP.pendingTrade = { kind:"pokemon", to:id, idx:idx, payload:{ mon:monData } };
        sendMsg("trade_offer", { target:id, kind:"pokemon", payload:{ mon:monData } });
        closeModal(); toast("Offered " + mon.name + " to " + peer.name + ". Waiting\u2026"); return;
      }

      if (act === "offer-accept") {
        const msg = MP.incomingTrade; MP.incomingTrade = null;
        if (!msg) { closeModal(); return; }
        applyReceived(msg.kind, msg.payload);
        sendMsg("trade_confirm", { target: msg.from, kind: msg.kind, payload: msg.payload });
        const what = msg.kind === "money" ? ("$" + msg.payload.amount) : msg.kind === "item" ? (msg.payload.name || msg.payload.key) : msg.payload.mon.name;
        toast("Received " + what + " from " + msg.fromName + "!");
        addChat(null, "You received " + what + " from " + msg.fromName + ".");
        closeModal(); return;
      }
      if (act === "offer-decline") {
        const msg = MP.incomingTrade; MP.incomingTrade = null;
        if (msg) sendMsg("trade_cancel", { target: msg.from });
        closeModal(); return;
      }
      if (act === "inv-accept") {
        const inv = MP.pendingInvite; MP.pendingInvite = null;
        if (inv) sendMsg("battle_accept", { from: inv.from, mon: myBattleMon() });
        closeModal(); return;
      }
      if (act === "inv-decline") {
        const inv = MP.pendingInvite; MP.pendingInvite = null;
        if (inv) sendMsg("battle_decline", { from: inv.from });
        closeModal(); return;
      }
    });
  }

  function applyReceived(kind, payload) {
    const G = window.G;
    if (!G) return;
    if (kind === "money") {
      G.money = (G.money || 0) + Math.max(0, Math.floor(payload.amount || 0));
    } else if (kind === "item") {
      G.bag = G.bag || {};
      G.bag[payload.key] = (G.bag[payload.key] || 0) + 1;
    } else if (kind === "pokemon") {
      G.party = G.party || [];
      const mon = payload.mon;
      mon.currentHp = mon.currentHp != null ? mon.currentHp : (mon.maxHp || mon.hp);
      mon.statMods = mon.statMods || { attack:0, defense:0, spAtk:0, spDef:0, speed:0 };
      if (G.party.length < 6) G.party.push(mon);
      else toast("Party full \u2014 Pokemon could not be added.");
    }
  }

  function finalizeGivenTrade(msg) {
    const G = window.G;
    const t = MP.pendingTrade; MP.pendingTrade = null;
    if (!G) return;
    if (msg.kind === "money") {
      G.money = Math.max(0, (G.money || 0) - Math.floor(msg.payload.amount || 0));
      addChat(null, "You gave $" + msg.payload.amount + " to " + msg.fromName + ".");
      toast("Gave $" + msg.payload.amount + " to " + msg.fromName + ".");
    } else if (msg.kind === "item") {
      if (G.bag && G.bag[msg.payload.key]) G.bag[msg.payload.key] = Math.max(0, G.bag[msg.payload.key] - 1);
      addChat(null, "You gave " + (msg.payload.name || msg.payload.key) + " to " + msg.fromName + ".");
      toast("Gave " + (msg.payload.name || msg.payload.key) + " to " + msg.fromName + ".");
    } else if (msg.kind === "pokemon") {
      if (t && typeof t.idx === "number" && G.party && G.party.length > 1) {
        G.party.splice(t.idx, 1);
        if (G.partnerIdx >= G.party.length) G.partnerIdx = 0;
        G.partner = G.party[G.partnerIdx];
      }
      addChat(null, "You gave " + msg.payload.mon.name + " to " + msg.fromName + ".");
      toast("Gave " + msg.payload.mon.name + " to " + msg.fromName + ".");
    }
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

    // PvP / TALK: press A / Space / Enter while standing next to another player to
    // open the interaction menu (battle / money / give). Use capture phase so we
    // can suppress the game's own interact() when a peer is adjacent.
    window.addEventListener("keydown", (e) => {
      if (!MP.started || MP.battle) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key;
      if (k === " " || k === "Enter") {
        // only intercept when actually in the overworld and a peer is adjacent
        const ws2 = document.getElementById("world-screen");
        if (!ws2 || ws2.style.display !== "flex") return;
        if (tryPeerInteract()) {
          // block the game's interact() so we don't also talk to an NPC
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    }, true); // capture = true so we run before the game's document keydown

    // (the trade modal manages its own backdrop dismissal in wireTradeModal)

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
    // A button: if standing next to another player, open the talk menu directly;
    // otherwise fall back to the game's interact/advance (synthetic Space).
    (function wireAButton() {
      const el = document.getElementById("mp-a-btn");
      let handled = false;
      const trigger = (e) => {
        e.preventDefault();
        el.classList.add("pressed");
        setTimeout(() => el.classList.remove("pressed"), 120);
        const ws2 = document.getElementById("world-screen");
        const inWorld = ws2 && ws2.style.display === "flex";
        if (MP.started && !MP.battle && inWorld && tryPeerInteract()) return; // opened talk menu
        fireKey("space", "keydown");
        fireKey("space", "keyup");
      };
      el.addEventListener("touchend", (e) => { handled = true; trigger(e); setTimeout(() => (handled = false), 400); }, { passive: false });
      el.addEventListener("click", (e) => { if (handled) return; trigger(e); });
    })();
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


  /* ============================================================
     BUILDER MODE  (global shared, persisted, endless world)
     Now rendered with the SAME graphics as the journey overworld:
     - game's drawTile() for grass/trees, getCharCanvas('player') for the
       customizable trainer sprite (and 'oak' for peers),
     - same TILE size & view, and REAL wild-Pokemon battles to earn money
       (winnings bank into the wallet that funds building).
     ============================================================ */
  const B = {
    on: false, inBattle: false,
    canvas: null, ctx: null, raf: null,
    me: null,
    cam: { x: 0, y: 0 },
    player: { x: 0, y: 0, px: 0, py: 0, dir: "down", moving: false, vehicle: null, tx: 0, ty: 0, t: 1, fx: 0, fy: 0 },
    held: null,
    peers: new Map(),
    objects: new Map(),
    placeMode: null,
    lastSent: 0, lastSig: "",
    frame: 0,
    stepsSinceBattle: 0,
  };
  const BT = 16;                 // SAME tile size as the overworld
  const BVIEW_W = 240, BVIEW_H = 160; // SAME internal view as the overworld (CSS upscales)

  const BUILD_CATALOG = [
    { key: "land",     name: "Land Plot",   price: 500,   color: "#caa15a" },
    { key: "tree",     name: "Tree",        price: 100,   color: "#2e7d32" },
    { key: "flower",   name: "Flowerbed",   price: 80,    color: "#e573a0" },
    { key: "fence",    name: "Fence",       price: 60,    color: "#b08850" },
    { key: "house",    name: "House",       price: 3000,  color: "#c0563a" },
    { key: "mansion",  name: "Mansion",     price: 12000, color: "#9c6ad6" },
    { key: "shop",     name: "Shop",        price: 6000,  color: "#3a8ac0" },
    { key: "pool",     name: "Pool",        price: 4000,  color: "#39b6e0" },
    { key: "car",      name: "Car",         price: 8000,  color: "#d83838" },
    { key: "bike",     name: "Bike",        price: 1500,  color: "#2f6cc4" },
    { key: "boat",     name: "Boat",        price: 10000, color: "#8d6e63" },
  ];
  const catInfo = (k) => BUILD_CATALOG.find((c) => c.key === k);
  const VEHICLES = { car: 0.30, bike: 0.24, boat: 0.28 };
  // Building footprints (w x h in tiles). Buildings are large & enterable.
  const FOOTPRINT = { house: { w: 2, h: 2 }, shop: { w: 2, h: 2 }, pool: { w: 2, h: 2 }, mansion: { w: 3, h: 3 } };
  const ENTERABLE = { house: 1, mansion: 1, shop: 1 };
  // Solid (can't walk through): fences, trees, and building tiles (except their door).
  const SOLID = { tree: 1, house: 1, mansion: 1, shop: 1, pool: 1, fence: 1 };

  function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  function isWildTree(x, y) { return hash2(x, y) < 0.035; }                 // sparser trees -> easy to walk around
  function isTallGrass(x, y) { return !isWildTree(x, y) && hash2(x + 5000, y + 5000) < 0.4; } // lots of grass = lots of encounters

  /* ---------- DOM ---------- */
  function buildBuilderDOM() {
    if (document.getElementById("mp-builder")) return;
    const css = document.createElement("style");
    css.textContent = `
      #mp-builder{position:fixed;inset:0;z-index:10080;background:#000;display:none;
        flex-direction:column;align-items:center;justify-content:center;font-family:'Press Start 2P',monospace;}
      #mp-builder.show{display:flex;}
      #bld-canvas{width:min(96vw,720px);height:auto;aspect-ratio:3/2;image-rendering:pixelated;display:block;background:#62a045;border:4px solid #222;border-radius:6px;}
      #bld-hud{position:fixed;top:10px;left:10px;right:10px;display:flex;justify-content:space-between;align-items:flex-start;pointer-events:none;z-index:10081;}
      #bld-wallet{background:rgba(15,24,48,.9);color:#7CFC9A;border:2px solid #FFD700;border-radius:8px;padding:8px 12px;font-size:9px;pointer-events:auto;}
      #bld-top-right{display:flex;gap:6px;pointer-events:auto;}
      .bld-btn{background:#FFD700;color:#111;border:none;border-radius:8px;padding:8px 11px;font-size:8px;font-family:'Press Start 2P',monospace;cursor:pointer;box-shadow:0 3px 0 #b8860b;}
      .bld-btn.red{background:#8B0000;color:#fff;box-shadow:0 3px 0 #5a0000;}
      .bld-btn.blue{background:#4fc3f7;color:#062a3a;box-shadow:0 3px 0 #0277bd;}
      #bld-palette{position:fixed;left:10px;bottom:10px;right:10px;display:none;flex-wrap:wrap;gap:6px;background:rgba(15,24,48,.92);border:2px solid #FFD700;border-radius:10px;padding:8px;max-height:34vh;overflow:auto;z-index:10081;}
      #bld-palette.show{display:flex;}
      .bld-item{background:#2b3350;color:#fff;border:2px solid transparent;border-radius:8px;padding:8px;font-size:7px;cursor:pointer;min-width:84px;text-align:center;}
      .bld-item .p{color:#FFD700;display:block;margin-top:4px;}
      .bld-item.active{border-color:#7CFC9A;}
      #bld-hint{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#fff;font-size:7px;padding:6px 10px;border-radius:6px;pointer-events:none;z-index:10081;}
      #bld-toast{position:fixed;top:54px;left:50%;transform:translateX(-50%);background:#8B0000;color:#fff;padding:9px 14px;border-radius:8px;font-size:8px;z-index:10090;display:none;font-family:'Press Start 2P',monospace;}
      /* on-screen controls */
      #bld-touch{position:fixed;left:0;right:0;bottom:0;z-index:10085;display:none;justify-content:space-between;align-items:flex-end;padding:10px 14px 16px;pointer-events:none;}
      #bld-touch.on{display:flex;}
      #bld-dpad{position:relative;width:144px;height:144px;pointer-events:auto;}
      .bld-d{position:absolute;width:46px;height:46px;background:#2b2f44;border:2px solid #FFD700;color:#FFD700;display:flex;align-items:center;justify-content:center;border-radius:10px;font-size:15px;user-select:none;touch-action:none;box-shadow:0 3px 0 #1a1d2e;}
      .bld-d:active{background:#FFD700;color:#111;transform:translateY(2px);}
      .bld-d[data-d="up"]{top:0;left:49px;} .bld-d[data-d="down"]{bottom:0;left:49px;}
      .bld-d[data-d="left"]{left:0;top:49px;} .bld-d[data-d="right"]{right:0;top:49px;}
      #bld-actions{display:flex;flex-direction:column;gap:8px;pointer-events:auto;}
      .bld-a{background:#8B0000;color:#fff;border:2px solid #FFD700;border-radius:10px;padding:12px 14px;font-size:8px;text-align:center;user-select:none;touch-action:none;box-shadow:0 3px 0 #5a0000;}
      .bld-a:active{transform:translateY(2px);}
      /* building interior */
      #bld-interior{position:fixed;inset:0;z-index:10095;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;padding:16px;}
      #bld-interior.show{display:flex;}
      #bld-int-box{background:#16213e;border:3px solid #FFD700;border-radius:12px;width:340px;max-width:94vw;padding:16px;color:#fff;display:flex;flex-direction:column;gap:8px;}
      #bld-int-title{color:#FFD700;font-size:12px;text-align:center;margin-bottom:6px;}
      .bld-int-row{font-size:8px;color:#cfe;line-height:1.6;text-align:center;margin-bottom:6px;}
      .bld-tbtn{padding:11px;border:none;border-radius:8px;cursor:pointer;background:#4fc3f7;color:#062a3a;font-family:'Press Start 2P',monospace;font-size:8px;}
      .bld-tbtn.green{background:#4CAF50;color:#fff;} .bld-tbtn.red{background:#8B0000;color:#fff;}
    `;
    document.head.appendChild(css);
    const div = document.createElement("div");
    div.id = "mp-builder";
    div.innerHTML = `
      <canvas id="bld-canvas" width="${BVIEW_W}" height="${BVIEW_H}"></canvas>
      <div id="bld-hud">
        <div id="bld-wallet">$0</div>
        <div id="bld-top-right">
          <button class="bld-btn" id="bld-build">🏗️ BUILD</button>
          <button class="bld-btn blue" id="bld-ride">🚗 RIDE/OFF</button>
          <button class="bld-btn red" id="bld-exit">✕ EXIT</button>
        </div>
      </div>
      <div id="bld-palette"></div>
      <div id="bld-hint">WASD/Arrows move · walk tall grass to find wild Pokemon · BUILD to place · X remove · E ride · enter buildings via the door</div>
      <!-- on-screen controls for phones -->
      <div id="bld-touch">
        <div id="bld-dpad">
          <div class="bld-d" data-d="up">▲</div>
          <div class="bld-d" data-d="left">◀</div>
          <div class="bld-d" data-d="right">▶</div>
          <div class="bld-d" data-d="down">▼</div>
        </div>
        <div id="bld-actions">
          <div class="bld-a" data-a="x">REMOVE</div>
          <div class="bld-a" data-a="e">RIDE</div>
        </div>
      </div>
      <!-- building interior overlay -->
      <div id="bld-interior">
        <div id="bld-int-box">
          <div id="bld-int-title">BUILDING</div>
          <div id="bld-int-body"></div>
          <button class="bld-tbtn red" id="bld-int-exit">✕ LEAVE</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    const toast = document.createElement("div"); toast.id = "bld-toast"; document.body.appendChild(toast);
    // wire interior exit + touch controls
    document.getElementById("bld-int-exit").onclick = exitBuilding;
    wireBuilderTouch();

    B.canvas = document.getElementById("bld-canvas");
    B.ctx = B.canvas.getContext("2d");
    B.ctx.imageSmoothingEnabled = false;

    const pal = document.getElementById("bld-palette");
    BUILD_CATALOG.forEach((c) => {
      const el = document.createElement("div");
      el.className = "bld-item"; el.dataset.key = c.key;
      el.innerHTML = `${c.name}<span class="p">$${c.price}</span>`;
      el.onclick = () => { B.placeMode = c.key; updatePaletteActive(); bToast("Tap a tile to place " + c.name); };
      pal.appendChild(el);
    });
    document.getElementById("bld-build").onclick = () => {
      pal.classList.toggle("show");
      if (!pal.classList.contains("show")) { B.placeMode = null; updatePaletteActive(); }
    };
    document.getElementById("bld-ride").onclick = toggleRide;
    document.getElementById("bld-exit").onclick = closeBuilder;
    B.canvas.addEventListener("click", onBuilderClick);
    window.addEventListener("keydown", builderKeyDown);
    window.addEventListener("keyup", builderKeyUp);
  }
  function updatePaletteActive() {
    document.querySelectorAll("#bld-palette .bld-item").forEach((el) => el.classList.toggle("active", el.dataset.key === B.placeMode));
  }
  function bToast(m) { const t = document.getElementById("bld-toast"); if (!t) return; t.textContent = m; t.style.display = "block"; clearTimeout(t._tm); t._tm = setTimeout(() => t.style.display = "none", 2200); }
  function bWallet() { try { return Math.max(0, Math.floor(Number(localStorage.getItem("pokemon_dino_wallet")) || 0)); } catch (e) { return 0; } }
  function bWalletSet(v) { try { localStorage.setItem("pokemon_dino_wallet", String(Math.max(0, Math.floor(v)))); } catch (e) {} }
  function refreshBWallet() { const el = document.getElementById("bld-wallet"); if (el) el.textContent = "$" + bWallet(); }

  /* ---------- starter team so you can battle wild Pokemon ---------- */
  function ensureBuilderParty() {
    const G = window.G;
    if (!G) return;
    if (G.party && G.party.length && G.partner) return; // already have a team (e.g. from a journey)
    const roster = window.POKEMON_ROSTER || [];
    if (!roster.length || !window.battleCopy) return;
    // give a mid-level starter so wild battles are winnable
    const starter = window.battleCopy(roster[Math.floor(Math.random() * Math.min(3, roster.length))]);
    starter.level = 50;
    G.partner = starter; G.party = [starter]; G.partnerIdx = 0;
    G.bag = G.bag || { potion: 3, pokeball: 5 };
    if (typeof G.money !== "number") G.money = 0;
    G._trainerParty = []; G._trainerPartyIdx = 0; G._defeatedOpponentLevels = [];
  }

  /* ---------- open / close ---------- */
  function openBuilder() {
    buildBuilderDOM();
    if (!MP.connected) connect().then(doOpenBuilder).catch(() => bToast("Can't reach server."));
    else doOpenBuilder();
  }
  function doOpenBuilder() {
    B.on = true; B.inBattle = false;
    // restore last saved location so you spawn where you left off
    let sx = 0, sy = 0;
    try { const s = JSON.parse(localStorage.getItem("pokemon_dino_builder_pos") || "null"); if (s) { sx = s.x | 0; sy = s.y | 0; } } catch (e) {}
    B.player = { x: sx, y: sy, px: sx * BT, py: sy * BT, dir: "down", moving: false, vehicle: null, tx: sx, ty: sy, t: 1, fx: sx, fy: sy };
    if (window.G) { window.G.mode = "adventure"; window.G.worldPaused = false; }
    ensureBuilderParty();
    document.getElementById("mp-builder").classList.add("show");
    refreshBWallet();
    MP.name = MP.name || "Builder";
    sendMsg("builder_join", { name: MP.name });
    if (!B.raf) builderLoop();
  }
  function closeBuilder() {
    if (!B.on) return;
    B.on = false;
    sendMsg("builder_leave", {});
    document.getElementById("mp-builder").classList.remove("show");
    if (B.raf) { cancelAnimationFrame(B.raf); B.raf = null; }
    const tm = document.getElementById("title-menu"), ps = document.getElementById("press-start");
    if (window.show) window.show("title-screen");
    if (ps) ps.style.display = "none";
    if (tm) tm.style.display = "flex";
  }

  /* ---------- input ---------- */
  function builderKeyDown(e) {
    if (!B.on) return;
    const k = e.key.toLowerCase();
    // M-cheat: press M four times within 1.2s -> +$99,999
    if (k === "m") {
      B._mCheat = (B._mCheat || 0) + 1;
      clearTimeout(B._mTimer); B._mTimer = setTimeout(() => { B._mCheat = 0; }, 1200);
      if (B._mCheat >= 4) { B._mCheat = 0; bWalletSet(bWallet() + 99999); refreshBWallet(); bToast("💰 CHEAT! +$99,999"); }
    }
    // interior overlay open? Enter/Space/Esc exits the building
    if (document.getElementById("bld-interior").classList.contains("show")) {
      if (k === "escape" || k === " " || k === "enter") { exitBuilding(); e.preventDefault(); }
      return;
    }
    if (B.inBattle) return;
    const map = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };
    if (map[k]) { B.held = map[k]; e.preventDefault(); }
    if (k === "x") { removeNearbyOwn(); e.preventDefault(); }
    if (k === "e") { toggleRide(); e.preventDefault(); }
    if (k === "escape") { closeBuilder(); }
  }
  function builderKeyUp(e) {
    if (!B.on) return;
    const k = e.key.toLowerCase();
    const map = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };
    if (map[k] === B.held) B.held = null;
  }

  // On-screen controls (phones): hold D-pad to move, action buttons for remove/ride.
  function wireBuilderTouch() {
    const isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const pad = document.getElementById("bld-touch");
    if (isTouch && pad) pad.classList.add("on");
    document.querySelectorAll("#bld-dpad .bld-d").forEach((el) => {
      const dir = el.dataset.d;
      const press = (e) => { e.preventDefault(); if (!B.inBattle) B.held = dir; };
      const release = (e) => { e.preventDefault(); if (B.held === dir) B.held = null; };
      el.addEventListener("touchstart", press, { passive: false });
      el.addEventListener("touchend", release, { passive: false });
      el.addEventListener("touchcancel", release, { passive: false });
      el.addEventListener("mousedown", press);
      el.addEventListener("mouseup", release);
      el.addEventListener("mouseleave", release);
    });
    document.querySelectorAll("#bld-actions .bld-a").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        if (el.dataset.a === "x") removeNearbyOwn();
        else if (el.dataset.a === "e") toggleRide();
      });
    });
  }
  function onBuilderClick(e) {
    if (!B.on || B.inBattle || !B.placeMode) return;
    const rect = B.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (BVIEW_W / rect.width);
    const cy = (e.clientY - rect.top) * (BVIEW_H / rect.height);
    const wx = Math.floor((cx + B.cam.x) / BT);
    const wy = Math.floor((cy + B.cam.y) / BT);
    placeAt(wx, wy, B.placeMode);
  }
  function placeAt(x, y, key) {
    const c = catInfo(key); if (!c) return;
    if (bWallet() < c.price) { bToast("Not enough money! Battle wild Pokemon to earn $."); return; }
    // footprint overlap check for large buildings (client-side, before sending)
    const fp = FOOTPRINT[key] || { w: 1, h: 1 };
    for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) {
      const tx = x + dx, ty = y + dy;
      if (isWildTree(tx, ty)) { bToast("Can't build on a tree."); return; }
      for (const o of B.objects.values()) {
        if (FOOTPRINT[o.type]) { if (inFootprint(o, tx, ty)) { bToast("That spot is occupied."); return; } }
        else if (o.x === tx && o.y === ty && o.type !== "land" && o.type !== "flower") { bToast("That spot is occupied."); return; }
      }
    }
    bWalletSet(bWallet() - c.price); refreshBWallet();
    B._pendingCost = (B._pendingCost || 0) + c.price;
    sendMsg("builder_place", { objType: key, x, y });
  }
  function removeNearbyOwn() {
    const px = Math.round(B.player.x), py = Math.round(B.player.y);
    let found = null;
    for (const o of B.objects.values()) { if (o.owner !== B.me) continue; if (Math.abs(o.x - px) <= 1 && Math.abs(o.y - py) <= 1) { found = o; break; } }
    if (found) sendMsg("builder_remove", { id: found.id });
    else bToast("Stand next to your own build, then press X.");
  }
  function toggleRide() {
    if (B.player.vehicle) { B.player.vehicle = null; bToast("Got off."); return; }
    const px = Math.round(B.player.x), py = Math.round(B.player.y);
    for (const o of B.objects.values()) {
      if (VEHICLES[o.type] && Math.abs(o.x - px) <= 1 && Math.abs(o.y - py) <= 1) { B.player.vehicle = o.type; bToast("Riding " + o.type + "!"); return; }
    }
    bToast("Stand next to a vehicle you placed, then press RIDE.");
  }

  /* ---------- movement + wild battles ---------- */
  function builderStep() {
    if (B.inBattle) return;
    const speed = B.player.vehicle ? (VEHICLES[B.player.vehicle] || 0.3) : 0.16;
    if (B.player.moving) {
      B.player.t += speed;
      if (B.player.t >= 1) {
        B.player.t = 1; B.player.x = B.player.tx; B.player.y = B.player.ty;
        B.player.px = B.player.x * BT; B.player.py = B.player.y * BT; B.player.moving = false;
        onBuilderTileEnter();
      } else {
        B.player.px = (B.player.fx + (B.player.tx - B.player.fx) * B.player.t) * BT;
        B.player.py = (B.player.fy + (B.player.ty - B.player.fy) * B.player.t) * BT;
      }
    } else if (B.held) {
      const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[B.held];
      B.player.dir = B.held;
      const nx = B.player.x + d[0], ny = B.player.y + d[1];
      if (canWalk(nx, ny)) { B.player.fx = B.player.x; B.player.fy = B.player.y; B.player.tx = nx; B.player.ty = ny; B.player.t = 0; B.player.moving = true; }
    }
  }
  // Door tile of a building footprint = bottom-center tile (entrance).
  function doorTile(o) {
    const fp = FOOTPRINT[o.type] || { w: 1, h: 1 };
    return { x: o.x + Math.floor(fp.w / 2), y: o.y + fp.h - 1 };
  }
  // Does world tile (x,y) fall inside object o's footprint?
  function inFootprint(o, x, y) {
    const fp = FOOTPRINT[o.type] || { w: 1, h: 1 };
    return x >= o.x && x < o.x + fp.w && y >= o.y && y < o.y + fp.h;
  }
  function canWalk(x, y) {
    if (isWildTree(x, y)) return false;
    for (const o of B.objects.values()) {
      if (!SOLID[o.type]) continue;
      if (FOOTPRINT[o.type]) {
        if (inFootprint(o, x, y)) {
          // the door tile is walkable (so you can enter); rest of footprint is solid
          const d = doorTile(o);
          if (ENTERABLE[o.type] && x === d.x && y === d.y) continue;
          return false;
        }
      } else if (o.x === x && o.y === y) {
        return false; // fence / tree single-tile block
      }
    }
    return true;
  }
  function onBuilderTileEnter() {
    const gx = Math.round(B.player.x), gy = Math.round(B.player.y);
    // Enter a building if standing on its door tile
    for (const o of B.objects.values()) {
      if (!ENTERABLE[o.type]) continue;
      const d = doorTile(o);
      if (gx === d.x && gy === d.y) { enterBuilding(o); return; }
    }
    // wild encounter chance in tall grass (no vehicle), like the journey
    B.stepsSinceBattle++;
    if (B.player.vehicle) return;
    if (isTallGrass(gx, gy) && B.stepsSinceBattle >= 2 && Math.random() < 0.25) {
      B.stepsSinceBattle = 0;
      startBuilderWildBattle();
    }
  }

  /* ---------- building interiors ---------- */
  function enterBuilding(o) {
    B.held = null;
    const names = { house: "HOUSE", mansion: "MANSION", shop: "SHOP" };
    const ov = document.getElementById("bld-interior");
    document.getElementById("bld-int-title").textContent =
      (o.ownerName ? o.ownerName + "'s " : "") + (names[o.type] || "BUILDING");
    let body = "";
    if (o.type === "shop") {
      body = `<div class="bld-int-row">Welcome to the shop! Buy items with your wallet.</div>
        <button class="bld-tbtn" data-shop="potion" data-price="200">Potion — $200</button>
        <button class="bld-tbtn" data-shop="superPotion" data-price="500">Super Potion — $500</button>
        <button class="bld-tbtn" data-shop="pokeball" data-price="150">Poke Ball — $150</button>`;
    } else if (o.type === "mansion") {
      body = `<div class="bld-int-row">🏛️ A luxurious mansion. Rest here to heal your Pokemon!</div>
        <button class="bld-tbtn green" data-int="heal">REST &amp; HEAL PARTY</button>`;
    } else {
      body = `<div class="bld-int-row">🏠 A cozy home. Rest here to heal your Pokemon!</div>
        <button class="bld-tbtn green" data-int="heal">REST &amp; HEAL PARTY</button>`;
    }
    document.getElementById("bld-int-body").innerHTML = body;
    ov.classList.add("show");
    ov.querySelectorAll("[data-int]").forEach((b) => b.onclick = () => {
      if (b.dataset.int === "heal") {
        if (window.G && window.G.party) window.G.party.forEach((p) => { p.currentHp = p.maxHp; (p.moves || []).forEach((m) => m.currentPp = m.pp); });
        bToast("Your Pokemon are fully healed!");
      }
    });
    ov.querySelectorAll("[data-shop]").forEach((b) => b.onclick = () => {
      const price = +b.dataset.price, key = b.dataset.shop;
      if (bWallet() < price) { bToast("Not enough money!"); return; }
      bWalletSet(bWallet() - price); refreshBWallet();
      window.G.bag = window.G.bag || {}; window.G.bag[key] = (window.G.bag[key] || 0) + 1;
      bToast("Bought " + key + "!");
    });
  }
  function exitBuilding() {
    document.getElementById("bld-interior").classList.remove("show");
    // step the player one tile below the door so they don't re-enter immediately
    const ny = B.player.y + 1;
    if (canWalk(B.player.x, ny)) { B.player.y = ny; B.player.py = ny * BT; B.player.ty = ny; B.player.fy = ny; }
  }
  function startBuilderWildBattle() {
    const G = window.G;
    if (!G || !window.launchBattle || !window.battleCopy || !window.WILD_POKEMON) return;
    ensureBuilderParty();
    B.inBattle = true; B.held = null;
    // pick a wild pokemon (Route 1 pool), modest levels so it's winnable
    const pool = window.WILD_ROUTE1 || [16, 19, 10];
    const wid = pool[Math.floor(Math.random() * pool.length)];
    const base = window.WILD_POKEMON.find(p => p.id === wid) || window.WILD_POKEMON[0];
    const enemy = window.battleCopy(base);
    enemy.level = 30 + Math.floor(Math.random() * 25);
    G.mode = "adventure";
    G._trainerNPC = null; G._catchable = true; G._forceBattle = false;
    G._trainerParty = []; G._trainerPartyIdx = 0; G._defeatedOpponentLevels = [];
    G.partner.currentHp = G.partner.maxHp; // heal before each battle so it stays fun
    // mark so our endBattle hook returns us to the builder
    G._builderBattle = true;
    // hide the builder overlay so the game's battle screen (inside the gameboy
    // frame) is visible; pause the builder loop while battling.
    const ov = document.getElementById("mp-builder");
    if (ov) ov.classList.remove("show");
    window.launchBattle(window.battleCopy(G.partner), enemy, "adventure");
  }

  /* ---------- loop + render (overworld graphics) ---------- */
  function builderLoop() {
    B.frame++;
    if (!B.inBattle) {
      builderStep();
      for (const [id, p] of B.peers) { if (p.t < 1) { p.t = Math.min(1, p.t + 0.2); p.px = (p.fx + (p.tx - p.fx) * p.t) * BT; p.py = (p.fy + (p.ty - p.fy) * p.t) * BT; } }
      B.cam.x = B.player.px - BVIEW_W / 2 + BT / 2;
      B.cam.y = B.player.py - BVIEW_H / 2 + BT / 2;
      drawBuilder();
      sendBuilderPos();
    }
    B.raf = requestAnimationFrame(builderLoop);
  }
  function sendBuilderPos() {
    const now = Date.now();
    const sig = [Math.round(B.player.x), Math.round(B.player.y), B.player.dir, B.player.moving, B.player.vehicle].join(",");
    if ((sig !== B.lastSig || now - B.lastSent > 1000) && now - B.lastSent > 80) {
      B.lastSig = sig; B.lastSent = now;
      sendMsg("builder_pos", { x: B.player.x, y: B.player.y, dir: B.player.dir, moving: B.player.moving, vehicle: B.player.vehicle });
      // persist last location so we respawn here next time
      try { localStorage.setItem("pokemon_dino_builder_pos", JSON.stringify({ x: Math.round(B.player.x), y: Math.round(B.player.y) })); } catch (e) {}
    }
  }

  function drawBuilder() {
    const ctx = B.ctx; if (!ctx) return;
    const T = window.T, drawTile = window.drawTile;
    const startX = Math.floor(B.cam.x / BT), startY = Math.floor(B.cam.y / BT);
    const offX = B.cam.x - startX * BT, offY = B.cam.y - startY * BT;
    ctx.fillStyle = "#62a045"; ctx.fillRect(0, 0, BVIEW_W, BVIEW_H);
    // ground using the GAME's drawTile (grass / tall grass), identical look
    for (let ry = 0; ry <= BVIEW_H / BT; ry++) for (let rx = 0; rx <= BVIEW_W / BT; rx++) {
      const wx = startX + rx, wy = startY + ry;
      const sx = rx * BT - offX, sy = ry * BT - offY;
      let type = (T ? T.GRASS : 0);
      if (T && isTallGrass(wx, wy)) type = T.TALL;
      if (drawTile && T) drawTile(ctx, type, sx, sy, wx, wy, B.frame);
      else { ctx.fillStyle = ((wx + wy) & 1) ? "#62a045" : "#5c9a40"; ctx.fillRect(sx, sy, BT, BT); }
    }
    // placed objects (depth-sorted)
    const objs = [...B.objects.values()].sort((a, b) => a.y - b.y);
    for (const o of objs) drawObject(ctx, o, o.x * BT - B.cam.x, o.y * BT - B.cam.y);
    // wild trees via the game's TREE tile (identical to overworld)
    for (let ry = -1; ry <= BVIEW_H / BT + 1; ry++) for (let rx = -1; rx <= BVIEW_W / BT + 1; rx++) {
      const wx = startX + rx, wy = startY + ry;
      if (isWildTree(wx, wy)) {
        const sx = rx * BT - offX, sy = ry * BT - offY;
        if (drawTile && T) drawTile(ctx, T.TREE, sx, sy, wx, wy, B.frame);
      }
    }
    // peers (use 'oak' style? -> use same player art for consistency)
    for (const p of B.peers.values()) drawCharAt(ctx, p.px - B.cam.x, p.py - B.cam.y, p.dir, p.moving, p.vehicle, p.name);
    // me (uses getCharCanvas('player') -> reflects customization)
    drawCharAt(ctx, B.player.px - B.cam.x, B.player.py - B.cam.y, B.player.dir, B.player.moving, B.player.vehicle, null);
  }

  function drawCharAt(ctx, sx, sy, dir, moving, vehicle, name) {
    if (vehicle) drawVehicle(ctx, sx, sy, vehicle, (catInfo(vehicle) || {}).color || "#888");
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(sx + 8, sy + 14, 6, 2, 0, 0, Math.PI * 2); ctx.fill();
    // SAME sprite as overworld
    if (window.getCharCanvas) {
      const frame = moving ? (1 + (Math.floor(B.frame / 5) % 2)) : 0;
      const bob = moving ? ((Math.floor(B.frame / 5) % 2) ? 0 : -1) : 0;
      let cv; try { cv = window.getCharCanvas("player", dir || "down", frame); } catch (e) { cv = null; }
      if (cv) ctx.drawImage(cv, Math.round(sx), Math.round(sy - 4 + bob));
    }
    if (name) { ctx.font = "5px 'Press Start 2P',monospace"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(sx + 8 - name.length * 3 - 2, sy - 14, name.length * 6 + 4, 8); ctx.fillStyle = "#FFD700"; ctx.fillText(name.slice(0, 10), sx + 8, sy - 8); ctx.textAlign = "start"; }
  }
  function drawObject(ctx, o, sx, sy) {
    const c = catInfo(o.type); const col = c ? c.color : "#888";
    if (o.type === "land") { ctx.fillStyle = "rgba(202,161,90,0.55)"; ctx.fillRect(sx, sy, BT, BT); ctx.strokeStyle = "#a07b34"; ctx.strokeRect(sx + 0.5, sy + 0.5, BT - 1, BT - 1); return; }
    if (o.type === "flower") { ctx.fillStyle = col; ctx.fillRect(sx + 3, sy + 3, 4, 4); ctx.fillRect(sx + 9, sy + 9, 4, 4); ctx.fillStyle = "#fff200"; ctx.fillRect(sx + 4, sy + 4, 1, 1); ctx.fillRect(sx + 10, sy + 10, 1, 1); return; }
    if (o.type === "fence") { ctx.fillStyle = col; ctx.fillRect(sx + 1, sy + 6, BT - 2, 3); ctx.fillRect(sx + 3, sy + 3, 2, 10); ctx.fillRect(sx + BT - 5, sy + 3, 2, 10); return; }
    if (o.type === "tree") { if (window.drawTile && window.T) window.drawTile(ctx, window.T.TREE, sx, sy, o.x, o.y, B.frame); return; }
    if (VEHICLES[o.type]) { drawVehicle(ctx, sx, sy, o.type, col); return; }
    drawBuilding(ctx, sx, sy, o.type, col);
    if (o.ownerName) { ctx.font = "5px 'Press Start 2P',monospace"; ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.textAlign = "center"; ctx.fillText(o.ownerName.slice(0, 8), sx + BT / 2, sy - 2); ctx.textAlign = "start"; }
  }
  function drawBuilding(ctx, sx, sy, type, col) {
    const fp = FOOTPRINT[type] || { w: 1, h: 1 };
    const w = fp.w * BT, h = fp.h * BT;
    if (type === "pool") {
      ctx.fillStyle = "#cdb877"; ctx.fillRect(sx, sy, w, h);
      ctx.fillStyle = "#39b6e0"; ctx.fillRect(sx + 3, sy + 3, w - 6, h - 6);
      ctx.strokeStyle = "#fff"; ctx.strokeRect(sx + 3.5, sy + 3.5, w - 7, h - 7);
      return;
    }
    // body
    const roofH = Math.floor(h * 0.34);
    ctx.fillStyle = col; ctx.fillRect(sx, sy + roofH, w, h - roofH);
    // roof
    ctx.fillStyle = "#7a2d1c"; ctx.beginPath();
    ctx.moveTo(sx - 2, sy + roofH); ctx.lineTo(sx + w / 2, sy); ctx.lineTo(sx + w + 2, sy + roofH); ctx.closePath(); ctx.fill();
    // windows
    ctx.fillStyle = "#bfe3ff";
    for (let i = 0; i < fp.w; i++) ctx.fillRect(sx + 4 + i * BT, sy + roofH + 4, 6, 6);
    // DOOR at bottom-center tile (the entrance), with a glowing frame
    const doorX = sx + Math.floor(fp.w / 2) * BT;
    const doorY = sy + h - BT;
    ctx.fillStyle = "#3a2a18"; ctx.fillRect(doorX + BT / 2 - 4, doorY + BT - 11, 8, 11);
    ctx.fillStyle = "#FFD700"; ctx.fillRect(doorX + BT / 2 - 5, doorY + BT - 12, 1, 12); ctx.fillRect(doorX + BT / 2 + 4, doorY + BT - 12, 1, 12);
    ctx.fillStyle = "#ffe066"; ctx.fillRect(doorX + BT / 2 + 1, doorY + BT - 6, 1, 2); // doorknob
  }
  function drawVehicle(ctx, sx, sy, type, col) {
    if (type === "bike") { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx + 5, sy + BT - 4, 3, 0, 7); ctx.arc(sx + BT - 5, sy + BT - 4, 3, 0, 7); ctx.stroke(); return; }
    ctx.fillStyle = col; ctx.fillRect(sx + 2, sy + 6, BT - 4, BT - 10);
    ctx.fillStyle = "#bfe3ff"; ctx.fillRect(sx + 4, sy + 7, BT - 8, 3);
    ctx.fillStyle = "#222"; ctx.fillRect(sx + 3, sy + BT - 5, 3, 3); ctx.fillRect(sx + BT - 6, sy + BT - 5, 3, 3);
  }

  /* ---------- network ---------- */
  function builderHandle(msg) {
    switch (msg.type) {
      case "builder_init":
        B.me = msg.you; B.objects.clear(); (msg.objects || []).forEach((o) => B.objects.set(o.id, o));
        B.peers.clear(); (msg.peers || []).forEach((p) => B.peers.set(p.id, mkPeer(p))); return true;
      case "builder_peer_join":
        if (msg.id !== B.me) B.peers.set(msg.id, mkPeer({ id: msg.id, name: msg.name, x: 0, y: 0, dir: "down" })); return true;
      case "builder_peer_left": B.peers.delete(msg.id); return true;
      case "builder_peer_pos": {
        if (msg.id === B.me) return true;
        let p = B.peers.get(msg.id); if (!p) { p = mkPeer(msg); B.peers.set(msg.id, p); }
        p.name = msg.name || p.name; p.dir = msg.dir; p.moving = msg.moving; p.vehicle = msg.vehicle;
        p.fx = p.px / BT; p.fy = p.py / BT; p.tx = msg.x; p.ty = msg.y; p.t = 0; return true;
      }
      case "builder_placed": B.objects.set(msg.obj.id, msg.obj); if (msg.obj.owner === B.me) { B._pendingCost = 0; bToast(catInfo(msg.obj.type).name + " placed!"); } return true;
      case "builder_removed": B.objects.delete(msg.id); return true;
      case "builder_error": if (B._pendingCost) { bWalletSet(bWallet() + B._pendingCost); B._pendingCost = 0; refreshBWallet(); } bToast(msg.message || "Build error"); return true;
      case "builder_chat": bToast((msg.name || "?") + ": " + msg.text); return true;
    }
    return false;
  }
  function mkPeer(p) {
    return { name: p.name || "Builder", dir: p.dir || "down", moving: !!p.moving, vehicle: p.vehicle || null,
      x: p.x || 0, y: p.y || 0, px: (p.x || 0) * BT, py: (p.y || 0) * BT, tx: p.x || 0, ty: p.y || 0, fx: p.x || 0, fy: p.y || 0, t: 1 };
  }

  // Called by the endBattle hook when a builder wild battle finishes.
  function builderReturnFromBattle() {
    B.inBattle = false;
    refreshBWallet(); // winnings were banked by the game's endBattle -> bankWardrobeMoney
    // hide the journey world UI the battle switched to, re-show builder
    ["world-screen", "battle-screen", "result-screen"].forEach((s) => { const el = document.getElementById(s); if (el) el.style.display = "none"; });
    const ov = document.getElementById("mp-builder"); if (ov) ov.classList.add("show");
    if (window.G) window.G.worldPaused = false;
  }

  MP.openBuilder = openBuilder;
  MP.closeBuilder = closeBuilder;
  MP._builderHandle = builderHandle;
  MP._builderReturnFromBattle = builderReturnFromBattle;
  MP._inBuilderBattle = () => B.on && B.inBattle;

  function init() {
    injectStyles();
    injectTouchStyles();
    injectDOM();
    injectTouchDOM();
    injectTitleButton();
    wire();
    wireTouch();
    wireTradeModal();
    maybeShowTouch();
    requestAnimationFrame(syncLoop);
    // try to hook render early (and keep trying until renderWorld exists)
    const h = setInterval(() => { if (hookRender()) clearInterval(h); }, 200);
    // hook endBattle so builder wild battles return to the builder world
    const h2 = setInterval(() => { if (hookEndBattle()) clearInterval(h2); }, 200);
  }

  // Wrap the game's endBattle: if it was a builder wild battle, return to builder.
  function hookEndBattle() {
    if (typeof window.endBattle !== "function") return false;
    if (window.__mpEndBattleHooked) return true;
    const orig = window.endBattle;
    window.endBattle = function () {
      const wasBuilder = window.G && window.G._builderBattle;
      const r = orig.apply(this, arguments);
      if (wasBuilder) {
        window.G._builderBattle = false;
        try { if (MP._builderReturnFromBattle) setTimeout(MP._builderReturnFromBattle, 50); } catch (e) {}
      }
      return r;
    };
    window.__mpEndBattleHooked = true;
    return true;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
