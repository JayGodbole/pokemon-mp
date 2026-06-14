// Server-authoritative PvP battle engine for Pokemon Dino Edition.
// Replicates the game's exact type chart, stat-stage multipliers and damage formula
// so battles feel identical to single-player, but the SERVER owns the truth.

export const TYPE_CHART = {
  normal:{rock:0.5,ghost:0,steel:0.5}, fire:{fire:0.5,water:0.5,grass:2,ice:2,bug:2,rock:0.5,dragon:0.5,steel:2},
  water:{fire:2,water:0.5,grass:0.5,ground:2,rock:2,dragon:0.5}, grass:{fire:0.5,water:2,grass:0.5,poison:0.5,ground:2,flying:0.5,bug:0.5,rock:2,dragon:0.5,steel:0.5},
  electric:{water:2,grass:0.5,electric:0.5,ground:0,flying:2,dragon:0.5}, ice:{fire:0.5,water:0.5,grass:2,ice:0.5,ground:2,flying:2,dragon:2,steel:0.5},
  fighting:{normal:2,ice:2,poison:0.5,flying:0.5,psychic:0.5,bug:0.5,rock:2,ghost:0,dark:2,steel:2,fairy:0.5}, poison:{grass:2,poison:0.5,ground:0.5,rock:0.5,ghost:0.5,steel:0,fairy:2},
  ground:{fire:2,electric:2,grass:0.5,poison:2,flying:0,bug:0.5,rock:2,steel:2}, flying:{grass:2,electric:0.5,fighting:2,bug:2,rock:0.5,steel:0.5},
  psychic:{fighting:2,poison:2,psychic:0.5,dark:0,steel:0.5}, bug:{fire:0.5,grass:2,fighting:0.5,poison:0.5,flying:0.5,psychic:2,ghost:0.5,dark:2,steel:0.5,fairy:0.5},
  rock:{fire:2,ice:2,fighting:0.5,ground:0.5,flying:2,bug:2,steel:0.5}, ghost:{normal:0,psychic:2,ghost:2,dark:0.5}, dragon:{dragon:2,steel:0.5,fairy:0},
  dark:{fighting:0.5,psychic:2,ghost:2,dark:0.5,fairy:0.5}, steel:{fire:0.5,water:0.5,electric:0.5,ice:2,rock:2,steel:0.5,fairy:2}, fairy:{fire:0.5,fighting:2,poison:0.5,dragon:2,dark:2,steel:0.5}
};

export function getEffectiveness(moveType, defType) {
  if (TYPE_CHART[moveType] && TYPE_CHART[moveType][defType] !== undefined) return TYPE_CHART[moveType][defType];
  return 1;
}

function effStat(poke, stat) {
  const base = poke[stat] || 0;
  const mod = (poke.statMods && poke.statMods[stat]) || 0;
  const mult = [2/8,2/7,2/6,2/5,2/4,2/3,2/2,3/2,4/2,5/2,6/2,7/2,8/2];
  const idx = Math.max(0, Math.min(12, mod + 6));
  return Math.max(1, Math.floor(base * mult[idx]));
}

export function calcDamage(attacker, defender, move) {
  if (!move.power || move.power === 0) return { dmg: 0, eff: 1 };
  const level = attacker.level || 50;
  const A = move.special ? effStat(attacker, "spAtk") : effStat(attacker, "attack");
  const D = Math.max(1, move.special ? effStat(defender, "spDef") : effStat(defender, "defense"));
  const levelBoost = Math.min(1.0, Math.max(0, (level - 50) * 0.015));
  const scaledPower = Math.floor(move.power * (1 + levelBoost));
  let dmg = Math.floor(((2 * level / 5 + 2) * scaledPower * A / D) / 50 + 2);
  if (move.type === attacker.type) dmg = Math.floor(dmg * 1.5); // STAB
  const eff = getEffectiveness(move.type, defender.type);
  dmg = Math.floor(dmg * eff);
  if (eff === 0) return { dmg: 0, eff: 0 };
  dmg = Math.floor(dmg * (0.85 + Math.random() * 0.15));
  return { dmg: Math.max(1, dmg), eff };
}

// Sanitize a client-submitted pokemon into a server battle mon (cannot be trusted blindly).
export function sanitizeMon(src) {
  src = src || {};
  const num = (v, d, lo, hi) => {
    let n = Number(v); if (!isFinite(n)) n = d;
    if (lo != null) n = Math.max(lo, n); if (hi != null) n = Math.min(hi, n);
    return Math.floor(n);
  };
  const moves = Array.isArray(src.moves) ? src.moves.slice(0, 4).map((m) => ({
    name: String(m.name || "Move").slice(0, 20),
    type: String(m.type || "normal").toLowerCase().slice(0, 12),
    power: num(m.power, 0, 0, 250),
    special: !!m.special,
    pp: num(m.pp, 10, 1, 64),
    currentPp: num(m.currentPp != null ? m.currentPp : m.pp, 10, 0, 64),
  })) : [{ name: "Tackle", type: "normal", power: 40, special: false, pp: 35, currentPp: 35 }];

  const maxHp = num(src.maxHp || src.hp, 100, 1, 2000);
  return {
    id: num(src.id, 1, 1, 100000),
    name: String(src.name || "Pokemon").slice(0, 20),
    type: String(src.type || "normal").toLowerCase().slice(0, 12),
    level: num(src.level, 50, 1, 100),
    attack: num(src.attack, 50, 1, 2000),
    defense: num(src.defense, 50, 1, 2000),
    spAtk: num(src.spAtk, 50, 1, 2000),
    spDef: num(src.spDef, 50, 1, 2000),
    speed: num(src.speed, 50, 1, 2000),
    maxHp,
    currentHp: maxHp,
    statMods: { attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 },
    moves,
  };
}

// A PvP battle between two players. Both submit a move; engine resolves the turn.
export class Battle {
  constructor(p1Id, p1Mon, p2Id, p2Mon) {
    this.players = {
      [p1Id]: { mon: p1Mon, choice: null },
      [p2Id]: { mon: p2Mon, choice: null },
    };
    this.ids = [p1Id, p2Id];
    this.turn = 1;
    this.over = false;
    this.winner = null;
  }

  mon(id) { return this.players[id].mon; }
  opponent(id) { return this.ids.find((x) => x !== id); }

  setChoice(id, choice) {
    if (this.over || !this.players[id]) return false;
    if (this.players[id].choice) return false; // already chose this turn
    this.players[id].choice = choice;
    return true;
  }

  bothChosen() {
    return this.ids.every((id) => this.players[id].choice);
  }

  // Resolve a turn -> returns an ordered list of events for clients to animate.
  resolveTurn() {
    const events = [];
    const order = this.turnOrder();

    for (const id of order) {
      if (this.over) break;
      const me = this.players[id];
      const oppId = this.opponent(id);
      const myMon = me.mon, oppMon = this.players[oppId].mon;
      const choice = me.choice;

      if (myMon.currentHp <= 0) continue; // fainted, skip

      if (choice.type === "move") {
        const move = myMon.moves[choice.index];
        if (!move) continue;
        if (move.currentPp <= 0) {
          events.push({ kind: "text", text: `${myMon.name} has no PP left for ${move.name}!` });
          continue;
        }
        move.currentPp = Math.max(0, move.currentPp - 1);
        events.push({ kind: "use", attacker: id, move: move.name });
        const { dmg, eff } = calcDamage(myMon, oppMon, move);
        oppMon.currentHp = Math.max(0, oppMon.currentHp - dmg);
        events.push({
          kind: "damage", attacker: id, defender: oppId, dmg, eff,
          defHp: oppMon.currentHp, defMaxHp: oppMon.maxHp,
        });
        if (eff > 1) events.push({ kind: "text", text: "It's super effective!" });
        else if (eff === 0) events.push({ kind: "text", text: "It had no effect!" });
        else if (eff < 1) events.push({ kind: "text", text: "It's not very effective..." });

        if (oppMon.currentHp <= 0) {
          events.push({ kind: "faint", who: oppId, name: oppMon.name });
          this.over = true;
          this.winner = id;
          break;
        }
      } else if (choice.type === "struggle") {
        // fallback if no usable move
        events.push({ kind: "text", text: `${myMon.name} struggled!` });
      }
    }

    // reset choices for next turn
    this.ids.forEach((id) => (this.players[id].choice = null));
    this.turn++;
    return events;
  }

  turnOrder() {
    const [a, b] = this.ids;
    const sa = effStat(this.players[a].mon, "speed");
    const sb = effStat(this.players[b].mon, "speed");
    if (sa === sb) return Math.random() < 0.5 ? [a, b] : [b, a];
    return sa > sb ? [a, b] : [b, a];
  }

  publicState() {
    const s = {};
    for (const id of this.ids) {
      const m = this.mon(id);
      s[id] = {
        name: m.name, id: m.id, type: m.type, level: m.level,
        currentHp: m.currentHp, maxHp: m.maxHp,
        moves: m.moves.map((mv) => ({ name: mv.name, type: mv.type, power: mv.power, currentPp: mv.currentPp, pp: mv.pp })),
      };
    }
    return { turn: this.turn, over: this.over, winner: this.winner, mons: s };
  }
}
