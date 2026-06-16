// Multiplayer Journey server for Pokemon Dino Edition
// - Lobby system: create/join rooms by code, ready-up, host starts the journey
// - In-journey: relays each player's overworld position to all peers (relay model)
// Express serves the game HTML from ./public ; ws handles realtime.

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import { Battle, sanitizeMon } from "./battle-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Friendly default: serve the game at "/"
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 8; // "more than 2" supported, capped for sanity

// rooms: code -> { code, hostId, started, players: Map<id, player>, battles: Map<battleId, Battle>, invites: Map }
// player: { id, ws, name, ready, partner, pos:{...}, lastSeen, battleId }
const rooms = new Map();
let nextId = 1;
let nextBattleId = 1;
const TURN_TIMEOUT_MS = 30000; // auto-pick if a player stalls a battle turn

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[(Math.random() * chars.length) | 0]).join("");
  } while (rooms.has(code));
  return code;
}

const clean = (s, n) => String(s == null ? "" : s).slice(0, n);

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify({ type, ...payload })); } catch { /* ignore */ }
  }
}

function broadcast(room, type, payload = {}, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, type, payload);
  }
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    partner: p.partner,
    isHost: false, // filled in by lobbyState
  };
}

function lobbyState(room) {
  const players = [...room.players.values()].map((p) => ({
    ...publicPlayer(p),
    isHost: p.id === room.hostId,
  }));
  return { code: room.code, hostId: room.hostId, started: room.started, players };
}

function pushLobby(room) {
  broadcast(room, "lobby", lobbyState(room));
}

function battlingIds(room) {
  // list of player ids currently in a battle (for overworld "in battle" markers)
  const ids = [];
  for (const p of room.players.values()) if (p.battleId) ids.push(p.id);
  return ids;
}
function pushBattleStatus(room) {
  broadcast(room, "battle_status", { battling: battlingIds(room) });
}
function endBattle(room, battleId, reason) {
  const b = room.battles.get(battleId);
  if (!b) return;
  if (b._timer) { clearTimeout(b._timer); b._timer = null; }
  room.battles.delete(battleId);
  for (const id of b.ids) {
    const p = room.players.get(id);
    if (p) p.battleId = null;
  }
  pushBattleStatus(room);
}
function maybeResolveTurn(room, battleId) {
  const b = room.battles.get(battleId);
  if (!b || b.over) return;
  if (!b.bothChosen()) return;
  if (b._timer) { clearTimeout(b._timer); b._timer = null; }
  const events = b.resolveTurn();
  for (const id of b.ids) {
    const p = room.players.get(id);
    send(p && p.ws, "battle_turn", { battleId, events, state: b.publicState() });
  }
  if (b.over) {
    for (const id of b.ids) {
      const p = room.players.get(id);
      send(p && p.ws, "battle_end", {
        battleId, winner: b.winner, youWon: id === b.winner,
      });
    }
    endBattle(room, battleId, "finished");
  } else {
    armTurnTimer(room, battleId);
  }
}
function armTurnTimer(room, battleId) {
  const b = room.battles.get(battleId);
  if (!b || b.over) return;
  if (b._timer) clearTimeout(b._timer);
  b._timer = setTimeout(() => {
    // auto-pick first usable move for anyone who didn't choose
    for (const id of b.ids) {
      if (!b.players[id].choice) {
        const m = b.mon(id);
        let idx = m.moves.findIndex((mv) => mv.currentPp > 0);
        if (idx < 0) b.setChoice(id, { type: "struggle" });
        else b.setChoice(id, { type: "move", index: idx });
      }
    }
    maybeResolveTurn(room, battleId);
  }, TURN_TIMEOUT_MS);
}

function removePlayer(room, id) {
  const wasHost = room.hostId === id;
  // if they were battling, award the win to the opponent and end the battle
  const leaver = room.players.get(id);
  if (leaver && leaver.battleId) {
    const b = room.battles.get(leaver.battleId);
    if (b && !b.over) {
      const opp = b.opponent(id);
      const op = room.players.get(opp);
      send(op && op.ws, "battle_end", { battleId: leaver.battleId, winner: opp, youWon: true, reason: "opponent_left" });
    }
    endBattle(room, leaver.battleId, "leaver");
  }
  room.players.delete(id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (wasHost) {
    // migrate host to the earliest-joined remaining player
    room.hostId = room.players.keys().next().value;
  }
  broadcast(room, "peer_left", { id });
  pushLobby(room);
  pushBattleStatus(room);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.playerId = nextId++;
  ws.roomCode = null;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg.type;

    // ---------- LOBBY ----------
    if (type === "create") {
      const code = genCode();
      const room = { code, hostId: ws.playerId, started: false, players: new Map(), battles: new Map(), invites: new Map() };
      rooms.set(code, room);
      const player = {
        id: ws.playerId, ws, name: clean(msg.name, 16) || "Trainer", ready: false,
        partner: clean(msg.partner, 24) || null,
        pos: { tileX: 0, tileY: 0, dir: "down", moving: false, area: "overworld" },
        lastSeen: Date.now(),
      };
      room.players.set(player.id, player);
      ws.roomCode = code;
      send(ws, "joined", { code, you: player.id, host: true });
      pushLobby(room);
      return;
    }

    if (type === "join") {
      const code = clean(msg.code, 4).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, "error", { message: "Room not found." });
      if (room.started) return send(ws, "error", { message: "Journey already started." });
      if (room.players.size >= MAX_PLAYERS) return send(ws, "error", { message: "Room is full." });
      const player = {
        id: ws.playerId, ws, name: clean(msg.name, 16) || "Trainer", ready: false,
        partner: clean(msg.partner, 24) || null,
        pos: { tileX: 0, tileY: 0, dir: "down", moving: false, area: "overworld" },
        lastSeen: Date.now(),
      };
      room.players.set(player.id, player);
      ws.roomCode = code;
      send(ws, "joined", { code, you: player.id, host: false });
      broadcast(room, "peer_joined", { player: { ...publicPlayer(player), isHost: false } }, player.id);
      pushLobby(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.get(ws.playerId);
    if (!me) return;
    me.lastSeen = Date.now();

    if (type === "ready") {
      me.ready = !!msg.ready;
      if (msg.partner != null) me.partner = clean(msg.partner, 24);
      pushLobby(room);
      return;
    }

    if (type === "set_partner") {
      me.partner = clean(msg.partner, 24);
      pushLobby(room);
      return;
    }

    if (type === "start") {
      if (ws.playerId !== room.hostId) return; // only host
      room.started = true;
      broadcast(room, "start", { code: room.code });
      return;
    }

    // ---------- IN-JOURNEY ----------
    if (type === "pos") {
      // update my position and relay to peers (only the delta payload)
      me.pos = {
        tileX: Number(msg.tileX) || 0,
        tileY: Number(msg.tileY) || 0,
        dir: ["up", "down", "left", "right"].includes(msg.dir) ? msg.dir : "down",
        moving: !!msg.moving,
        area: clean(msg.area, 24) || "overworld",
      };
      if (msg.name) me.name = clean(msg.name, 16);
      if (msg.partner) me.partner = clean(msg.partner, 24);
      broadcast(room, "peer_pos", {
        id: me.id, name: me.name, partner: me.partner, ...me.pos,
      }, me.id);
      return;
    }

    // ---------- PvP BATTLE ----------
    if (type === "battle_invite") {
      const targetId = Number(msg.target);
      const target = room.players.get(targetId);
      if (!target) return send(ws, "error", { message: "Player not found." });
      if (target.id === me.id) return;
      if (me.battleId) return send(ws, "error", { message: "You are already in a battle." });
      if (target.battleId) return send(ws, "error", { message: `${target.name} is already battling.` });
      // store the inviter's mon with the invite
      const inviteKey = me.id + "->" + target.id;
      room.invites.set(inviteKey, { from: me.id, to: target.id, mon: sanitizeMon(msg.mon), ts: Date.now() });
      send(target.ws, "battle_invited", { from: me.id, fromName: me.name });
      send(ws, "battle_invite_sent", { to: target.id, toName: target.name });
      return;
    }

    if (type === "battle_decline") {
      const fromId = Number(msg.from);
      room.invites.delete(fromId + "->" + me.id);
      const from = room.players.get(fromId);
      send(from && from.ws, "battle_declined", { by: me.id, byName: me.name });
      return;
    }

    if (type === "battle_accept") {
      const fromId = Number(msg.from);
      const inviteKey = fromId + "->" + me.id;
      const invite = room.invites.get(inviteKey);
      const from = room.players.get(fromId);
      if (!invite || !from) return send(ws, "error", { message: "Invite expired." });
      if (me.battleId || from.battleId) {
        room.invites.delete(inviteKey);
        return send(ws, "error", { message: "Someone is already in a battle." });
      }
      room.invites.delete(inviteKey);
      const bId = nextBattleId++;
      const p1Mon = invite.mon;                 // inviter's mon (already sanitized)
      const p2Mon = sanitizeMon(msg.mon);       // accepter's mon
      const battle = new Battle(from.id, p1Mon, me.id, p2Mon);
      room.battles.set(bId, battle);
      from.battleId = bId; me.battleId = bId;
      const intro = (forId) => ({
        battleId: bId,
        you: forId,
        opponent: forId === from.id ? me.id : from.id,
        opponentName: forId === from.id ? me.name : from.name,
        yourName: forId === from.id ? from.name : me.name,
        state: battle.publicState(),
      });
      send(from.ws, "battle_start", intro(from.id));
      send(me.ws, "battle_start", intro(me.id));
      pushBattleStatus(room);
      armTurnTimer(room, bId);
      return;
    }

    if (type === "battle_move") {
      if (!me.battleId) return;
      const b = room.battles.get(me.battleId);
      if (!b || b.over) return;
      const choice = (typeof msg.index === "number")
        ? { type: "move", index: Math.max(0, Math.min(3, msg.index | 0)) }
        : { type: "struggle" };
      // validate the move has PP; else struggle
      const m = b.mon(me.id);
      if (choice.type === "move" && (!m.moves[choice.index] || m.moves[choice.index].currentPp <= 0)) {
        const idx = m.moves.findIndex((mv) => mv.currentPp > 0);
        choice.type = idx < 0 ? "struggle" : "move";
        if (idx >= 0) choice.index = idx;
      }
      if (b.setChoice(me.id, choice)) {
        // tell both clients someone locked in (for "waiting…" UI)
        for (const id of b.ids) {
          const p = room.players.get(id);
          send(p && p.ws, "battle_waiting", { chosen: me.id });
        }
      }
      maybeResolveTurn(room, me.battleId);
      return;
    }

    if (type === "battle_flee") {
      if (!me.battleId) return;
      const b = room.battles.get(me.battleId);
      if (!b) return;
      const opp = b.opponent(me.id);
      const op = room.players.get(opp);
      send(op && op.ws, "battle_end", { battleId: me.battleId, winner: opp, youWon: true, reason: "opponent_fled" });
      send(ws, "battle_end", { battleId: me.battleId, winner: opp, youWon: false, reason: "you_fled" });
      endBattle(room, me.battleId, "flee");
      return;
    }

    // ---------- TRADING / GIVING (money, items, pokemon) ----------
    // Generic relay: forward an offer/confirm/cancel to a specific target player.
    // The server validates only that the target exists & is in the room; clients
    // apply the actual changes to their own game state on confirm.
    if (type === "trade_offer") {
      // msg: { target, kind:'money'|'item'|'pokemon', payload:{...} }
      const target = room.players.get(Number(msg.target));
      if (!target) return send(ws, "error", { message: "Player not found." });
      if (target.id === me.id) return;
      if (me.battleId || target.battleId) return send(ws, "error", { message: "Can't trade during a battle." });
      send(target.ws, "trade_offer", {
        from: me.id, fromName: me.name,
        kind: String(msg.kind || ""), payload: msg.payload || {},
      });
      return;
    }
    if (type === "trade_confirm") {
      // msg: { target, kind, payload }  -> recipient accepted; tell giver to finalize
      const target = room.players.get(Number(msg.target));
      if (!target) return;
      send(target.ws, "trade_confirm", {
        from: me.id, fromName: me.name,
        kind: String(msg.kind || ""), payload: msg.payload || {},
      });
      return;
    }
    if (type === "trade_cancel") {
      const target = room.players.get(Number(msg.target));
      if (target) send(target.ws, "trade_cancel", { from: me.id, fromName: me.name });
      return;
    }

    if (type === "chat") {
      const text = clean(msg.text, 200).trim();
      if (!text) return;
      broadcast(room, "chat", { id: me.id, name: me.name, text });
      return;
    }

    if (type === "snapshot_request") {
      // a newly-started client asks for everyone's current pos
      const peers = [...room.players.values()]
        .filter((p) => p.id !== me.id)
        .map((p) => ({ id: p.id, name: p.name, partner: p.partner, ...p.pos }));
      send(ws, "snapshot", { peers });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (room) removePlayer(room, ws.playerId);
  });
  ws.on("error", () => {
    const room = rooms.get(ws.roomCode);
    if (room) removePlayer(room, ws.playerId);
  });
});

// keep-alive: drop dead sockets
const ping = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);
wss.on("close", () => clearInterval(ping));

server.listen(PORT, () => {
  console.log(`Pokemon Multiplayer Journey server on http://localhost:${PORT}`);
});
