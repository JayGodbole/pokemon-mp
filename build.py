#!/usr/bin/env python3
"""Rebuild public/index.html = original game + MP bridge + MP client.
Run: python3 build.py
Place the original game HTML path in SRC."""
import re, os

SRC = os.environ.get("GAME_SRC", "game-src.html")
OUT = os.path.join(os.path.dirname(__file__), "public", "index.html")
MPJS = os.path.join(os.path.dirname(__file__), "mp-client.js")

html = open(SRC, "r", encoding="utf-8").read()

# 1) strip Cloudflare tracking script if present
html = re.sub(r"<script>\(function\(\)\{function c\(\).*?</script>", "", html, flags=re.DOTALL)

# 2) bridge to expose game globals to window
bridge = """
/* ===== MP BRIDGE: expose needed globals to window for multiplayer overlay ===== */
try {
  if (typeof G !== 'undefined') window.G = G;
  if (typeof World !== 'undefined') window.World = World;
  if (typeof TILE !== 'undefined') window.TILE = TILE;
  if (typeof VIEW_W !== 'undefined') window.VIEW_W = VIEW_W;
  if (typeof VIEW_H !== 'undefined') window.VIEW_H = VIEW_H;
  if (typeof renderWorld !== 'undefined') window.renderWorld = renderWorld;
  if (typeof getCharCanvas !== 'undefined') window.getCharCanvas = getCharCanvas;
  if (typeof openPartnerSelect !== 'undefined') window.openPartnerSelect = openPartnerSelect;
  if (typeof SPRITE_BASE !== 'undefined') window.SPRITE_BASE = SPRITE_BASE;
  if (typeof SPRITE_BACK !== 'undefined') window.SPRITE_BACK = SPRITE_BACK;
  if (typeof SPRITE_ANIM !== 'undefined') window.SPRITE_ANIM = SPRITE_ANIM;
  if (typeof SPRITE_BACK_ANIM !== 'undefined') window.SPRITE_BACK_ANIM = SPRITE_BACK_ANIM;
  if (typeof ITEM_DEFS !== 'undefined') window.ITEM_DEFS = ITEM_DEFS;
  if (typeof drawTile !== 'undefined') window.drawTile = drawTile;
  if (typeof T !== 'undefined') window.T = T;
  if (typeof POKEMON_ROSTER !== 'undefined') window.POKEMON_ROSTER = POKEMON_ROSTER;
  if (typeof WILD_POKEMON !== 'undefined') window.WILD_POKEMON = WILD_POKEMON;
  if (typeof WILD_ROUTE1 !== 'undefined') window.WILD_ROUTE1 = WILD_ROUTE1;
  if (typeof battleCopy !== 'undefined') window.battleCopy = battleCopy;
  if (typeof launchBattle !== 'undefined') window.launchBattle = launchBattle;
  if (typeof endBattle !== 'undefined') window.endBattle = endBattle;
  if (typeof bankWardrobeMoney !== 'undefined') window.bankWardrobeMoney = bankWardrobeMoney;
  (function syncGlobals(){
    try {
      if (typeof G !== 'undefined') window.G = G;
      if (typeof World !== 'undefined') window.World = World;
    } catch(e){}
    requestAnimationFrame(syncGlobals);
  })();
} catch(e){ console.warn('MP bridge error', e); }
"""

idx = html.find("</script>")
assert idx != -1, "no </script> found"
html = html[:idx] + "\n" + bridge + "\n" + html[idx:]

# 3) append MP client before </body>
mp = open(MPJS, "r", encoding="utf-8").read()
mp_block = "\n<script>\n" + mp + "\n</script>\n"
bidx = html.rfind("</body>")
assert bidx != -1, "no </body> found"
html = html[:bidx] + mp_block + html[bidx:]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8").write(html)
print("Built", OUT, "(%d bytes)" % len(html))
print(" MP module:", "MULTIPLAYER JOURNEY MODULE" in html,
      "| bridge:", "MP BRIDGE" in html,
      "| CF removed:", "challenge-platform" not in html)
