// Multiplayer Journey server for Pokemon Dino Edition
// - Lobby system: create/join rooms by code, ready-up, host starts the journey
// - In-journey: relays each player's overworld position to all peers (relay model)
// Express serves the game HTML from ./public ; ws handles realtime.

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Friendly default: serve the game at "/"
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 8; // "more than 2" supported, capped for sanity

// rooms: code -> { code, hostId, started, players: Map<id, player> }
// player: { id, ws, name, ready, partner, pos:{tileX,tileY,dir,moving,area}, lastSeen }
const rooms = new Map();
let nextId = 1;

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

function removePlayer(room, id) {
  const wasHost = room.hostId === id;
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
      const room = { code, hostId: ws.playerId, started: false, players: new Map() };
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
