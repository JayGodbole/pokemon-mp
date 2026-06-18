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
      // builder-mode talk buttons use data-bact
      if (e.target.closest("[data-bact]")) { builderTalkClickHandler(e); return; }
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
    rot: 0,                 // current rotation for the part being placed (0-3)
    lastSent: 0, lastSig: "",
    frame: 0,
    stepsSinceBattle: 0,
    profileName: null,      // server profile (name+PIN)
    hasCutter: false,       // bought the grass/tree cutter
    cleared: new Set(),     // "x,y" tiles that have been cut/built-on (no grass, no encounters, no blockage)
    deleteMode: false,      // delete-on-click toggle
    talkTo: null,           // {id,p} player we're trading with
    incomingTrade: null,    // a received builder trade offer awaiting accept/decline
  };
  const BT = 16;                 // SAME tile size as the overworld
  const BVIEW_W = 240, BVIEW_H = 160; // SAME internal view as the overworld (CSS upscales)

  // ARK-style modular parts (cat) + whole structures. All 1x1 parts are rotatable.
  const BUILD_CATALOG = [
    // --- terrain / base ---
    { key: "foundation", name: "Foundation", price: 120, color: "#7d6b55", cat: "Base" },
    { key: "floor_wood", name: "Wood Floor", price: 60,  color: "#caa46a", cat: "Base" },
    { key: "floor_stone",name: "Stone Floor",price: 90,  color: "#9aa0a6", cat: "Base" },
    { key: "land",       name: "Land/Farm",  price: 200, color: "#a9763e", cat: "Base" },
    // --- walls ---
    { key: "wall_wood",  name: "Wood Wall",  price: 100, color: "#b07a3c", cat: "Walls", rotatable: true },
    { key: "wall_stone", name: "Stone Wall", price: 160, color: "#8b9097", cat: "Walls", rotatable: true },
    { key: "doorway",    name: "Doorway",    price: 140, color: "#b07a3c", cat: "Walls", rotatable: true },
    { key: "window",     name: "Window Wall",price: 130, color: "#b07a3c", cat: "Walls", rotatable: true },
    { key: "gate",       name: "Gate",       price: 180, color: "#9c6b34", cat: "Walls", rotatable: true },
    { key: "pillar",     name: "Pillar",     price: 70,  color: "#9aa0a6", cat: "Walls" },
    // --- roof / vertical ---
    { key: "roof",       name: "Roof",       price: 110, color: "#b5532f", cat: "Roof", rotatable: true },
    { key: "stairs",     name: "Stairs",     price: 120, color: "#a98c5a", cat: "Roof", rotatable: true },
    // --- utility / decor ---
    { key: "storage",    name: "Storage Box",price: 150, color: "#8a5a2a", cat: "Utility" },
    { key: "campfire",   name: "Campfire",   price: 90,  color: "#ff7a1a", cat: "Utility" },
    { key: "fence",      name: "Fence",      price: 60,  color: "#caa46a", cat: "Decor", rotatable: true },
    { key: "lamp",       name: "Lamp Post",  price: 250, color: "#cfd4da", cat: "Decor" },
    { key: "flower",     name: "Flowerbed",  price: 80,  color: "#e573a0", cat: "Decor" },
    { key: "tree",       name: "Tree",       price: 100, color: "#2e7d32", cat: "Decor" },
    { key: "sign",       name: "Sign",       price: 50,  color: "#caa46a", cat: "Decor", rotatable: true },
    // (prefab whole structures removed — build piece-by-piece from parts instead)
    // --- vehicles ---
    { key: "car",        name: "Car",        price: 8000, color: "#d83838", cat: "Vehicle" },
    { key: "bike",       name: "Bike",       price: 1500, color: "#2f6cc4", cat: "Vehicle" },
    { key: "boat",       name: "Boat",       price: 10000,color: "#8d6e63", cat: "Vehicle" },
  ];
  const catInfo = (k) => BUILD_CATALOG.find((c) => c.key === k);
  const VEHICLES = { car: 0.30, bike: 0.24, boat: 0.28 };
  // Building footprints (w x h in tiles). Buildings are large & enterable.
  const FOOTPRINT = { house: { w: 3, h: 3 }, shop: { w: 3, h: 3 }, pool: { w: 3, h: 2 }, mansion: { w: 4, h: 4 } };
  const ENTERABLE = { house: 1, mansion: 1, shop: 1 };
  // Solid (can't walk through). Walls/pillars/etc. block; floors/roofs/decor-on-ground don't.
  const SOLID = {
    tree: 1, house: 1, mansion: 1, shop: 1, pool: 1, fence: 1, lamp: 1,
    wall_wood: 1, wall_stone: 1, window: 1, pillar: 1, storage: 1, sign: 1,
  };
  // doorway & gate are walkable (you pass through). foundation/floors/roof/land/flower/campfire/stairs walkable.

  function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  const tkey = (x, y) => x + "," + y;
  function isCleared(x, y) { return B.cleared.has(tkey(x, y)); }
  function isWildTree(x, y) { if (isCleared(x, y)) return false; return hash2(x, y) < 0.035; }   // sparser trees -> easy to walk around
  function isTallGrass(x, y) { if (isCleared(x, y)) return false; return !isWildTree(x, y) && hash2(x + 5000, y + 5000) < 0.4; }
  // Mark a tile cleared (cut or built on) — removes grass/tree, stops encounters & blockage.
  function clearTile(x, y, broadcast) {
    const key = tkey(x, y);
    if (B.cleared.has(key)) return;
    B.cleared.add(key);
    if (broadcast) sendMsg("builder_clear", { x, y });
  }

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
      #bld-hud-left{display:flex;flex-direction:column;gap:6px;pointer-events:auto;}
      #bld-wallet{background:rgba(15,24,48,.9);color:#7CFC9A;border:2px solid #FFD700;border-radius:8px;padding:8px 12px;font-size:9px;}
      #bld-coords{background:rgba(15,24,48,.9);color:#9fd6ff;border:2px solid #4fc3f7;border-radius:8px;padding:6px 10px;font-size:8px;}
      #bld-top-right{display:flex;gap:6px;pointer-events:auto;flex-wrap:wrap;justify-content:flex-end;max-width:60vw;}
      .bld-btn{background:#FFD700;color:#111;border:none;border-radius:8px;padding:8px 11px;font-size:8px;font-family:'Press Start 2P',monospace;cursor:pointer;box-shadow:0 3px 0 #b8860b;}
      .bld-btn.red{background:#8B0000;color:#fff;box-shadow:0 3px 0 #5a0000;}
      .bld-btn.blue{background:#4fc3f7;color:#062a3a;box-shadow:0 3px 0 #0277bd;}
      .bld-btn.green{background:#4CAF50;color:#fff;box-shadow:0 3px 0 #2e7d32;}
      .bld-btn.active-del{background:#e0556a;color:#fff;box-shadow:0 3px 0 #8b0000;outline:2px solid #fff;}
      #bld-palette{position:fixed;left:10px;bottom:10px;right:10px;display:none;flex-wrap:wrap;gap:6px;background:rgba(15,24,48,.92);border:2px solid #FFD700;border-radius:10px;padding:8px;max-height:38vh;overflow:auto;z-index:10081;}
      .bld-cat-label{flex-basis:100%;color:#FFD700;font-size:7px;margin:4px 0 0;opacity:.85;}
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
      /* login overlay */
      #bld-login{position:fixed;inset:0;z-index:10096;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:16px;font-family:'Press Start 2P',monospace;}
      #bld-login.show{display:flex;}
      #bld-login-box{background:#16213e;border:3px solid #43a047;border-radius:12px;width:340px;max-width:94vw;padding:18px;color:#fff;display:flex;flex-direction:column;gap:10px;}
      #bld-login-title{color:#8bc34a;font-size:12px;text-align:center;}
      #bld-login input{padding:11px;border-radius:8px;border:2px solid #0f3460;background:#0f1830;color:#fff;font-family:'Press Start 2P',monospace;font-size:11px;text-align:center;outline:none;}
      #bld-login-err{color:#ff7b7b;font-size:7px;text-align:center;min-height:10px;line-height:1.5;}
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
        <div id="bld-hud-left">
          <div id="bld-wallet">$0</div>
          <div id="bld-coords">X:0  Y:0</div>
        </div>
        <div id="bld-top-right">
          <button class="bld-btn" id="bld-build">🏗️ BUILD</button>
          <button class="bld-btn" id="bld-delete">🗑 DELETE</button>
          <button class="bld-btn" id="bld-rotbtn"><span id="bld-rot">↻ 0°</span></button>
          <button class="bld-btn" id="bld-cutter">🪓 BUY CUTTER</button>
          <button class="bld-btn blue" id="bld-ride">🚗 RIDE</button>
          <button class="bld-btn green" id="bld-save">💾 SAVE</button>
          <button class="bld-btn red" id="bld-exit">✕ EXIT</button>
        </div>
      </div>
      <div id="bld-palette"></div>
      <div id="bld-hint">WASD move · B = build menu · SPACE = cut grass\/trees \WASD move · BUILD to place parts · R rotate · X remove · E ride · build walls/floors/roofs ARK-style interact · R rotate · X remove · E ride</div>
      <!-- on-screen controls for phones -->
      <div id="bld-touch">
        <div id="bld-dpad">
          <div class="bld-d" data-d="up">▲</div>
          <div class="bld-d" data-d="left">◀</div>
          <div class="bld-d" data-d="right">▶</div>
          <div class="bld-d" data-d="down">▼</div>
        </div>
        <div id="bld-actions">
          <div class="bld-a" data-a="act">ACT</div>
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
    // group palette by category (ARK-style parts menu)
    const cats = [];
    BUILD_CATALOG.forEach((c) => { if (!cats.includes(c.cat || "Other")) cats.push(c.cat || "Other"); });
    cats.forEach((cat) => {
      const lab = document.createElement("div"); lab.className = "bld-cat-label"; lab.textContent = cat; pal.appendChild(lab);
      BUILD_CATALOG.filter((c) => (c.cat || "Other") === cat).forEach((c) => {
        const el = document.createElement("div");
        el.className = "bld-item"; el.dataset.key = c.key;
        el.innerHTML = `${c.name}<span class="p">$${c.price}</span>`;
        el.onclick = () => { B.placeMode = c.key; if (B.deleteMode) toggleDeleteMode(); updatePaletteActive(); bToast((c.rotatable ? "R to rotate · " : "") + "Tap a tile to place " + c.name); };
        pal.appendChild(el);
      });
    });
    document.getElementById("bld-build").onclick = () => {
      pal.classList.toggle("show");
      if (!pal.classList.contains("show")) { B.placeMode = null; updatePaletteActive(); }
    };
    document.getElementById("bld-rotbtn").onclick = () => { B.rot = (B.rot + 1) % 4; updateRotLabel(); bToast("Rotation: " + (B.rot * 90) + "°"); };
    document.getElementById("bld-delete").onclick = toggleDeleteMode;
    document.getElementById("bld-cutter").onclick = buyCutter;
    document.getElementById("bld-ride").onclick = toggleRide;
    document.getElementById("bld-save").onclick = saveBuilderProgress;
    document.getElementById("bld-exit").onclick = closeBuilder;
    B.canvas.addEventListener("click", onBuilderClick);
    window.addEventListener("keydown", builderKeyDown);
    window.addEventListener("keyup", builderKeyUp);
    // Save progress to the server when the tab closes / computer shuts down.
    const flushOnLeave = () => { if (B.on) { try { saveBuilderProgress(true); } catch (e) {} } };
    window.addEventListener("beforeunload", flushOnLeave);
    window.addEventListener("pagehide", flushOnLeave);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnLeave(); });
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
    showBuilderLogin();
  }
  // Name + PIN login so each player's progress is saved on the server.
  function showBuilderLogin() {
    let lg = document.getElementById("bld-login");
    if (!lg) {
      lg = document.createElement("div"); lg.id = "bld-login";
      lg.innerHTML = `<div id="bld-login-box">
        <div id="bld-login-title">ENTER BUILDER WORLD</div>
        <div class="bld-int-row">Your progress (money, items, location & builds) is saved on the server under your name + PIN.</div>
        <input id="bld-name" maxlength="16" placeholder="NAME" autocomplete="off">
        <input id="bld-pin" maxlength="8" placeholder="PIN (e.g. 1234)" inputmode="numeric" autocomplete="off">
        <button class="bld-tbtn green" id="bld-login-go">ENTER WORLD</button>
        <button class="bld-tbtn red" id="bld-login-cancel">CANCEL</button>
        <div id="bld-login-err"></div>
      </div>`;
      document.body.appendChild(lg);
      document.getElementById("bld-login-cancel").onclick = () => { lg.classList.remove("show"); };
      document.getElementById("bld-login-go").onclick = () => {
        const name = (document.getElementById("bld-name").value || "").trim().slice(0, 16);
        const pin = (document.getElementById("bld-pin").value || "").trim().slice(0, 8);
        if (name.length < 2) { document.getElementById("bld-login-err").textContent = "Name must be 2+ characters."; return; }
        if (pin.length < 3) { document.getElementById("bld-login-err").textContent = "PIN must be 3+ characters."; return; }
        B._loginCreds = { name, pin };
        MP.name = name;
        try { localStorage.setItem("pokemon_dino_builder_name", name); localStorage.setItem("pokemon_dino_builder_pin", pin); } catch (e) {}
        lg.classList.remove("show");
        if (!MP.connected) connect().then(doOpenBuilder).catch(() => bToast("Can't reach server."));
        else doOpenBuilder();
      };
    }
    // prefill last used
    try {
      document.getElementById("bld-name").value = localStorage.getItem("pokemon_dino_builder_name") || "";
      document.getElementById("bld-pin").value = localStorage.getItem("pokemon_dino_builder_pin") || "";
    } catch (e) {}
    document.getElementById("bld-login-err").textContent = "";
    lg.classList.add("show");
  }
  function doOpenBuilder() {
    B.on = true; B.inBattle = false;
    B.player = { x: 0, y: 0, px: 0, py: 0, dir: "down", moving: false, vehicle: null, tx: 0, ty: 0, t: 1, fx: 0, fy: 0 };
    if (window.G) { window.G.mode = "adventure"; window.G.worldPaused = false; }
    ensureBuilderParty();
    document.getElementById("mp-builder").classList.add("show");
    refreshBWallet();
    // restore cutter ownership
    try { B.hasCutter = localStorage.getItem("pokemon_dino_builder_cutter") === "1"; } catch (e) {}
    const cbtn = document.getElementById("bld-cutter"); if (cbtn) cbtn.textContent = B.hasCutter ? "🪓 CUTTER ✓" : "🪓 BUY CUTTER";
    const creds = B._loginCreds || { name: MP.name || "Builder", pin: "" };
    sendMsg("builder_join", { name: creds.name, pin: creds.pin });
    // autosave progress every 20s
    if (B._autoSave) clearInterval(B._autoSave);
    B._autoSave = setInterval(() => { if (B.on) saveBuilderProgress(true); }, 20000);
    if (!B.raf) builderLoop();
  }
  function closeBuilder() {
    if (!B.on) return;
    saveBuilderProgress(true);    // persist progress to server on exit
    B.on = false;
    if (B._autoSave) { clearInterval(B._autoSave); B._autoSave = null; }
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
    if (k === "b") { toggleBuildMenu(); e.preventDefault(); }          // B = open/close BUILD menu
    if (k === " " || k === "enter") { builderInteract(); e.preventDefault(); }  // SPACE = interact (cut / enter)
    if (k === "x") { removeNearbyOwn(); e.preventDefault(); }
    if (k === "e") { toggleRide(); e.preventDefault(); }
    if (k === "r") { B.rot = (B.rot + 1) % 4; bToast("Rotation: " + (B.rot * 90) + "°"); updateRotLabel(); e.preventDefault(); }
    if (k === "escape") { closeBuilder(); }
  }

  function toggleBuildMenu() {
    const pal = document.getElementById("bld-palette");
    pal.classList.toggle("show");
    if (!pal.classList.contains("show")) { B.placeMode = null; updatePaletteActive(); }
  }

  // SPACE interact: cut the grass/tree you're facing (if you own a cutter),
  // or enter a building door you're standing on.
  function builderInteract() {
    const gx = Math.round(B.player.x), gy = Math.round(B.player.y);
    // 1) talk to an adjacent player (trade money/items/pokemon)
    const peer = builderAdjacentPeer();
    if (peer) { openBuilderTalk(peer.id, peer.p); return; }
    // 2) enter building if on its door
    for (const o of B.objects.values()) {
      if (!ENTERABLE[o.type]) continue;
      const d = doorTile(o);
      if (gx === d.x && gy === d.y) { enterBuilding(o); return; }
    }
    // 3) otherwise try to cut the tile we're facing
    const dv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[B.player.dir] || [0, 1];
    const fx = gx + dv[0], fy = gy + dv[1];
    const targets = [[fx, fy], [gx, gy]]; // facing tile first, then current tile
    for (const [tx, ty] of targets) {
      if (isWildTree(tx, ty) || isTallGrass(tx, ty)) {
        if (!B.hasCutter) { bToast("You need a CUTTER! Tap 🪓 BUY CUTTER ($1500)."); return; }
        const wasTree = isWildTree(tx, ty);
        clearTile(tx, ty, true);
        bToast(wasTree ? "Tree cut down! 🌳→" : "Grass cleared! 🌿→");
        return;
      }
    }
    bToast("Nothing to cut here. Face grass or a tree.");
  }

  function buyCutter() {
    if (B.hasCutter) { bToast("You already own a cutter."); return; }
    const price = 1500;
    if (bWallet() < price) { bToast("Cutter costs $1500 — battle to earn more."); return; }
    bWalletSet(bWallet() - price); refreshBWallet();
    B.hasCutter = true;
    try { localStorage.setItem("pokemon_dino_builder_cutter", "1"); } catch (e) {}
    const btn = document.getElementById("bld-cutter"); if (btn) btn.textContent = "🪓 CUTTER ✓";
    bToast("Cutter bought! Face grass/trees and press SPACE to cut.");
  }
  function updateRotLabel() { const el = document.getElementById("bld-rot"); if (el) el.textContent = "↻ " + (B.rot * 90) + "°"; }

  /* ---------- Builder player-to-player interactions (trade money/items) ---------- */
  function builderAdjacentPeer() {
    const px = Math.round(B.player.x), py = Math.round(B.player.y);
    const dv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[B.player.dir] || [0, 1];
    const cells = [[px + dv[0], py + dv[1]], [px, py - 1], [px, py + 1], [px - 1, py], [px + 1, py]];
    for (const [cx, cy] of cells) {
      for (const [id, p] of B.peers) {
        if (Math.round(p.x) === cx && Math.round(p.y) === cy) return { id, p };
      }
    }
    return null;
  }
  function openBuilderTalk(id, peer) {
    B.talkTo = { id, p: peer };
    openModal("Talk to " + esc(peer.name || "Builder"),
      '<button class="mp-tbtn" data-bact="money">💰 GIVE MONEY</button>' +
      '<button class="mp-tbtn" data-bact="item">🎒 GIVE AN ITEM</button>' +
      '<button class="mp-tbtn gray" data-bact="close">CANCEL</button>');
  }
  // reuse the trade modal element + helpers (openModal/closeModal) from the journey system
  function builderTalkClickHandler(e) {
    if (!B.on) return;
    const btn = e.target.closest("[data-bact]");
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const act = btn.dataset.bact;
    const t = B.talkTo; if (!t && act !== "close") return;
    if (act === "close") { closeModal(); return; }
    if (act === "money") {
      openModal("Give money to " + esc(t.p.name || "Builder"),
        '<div class="mp-tinfo">You have $' + bWallet() + '</div>' +
        '<input id="bld-money-amt" class="mp-tinput" type="number" min="1" inputmode="numeric" placeholder="0">' +
        '<button class="mp-tbtn green" data-bact="money-send">SEND OFFER</button>' +
        '<button class="mp-tbtn gray" data-bact="back">BACK</button>');
      setTimeout(() => { const i = document.getElementById("bld-money-amt"); if (i) i.focus(); }, 30);
      return;
    }
    if (act === "item") {
      const bag = (window.G && window.G.bag) || {};
      const defs = (window.ITEM_DEFS || []);
      const owned = defs.filter((d) => (bag[d.key] || 0) > 0);
      const rows = owned.length
        ? owned.map((d) => '<button class="mp-titem" data-bact="item-pick" data-key="' + d.key + '"><span>' + esc(d.name) + '</span><span class="q">x' + bag[d.key] + '</span></button>').join("")
        : '<div class="mp-tinfo">No items to give.</div>';
      openModal("Give an item to " + esc(t.p.name || "Builder"), '<div class="mp-tlist">' + rows + '</div><button class="mp-tbtn gray" data-bact="back">BACK</button>');
      return;
    }
    if (act === "back") { openBuilderTalk(t.id, t.p); return; }
    if (act === "money-send") {
      const el = document.getElementById("bld-money-amt");
      const amt = Math.floor(Number(el ? el.value : 0) || 0);
      if (amt <= 0) return bToast("Enter a valid amount.");
      if (amt > bWallet()) return bToast("You don't have that much.");
      sendMsg("builder_trade", { target: t.id, kind: "money", payload: { amount: amt } });
      closeModal(); bToast("Offered $" + amt + " to " + (t.p.name || "player") + "…");
      return;
    }
    if (act === "item-pick") {
      const key = btn.dataset.key; const def = (window.ITEM_DEFS || []).find((d) => d.key === key);
      sendMsg("builder_trade", { target: t.id, kind: "item", payload: { key: key, name: def ? def.name : key } });
      closeModal(); bToast("Offered " + (def ? def.name : key) + "…");
      return;
    }
    if (act === "offer-accept") {
      const m = B.incomingTrade; B.incomingTrade = null;
      if (!m) { closeModal(); return; }
      if (m.kind === "money") { bWalletSet(bWallet() + Math.floor(m.payload.amount || 0)); refreshBWallet(); }
      else if (m.kind === "item") { window.G.bag = window.G.bag || {}; window.G.bag[m.payload.key] = (window.G.bag[m.payload.key] || 0) + 1; }
      sendMsg("builder_trade_confirm", { target: m.from, kind: m.kind, payload: m.payload });
      const what = m.kind === "money" ? ("$" + m.payload.amount) : (m.payload.name || m.payload.key);
      bToast("Received " + what + " from " + m.fromName + "!"); closeModal();
      return;
    }
    if (act === "offer-decline") {
      const m = B.incomingTrade; B.incomingTrade = null;
      if (m) sendMsg("builder_trade_cancel", { target: m.from });
      closeModal(); return;
    }
  }
  function showBuilderTradeOffer(msg) {
    B.incomingTrade = msg;
    const what = msg.kind === "money" ? ("$" + msg.payload.amount) : esc(msg.payload.name || msg.payload.key);
    openModal(esc(msg.fromName) + " wants to give you<br>" + what,
      '<button class="mp-tbtn green" data-bact="offer-accept">ACCEPT</button>' +
      '<button class="mp-tbtn red" data-bact="offer-decline">DECLINE</button>');
  }
  function finalizeBuilderGive(msg) {
    // giver deducts after recipient accepted
    if (msg.kind === "money") { bWalletSet(Math.max(0, bWallet() - Math.floor(msg.payload.amount || 0))); refreshBWallet(); bToast("Gave $" + msg.payload.amount + " to " + msg.fromName); }
    else if (msg.kind === "item") { if (window.G && window.G.bag && window.G.bag[msg.payload.key]) window.G.bag[msg.payload.key] = Math.max(0, window.G.bag[msg.payload.key] - 1); bToast("Gave " + (msg.payload.name || msg.payload.key) + " to " + msg.fromName); }
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
        if (el.dataset.a === "act") builderInteract();
        else if (el.dataset.a === "x") removeNearbyOwn();
        else if (el.dataset.a === "e") toggleRide();
      });
    });
  }
  function onBuilderClick(e) {
    if (!B.on || B.inBattle) return;
    const rect = B.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (BVIEW_W / rect.width);
    const cy = (e.clientY - rect.top) * (BVIEW_H / rect.height);
    const wx = Math.floor((cx + B.cam.x) / BT);
    const wy = Math.floor((cy + B.cam.y) / BT);
    if (B.deleteMode) { deleteTopAt(wx, wy); return; }
    if (B.placeMode) placeAt(wx, wy, B.placeMode);
  }

  // Delete the TOP-MOST (most-recently-placed = highest id) object on/over a tile.
  function deleteTopAt(x, y) {
    let top = null;
    for (const o of B.objects.values()) {
      const hit = FOOTPRINT[o.type] ? inFootprint(o, x, y) : (o.x === x && o.y === y);
      if (!hit) continue;
      if (o.owner !== B.me) continue;                 // only your own builds
      if (!top || o.id > top.id) top = o;             // highest id = placed last = on top
    }
    if (!top) { bToast("Nothing of yours to delete here."); return; }
    sendMsg("builder_remove", { id: top.id });
    // refund part of the cost
    const c = catInfo(top.type);
    if (c) { bWalletSet(bWallet() + Math.floor(c.price * 0.5)); refreshBWallet(); }
    bToast("Deleted " + (c ? c.name : top.type) + " (50% refund)");
  }

  function toggleDeleteMode() {
    B.deleteMode = !B.deleteMode;
    if (B.deleteMode) { B.placeMode = null; updatePaletteActive(); const pal = document.getElementById("bld-palette"); if (pal) pal.classList.remove("show"); }
    const btn = document.getElementById("bld-delete");
    if (btn) { btn.classList.toggle("active-del", B.deleteMode); btn.textContent = B.deleteMode ? "🗑 DELETE: ON" : "🗑 DELETE"; }
    bToast(B.deleteMode ? "Delete mode ON — click a block to remove it." : "Delete mode off.");
  }
  function placeAt(x, y, key) {
    const c = catInfo(key); if (!c) return;
    if (bWallet() < c.price) { bToast("Not enough money! Battle wild Pokemon to earn $."); return; }
    const fp = FOOTPRINT[key];
    if (fp) {
      // big prefab: whole footprint must be clear of trees & other prefabs/walls
      for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) {
        const tx = x + dx, ty = y + dy;
        if (isWildTree(tx, ty)) { bToast("Can't build on a tree."); return; }
        for (const o of B.objects.values()) {
          if (FOOTPRINT[o.type]) { if (inFootprint(o, tx, ty)) { bToast("That spot is occupied."); return; } }
          else if (o.x === tx && o.y === ty && SOLID[o.type]) { bToast("That spot is occupied."); return; }
        }
      }
    } else {
      // ARK-style modular part: max 2 layers per tile; no exact duplicate part.
      if (isWildTree(x, y) && key !== "tree") { bToast("Can't build on a tree."); return; }
      let stackCount = 0;
      for (const o of B.objects.values()) {
        if (FOOTPRINT[o.type] && inFootprint(o, x, y)) { bToast("That spot is occupied by a building."); return; }
        if (o.x === x && o.y === y) {
          stackCount++;
          if (o.type === key && (o.rot || 0) === B.rot) { bToast("That part is already here."); return; }
        }
      }
      if (stackCount >= 2) { bToast("Only 2 items can be stacked on a tile."); return; }
    }
    bWalletSet(bWallet() - c.price); refreshBWallet();
    B._pendingCost = (B._pendingCost || 0) + c.price;
    // placing on grass auto-clears the tile(s): grass disappears, no encounters there
    if (fp) { for (let dy = 0; dy < fp.h; dy++) for (let dx = 0; dx < fp.w; dx++) clearTile(x + dx, y + dy, true); }
    else clearTile(x, y, true);
    sendMsg("builder_place", { objType: key, x, y, rot: (c.rotatable ? B.rot : 0) });
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
      // Turn in place first: if we're not already facing this way, just rotate
      // (lets you change facing while standing on the same block). A short grace
      // delay means a quick tap only turns; holding then walks.
      if (B.player.dir !== B.held) {
        B.player.dir = B.held;
        B._turnGrace = B.frame;
        return;
      }
      if (B._turnGrace != null && (B.frame - B._turnGrace) < 8) return; // ~8 frames to register a "turn-only" tap
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
      // live coordinates bar
      const co = document.getElementById("bld-coords");
      if (co) co.textContent = "X:" + Math.round(B.player.x) + "  Y:" + Math.round(B.player.y);
    }
    B.raf = requestAnimationFrame(builderLoop);
  }

  // Push wallet + inventory + position to the server profile (persisted per player).
  function saveBuilderProgress(silent) {
    sendMsg("builder_save_profile", { wallet: bWallet(), inventory: (window.G && window.G.bag) || {} });
    if (!silent) bToast("Progress saved to server!");
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
  // pixel helper
  function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

  function drawObject(ctx, o, sx, sy) {
    const c = catInfo(o.type); const col = c ? c.color : "#888";
    if (o.type === "land") {
      // tilled soil with furrows (like the crop patches in the reference)
      px(ctx, sx, sy, BT, BT, "#a9763e");
      ctx.fillStyle = "#8a5e2e"; for (let i = 2; i < BT; i += 4) ctx.fillRect(sx + i, sy + 1, 1, BT - 2);
      ctx.fillStyle = "#c08a4c"; for (let i = 0; i < BT; i += 4) ctx.fillRect(sx + i, sy + 1, 1, BT - 2);
      return;
    }
    if (o.type === "flower") { drawFlowerbed(ctx, sx, sy); return; }
    if (o.type === "lamp") { drawLamp(ctx, sx, sy); return; }
    if (o.type === "tree") { if (window.drawTile && window.T) window.drawTile(ctx, window.T.TREE, sx, sy, o.x, o.y, B.frame); return; }
    if (VEHICLES[o.type]) { drawVehicle(ctx, sx, sy, o.type, col); return; }
    // ---- ARK-style modular parts (rotatable) ----
    if (drawPart(ctx, o, sx, sy)) return;
    drawBuilding(ctx, sx, sy, o.type, col);
    if (o.ownerName) {
      ctx.font = "5px 'Press Start 2P',monospace"; ctx.textAlign = "center";
      const nm = o.ownerName.slice(0, 8); const w = nm.length * 6 + 4;
      const fp = FOOTPRINT[o.type] || { w: 1, h: 1 };
      px(ctx, sx + fp.w * BT / 2 - w / 2, sy - 9, w, 8, "rgba(0,0,0,.5)");
      ctx.fillStyle = "#ffe066"; ctx.fillText(nm, sx + fp.w * BT / 2, sy - 3); ctx.textAlign = "start";
    }
  }

  // ---- detailed flowerbed ----
  function drawFlowerbed(ctx, sx, sy) {
    px(ctx, sx + 1, sy + 1, BT - 2, BT - 2, "#3c7a35");          // bush base
    px(ctx, sx + 1, sy + 1, BT - 2, 2, "#4f9a45");               // highlight
    const cols = ["#ff5d6c", "#ffd23f", "#ff8fc7", "#7ad0ff"];
    const spots = [[3, 3], [9, 4], [5, 9], [11, 10], [7, 6]];
    spots.forEach((s, i) => {
      const cc = cols[i % cols.length];
      px(ctx, sx + s[0], sy + s[1], 3, 3, cc);
      px(ctx, sx + s[0] + 1, sy + s[1] + 1, 1, 1, "#fff7c0");    // pollen center
    });
  }
  // ---- wooden fence (posts + rails) ----
  function drawFence(ctx, sx, sy, horizontal) {
    if (horizontal === undefined) horizontal = true;
    if (horizontal) {
      px(ctx, sx, sy + 5, BT, 2, "#8a5a2a"); px(ctx, sx, sy + 4, BT, 1, "#caa46a");
      px(ctx, sx, sy + 10, BT, 2, "#8a5a2a"); px(ctx, sx, sy + 9, BT, 1, "#caa46a");
      [2, BT - 5].forEach((pxn) => { px(ctx, sx + pxn, sy + 2, 3, BT - 4, "#9c6b34"); px(ctx, sx + pxn, sy + 2, 1, BT - 4, "#caa46a"); px(ctx, sx + pxn, sy + 2, 3, 1, "#caa46a"); });
    } else {
      px(ctx, sx + 5, sy, 2, BT, "#8a5a2a"); px(ctx, sx + 4, sy, 1, BT, "#caa46a");
      px(ctx, sx + 10, sy, 2, BT, "#8a5a2a"); px(ctx, sx + 9, sy, 1, BT, "#caa46a");
      [2, BT - 5].forEach((pyn) => { px(ctx, sx + 2, sy + pyn, BT - 4, 3, "#9c6b34"); px(ctx, sx + 2, sy + pyn, BT - 4, 1, "#caa46a"); });
    }
  }
  // ---- lamp post (matches the reference's lamp) ----
  function drawLamp(ctx, sx, sy) {
    px(ctx, sx + BT / 2 - 1, sy + 4, 2, BT - 5, "#5a6470");       // pole
    px(ctx, sx + BT / 2 - 1, sy + 4, 1, BT - 5, "#828c98");       // pole highlight
    px(ctx, sx + BT / 2 - 3, sy + 1, 6, 4, "#3a4048");           // lamp housing
    px(ctx, sx + BT / 2 - 2, sy + 2, 4, 2, "#ffe98a");           // glowing glass
    px(ctx, sx + BT / 2 - 4, sy + BT - 2, 8, 2, "#444c56");       // base
  }

  // Draw an ARK-style modular part. Returns true if it handled the type.
  function drawPart(ctx, o, sx, sy) {
    const t = o.type, rot = o.rot || 0;
    const horizontal = (rot === 1 || rot === 3); // 90/270 = horizontal orientation
    switch (t) {
      case "foundation": {
        px(ctx, sx, sy, BT, BT, "#8a7660"); px(ctx, sx + 1, sy + 1, BT - 2, BT - 2, "#7d6b55");
        ctx.strokeStyle = "#5e5040"; ctx.strokeRect(sx + 1.5, sy + 1.5, BT - 3, BT - 3);
        px(ctx, sx + 2, sy + 2, 3, 3, "#9a8870"); return true;
      }
      case "floor_wood": {
        px(ctx, sx, sy, BT, BT, "#caa46a");
        ctx.fillStyle = "#a9824a"; for (let i = 0; i <= BT; i += 4) ctx.fillRect(sx, sy + i, BT, 1);
        ctx.fillStyle = "#e0c089"; ctx.fillRect(sx, sy + 1, BT, 1); return true;
      }
      case "floor_stone": {
        px(ctx, sx, sy, BT, BT, "#9aa0a6");
        ctx.fillStyle = "#7d848b"; ctx.fillRect(sx, sy + 8, BT, 1); ctx.fillRect(sx + 8, sy, 1, BT);
        ctx.fillStyle = "#b3b9bf"; ctx.fillRect(sx + 1, sy + 1, 6, 6); ctx.fillRect(sx + 9, sy + 9, 6, 6); return true;
      }
      case "fence": { drawFence(ctx, sx, sy, horizontal); return true; }
      case "pillar": {
        px(ctx, sx + 5, sy, 6, BT, "#9aa0a6"); px(ctx, sx + 5, sy, 2, BT, "#b8bec4");
        px(ctx, sx + 4, sy, 8, 2, "#7d848b"); px(ctx, sx + 4, sy + BT - 2, 8, 2, "#7d848b"); return true;
      }
      case "wall_wood": case "wall_stone": {
        const wood = (t === "wall_wood");
        // a wall slab oriented along the tile edge per rotation
        const base = wood ? "#b07a3c" : "#8b9097", lite = wood ? "#caa46a" : "#aab0b6", dark = wood ? "#8a5a2a" : "#6f757b";
        if (horizontal) {
          px(ctx, sx, sy + 5, BT, 6, base); px(ctx, sx, sy + 5, BT, 1, lite); px(ctx, sx, sy + 10, BT, 1, dark);
          if (wood) for (let i = 2; i < BT; i += 4) px(ctx, sx + i, sy + 5, 1, 6, dark);
        } else {
          px(ctx, sx + 5, sy, 6, BT, base); px(ctx, sx + 5, sy, 1, BT, lite); px(ctx, sx + 10, sy, 1, BT, dark);
          if (wood) for (let i = 2; i < BT; i += 4) px(ctx, sx + 5, sy + i, 6, 1, dark);
        }
        return true;
      }
      case "window": {
        const base = "#b07a3c", lite = "#caa46a";
        if (horizontal) { px(ctx, sx, sy + 5, BT, 6, base); px(ctx, sx + 4, sy + 6, 8, 4, "#bfe9ff"); px(ctx, sx + 7, sy + 6, 1, 4, base); }
        else { px(ctx, sx + 5, sy, 6, BT, base); px(ctx, sx + 6, sy + 4, 4, 8, "#bfe9ff"); px(ctx, sx + 6, sy + 7, 4, 1, base); }
        return true;
      }
      case "doorway": case "gate": {
        const base = (t === "gate") ? "#9c6b34" : "#b07a3c", lite = "#caa46a";
        // posts with an opening you can walk through
        if (horizontal) { px(ctx, sx, sy + 4, 3, 8, base); px(ctx, sx + BT - 3, sy + 4, 3, 8, base); px(ctx, sx, sy + 3, BT, 2, base); }
        else { px(ctx, sx + 3, sy, 3, BT, base); px(ctx, sx + BT - 6, sy, 3, BT, base); px(ctx, sx + 3, sy, BT - 6, 2, base); }
        px(ctx, sx + 3, sy, 1, 1, lite); return true;
      }
      case "roof": {
        // a sloped shingled roof panel
        px(ctx, sx, sy, BT, BT, "#b5532f");
        ctx.fillStyle = "#8f3d22"; for (let i = 2; i < BT; i += 3) ctx.fillRect(sx, sy + i, BT, 1);
        px(ctx, sx, sy, BT, 2, "#d27a4a"); return true;
      }
      case "stairs": {
        px(ctx, sx, sy, BT, BT, "#a98c5a");
        ctx.fillStyle = "#8a6e40";
        for (let i = 0; i < 4; i++) ctx.fillRect(sx + i * 4, sy + i * 4, BT - i * 4, 3);
        return true;
      }
      case "storage": {
        px(ctx, sx + 2, sy + 4, BT - 4, BT - 6, "#8a5a2a"); px(ctx, sx + 2, sy + 4, BT - 4, 2, "#a9743a");
        px(ctx, sx + 2, sy + 8, BT - 4, 1, "#5a3a18"); px(ctx, sx + BT / 2 - 1, sy + 6, 2, 2, "#FFD700"); return true;
      }
      case "campfire": {
        px(ctx, sx + 3, sy + BT - 5, BT - 6, 3, "#5a3a18"); // logs
        const f = (Math.floor(B.frame / 6) % 2);
        px(ctx, sx + 6, sy + 5 + f, 4, 6 - f, "#ff7a1a"); px(ctx, sx + 7, sy + 7, 2, 4, "#ffd23f"); return true;
      }
      case "sign": {
        px(ctx, sx + BT / 2 - 1, sy + 7, 2, BT - 7, "#7a4a28");
        px(ctx, sx + 3, sy + 2, BT - 6, 6, "#caa46a"); px(ctx, sx + 3, sy + 2, BT - 6, 1, "#e0c089");
        ctx.fillStyle = "#5a3a18"; ctx.fillRect(sx + 5, sy + 4, BT - 10, 1); ctx.fillRect(sx + 5, sy + 6, BT - 12, 1); return true;
      }
    }
    return false;
  }

  function drawBuilding(ctx, sx, sy, type, col) {
    const fp = FOOTPRINT[type] || { w: 1, h: 1 };
    const w = fp.w * BT, h = fp.h * BT;

    if (type === "pool") {
      // wooden deck + tiled pool + ladder (like the reference's pool)
      px(ctx, sx, sy, w, h, "#caa46a");
      px(ctx, sx + 1, sy + 1, w - 2, h - 2, "#b58a4e");
      px(ctx, sx + 3, sy + 3, w - 6, h - 6, "#1f93c7");          // deep water
      px(ctx, sx + 3, sy + 3, w - 6, 3, "#4fc3f7");              // top shimmer
      ctx.fillStyle = "#bfe9ff";
      for (let i = 0; i < (w - 8); i += 6) { ctx.fillRect(sx + 5 + i, sy + 8, 3, 1); ctx.fillRect(sx + 7 + i, sy + 13, 2, 1); }
      // ladder rails
      px(ctx, sx + w - 7, sy + 4, 1, h - 8, "#e8e8e8");
      px(ctx, sx + w - 4, sy + 4, 1, h - 8, "#e8e8e8");
      return;
    }

    // ===== Japanese-style house (matches reference) =====
    const shadow = "rgba(0,0,0,0.18)";
    px(ctx, sx + 3, sy + h - 3, w, 3, shadow);                   // ground shadow

    const wallTop = Math.floor(h * 0.46);
    // ---- walls (plaster) ----
    const wallCol = (type === "shop") ? "#efd79a" : (type === "mansion") ? "#e6dcc4" : "#f0e2c2";
    const wallShade = (type === "shop") ? "#d8bd78" : (type === "mansion") ? "#cdbf9f" : "#d8c79e";
    px(ctx, sx + 1, sy + wallTop, w - 2, h - wallTop, wallCol);
    px(ctx, sx + 1, sy + h - 4, w - 2, 4, wallShade);            // base shading
    // dark timber frame beams (Japanese look)
    ctx.fillStyle = "#6b4a2a";
    px(ctx, sx + 1, sy + wallTop, 2, h - wallTop, "#6b4a2a");    // left beam
    px(ctx, sx + w - 3, sy + wallTop, 2, h - wallTop, "#6b4a2a");// right beam
    for (let i = 1; i < fp.w; i++) px(ctx, sx + i * BT - 1, sy + wallTop, 2, h - wallTop, "#6b4a2a"); // vertical beams

    // ---- windows (warm lit shoji panels) ----
    const winY = sy + wallTop + 4;
    for (let i = 0; i < fp.w; i++) {
      if (i === Math.floor(fp.w / 2)) continue; // door column gets the door, not a window
      const wx = sx + 5 + i * BT;
      px(ctx, wx, winY, 8, 7, "#7a4a28");                        // frame
      px(ctx, wx + 1, winY + 1, 6, 5, "#ffe9a8");                // glow
      px(ctx, wx + 3, winY + 1, 1, 5, "#caa46a");               // mullion
      px(ctx, wx + 1, winY + 3, 6, 1, "#caa46a");
    }

    // ---- big hip roof (layered shingles, overhanging eaves) ----
    const eaveH = 3, peakH = Math.floor(wallTop * 0.62);
    // slim dark eave underside (overhang)
    px(ctx, sx - 2, sy + wallTop - eaveH, w + 4, eaveH, "#6e2e18");
    // roof slabs (tiers) — terracotta like the reference
    const roofMain = "#b5532f", roofDark = "#8f3d22", roofLight = "#d27a4a", ridge = "#6e2e18";
    // lower roof slab
    px(ctx, sx - 2, sy + peakH, w + 4, wallTop - peakH - eaveH + 2, roofMain);
    // upper triangular roof
    ctx.beginPath();
    ctx.moveTo(sx + 2, sy + peakH + 1);
    ctx.lineTo(sx + w / 2, sy + 1);
    ctx.lineTo(sx + w - 2, sy + peakH + 1);
    ctx.closePath(); ctx.fillStyle = roofMain; ctx.fill();
    // shading on right half of the triangle
    ctx.beginPath();
    ctx.moveTo(sx + w / 2, sy + 1);
    ctx.lineTo(sx + w - 2, sy + peakH + 1);
    ctx.lineTo(sx + w / 2, sy + peakH + 1);
    ctx.closePath(); ctx.fillStyle = roofDark; ctx.fill();
    // shingle rows
    ctx.fillStyle = roofDark;
    for (let ry = sy + peakH + 3; ry < sy + wallTop - eaveH; ry += 3) ctx.fillRect(sx - 2, ry, w + 4, 1);
    // ridge cap + highlight
    px(ctx, sx + w / 2 - 1, sy + 1, 2, peakH, ridge);
    ctx.fillStyle = roofLight;
    ctx.beginPath(); ctx.moveTo(sx + 3, sy + peakH); ctx.lineTo(sx + w / 2, sy + 2); ctx.lineTo(sx + w / 2 - 2, sy + peakH); ctx.closePath(); ctx.fill();

    // ---- DOOR at bottom-center tile (the entrance, sliding-door style) ----
    const doorTileX = sx + Math.floor(fp.w / 2) * BT;
    const doorY = sy + h - BT;
    const dx = doorTileX + BT / 2 - 5, dy = doorY + BT - 13;
    px(ctx, dx - 1, dy - 1, 12, 14, "#5a3b1f");                  // dark frame
    px(ctx, dx, dy, 10, 13, "#caa46a");                          // wood door
    px(ctx, dx + 4, dy, 2, 13, "#7a4a28");                       // split (sliding doors)
    px(ctx, dx + 1, dy + 1, 3, 4, "#ffe9a8");                    // little glass panes
    px(ctx, dx + 6, dy + 1, 3, 4, "#ffe9a8");
    px(ctx, dx + 3, dy + 7, 1, 2, "#3a2a18");                    // handle
    px(ctx, dx + 6, dy + 7, 1, 2, "#3a2a18");
    // shop awning / sign
    if (type === "shop") {
      px(ctx, sx + 2, sy + wallTop, w - 4, 3, "#c0392b");
      ctx.fillStyle = "#fff"; for (let i = 0; i < w - 6; i += 6) ctx.fillRect(sx + 4 + i, sy + wallTop, 3, 3);
    }
    // mansion: golden trim on the ridge
    if (type === "mansion") { px(ctx, sx + w / 2 - 2, sy + 2, 4, 2, "#FFD700"); }
  }

  function drawVehicle(ctx, sx, sy, type, col) {
    px(ctx, sx + 2, sy + BT - 3, BT - 4, 2, "rgba(0,0,0,0.2)");  // shadow
    if (type === "bike") {
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(sx + 5, sy + BT - 5, 3.2, 0, 7); ctx.arc(sx + BT - 5, sy + BT - 5, 3.2, 0, 7); ctx.stroke();
      ctx.strokeStyle = col; ctx.beginPath();
      ctx.moveTo(sx + 5, sy + BT - 5); ctx.lineTo(sx + BT / 2, sy + 6); ctx.lineTo(sx + BT - 5, sy + BT - 5); ctx.moveTo(sx + BT / 2, sy + 6); ctx.lineTo(sx + BT - 4, sy + 6); ctx.stroke();
      return;
    }
    if (type === "boat") {
      px(ctx, sx + 2, sy + 8, BT - 4, 5, "#8d6e63");            // hull
      px(ctx, sx + 1, sy + 11, BT - 2, 3, "#6d4f44");
      px(ctx, sx + BT / 2 - 1, sy + 2, 2, 7, "#e8e8e8");        // mast
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(sx + BT / 2 + 1, sy + 2); ctx.lineTo(sx + BT - 3, sy + 8); ctx.lineTo(sx + BT / 2 + 1, sy + 8); ctx.closePath(); ctx.fill();
      return;
    }
    // car — rounded body, windows, wheels
    px(ctx, sx + 2, sy + 5, BT - 4, BT - 9, col);
    px(ctx, sx + 2, sy + 5, BT - 4, 2, "#fff6"); // top sheen
    px(ctx, sx + 4, sy + 6, BT - 8, 3, "#bfe3ff"); // windshield
    px(ctx, sx + 3, sy + BT - 4, 3, 3, "#222"); px(ctx, sx + BT - 6, sy + BT - 4, 3, 3, "#222"); // wheels
    px(ctx, sx + 3, sy + 7, 1, 1, "#ffd23f"); px(ctx, sx + BT - 4, sy + 7, 1, 1, "#ffd23f"); // headlights
  }

  /* ---------- network ---------- */
  function builderHandle(msg) {
    switch (msg.type) {
      case "builder_init":
        B.me = msg.you; B.objects.clear(); (msg.objects || []).forEach((o) => B.objects.set(o.id, o));
        B.cleared = new Set(msg.cleared || []);   // restore cleared (cut/built) tiles
        B.peers.clear(); (msg.peers || []).forEach((p) => B.peers.set(p.id, mkPeer(p)));
        // apply this player's saved server profile (wallet/inventory/position)
        if (msg.profile) {
          B.profileName = msg.profile.name || null;
          if (typeof msg.profile.wallet === "number") { bWalletSet(msg.profile.wallet); refreshBWallet(); }
          if (msg.profile.inventory && window.G) window.G.bag = Object.assign({}, msg.profile.inventory);
          const pp = msg.profile.pos || { x: 0, y: 0 };
          const sx = pp.x | 0, sy = pp.y | 0;
          B.player = { x: sx, y: sy, px: sx * BT, py: sy * BT, dir: "down", moving: false, vehicle: null, tx: sx, ty: sy, t: 1, fx: sx, fy: sy };
          bToast("Welcome back, " + (B.profileName || "Builder") + "!");
        }
        return true;
      case "builder_denied":
        // wrong PIN — kick back to login
        B.on = false;
        if (B._autoSave) { clearInterval(B._autoSave); B._autoSave = null; }
        document.getElementById("mp-builder").classList.remove("show");
        showBuilderLogin();
        document.getElementById("bld-login-err").textContent = msg.message || "Access denied.";
        return true;
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
      case "builder_cleared": if (msg.key) B.cleared.add(msg.key); return true;
      case "builder_trade": showBuilderTradeOffer(msg); return true;          // someone offers me money/item
      case "builder_trade_confirm": finalizeBuilderGive(msg); return true;    // my offer was accepted -> deduct
      case "builder_trade_cancel": bToast((msg.fromName || "Player") + " declined."); return true;
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
