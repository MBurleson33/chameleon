// Chameleon room sync. Rooms live in Upstash Redis (REST API, plain fetch) and expire after a day.
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel Storage) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24;
const P = "chameleon:";
const CODE_RE = /^[A-Z]{4}$/;

async function redis(cmds) {
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const cleanName = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, 20);
const cleanId = s => String(s || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);

async function load(code) {
  const [room, players] = await redis([["GET", P + "room:" + code], ["HGETALL", P + "players:" + code]]);
  if (!room) return null;
  const list = [];
  for (let i = 0; i < (players || []).length; i += 2) {
    try { const v = JSON.parse(players[i + 1]); list.push({ id: players[i], name: v.name, t: v.t }); } catch (e) {}
  }
  list.sort((a, b) => a.t - b.t);
  return { room: JSON.parse(room), lobby: list };
}

async function saveRoom(room) {
  await redis([
    ["SET", P + "room:" + room.code, JSON.stringify(room), "EX", TTL],
    ["EXPIRE", P + "players:" + room.code, TTL],
  ]);
}

function freeze(lobby) { return lobby.map(p => ({ id: p.id, name: p.name })); }

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const send = (status, body) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...body, now: Date.now() })); };
  if (!URL_ || !TOKEN) return send(500, { error: "The game server isn't set up yet (no database connected)." });

  try {
    if (req.method === "GET") {
      const code = String((req.query && req.query.code) || new URL(req.url, "http://x").searchParams.get("code") || "").toUpperCase();
      if (!CODE_RE.test(code)) return send(400, { error: "That code doesn't look right." });
      const st = await load(code);
      if (!st) return send(404, { error: "No game with that code. Check it and try again." });
      return send(200, st);
    }
    if (req.method !== "POST") return send(405, { error: "Method not allowed" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || typeof body !== "object") {
      const raw = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); });
      try { body = JSON.parse(raw || "{}"); } catch (e) { body = {}; }
    }
    const action = body.action, pid = cleanId(body.pid);
    if (!pid) return send(400, { error: "Missing player id." });

    if (action === "create") {
      const name = cleanName(body.name);
      if (!name) return send(400, { error: "Add your name first." });
      const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
      for (let tries = 0; tries < 8; tries++) {
        let code = ""; for (let i = 0; i < 4; i++) code += L[Math.floor(Math.random() * L.length)];
        const room = { code, hostId: pid, cat: "__thanks", timer: 120, phase: "lobby", round: 0, players: [], tStart: 0, tEnd: 0, revealed: false };
        const [ok] = await redis([["SET", P + "room:" + code, JSON.stringify(room), "NX", "EX", TTL]]);
        if (ok !== "OK") continue;
        await redis([["HSET", P + "players:" + code, pid, JSON.stringify({ name, t: Date.now() })], ["EXPIRE", P + "players:" + code, TTL]]);
        return send(200, await load(code));
      }
      return send(500, { error: "Couldn't make a room code. Try again." });
    }

    const code = String(body.code || "").toUpperCase();
    if (!CODE_RE.test(code)) return send(400, { error: "That code doesn't look right." });
    const st = await load(code);
    if (!st) return send(404, { error: "No game with that code. Check it and try again." });
    const room = st.room;

    if (action === "join") {
      const name = cleanName(body.name);
      if (!name) return send(400, { error: "Add your name first." });
      const existing = st.lobby.find(p => p.id === pid);
      const taken = st.lobby.find(p => p.id !== pid && p.name.toLowerCase() === name.toLowerCase());
      if (taken) return send(409, { error: `Someone named ${taken.name} is already in. Add a last initial.` });
      await redis([["HSET", P + "players:" + code, pid, JSON.stringify({ name, t: existing ? existing.t : Date.now() })]]);
      return send(200, await load(code));
    }

    if (action === "leave") {
      if (pid !== room.hostId) await redis([["HDEL", P + "players:" + code, pid]]);
      return send(200, await load(code));
    }

    // Everything below is host only
    if (pid !== room.hostId) return send(403, { error: "Only the host can do that." });

    if (action === "settings") {
      if (typeof body.cat === "string" && body.cat.length < 40) room.cat = body.cat;
      const t = +body.timer; if ([60, 90, 120, 180, 300].includes(t)) room.timer = t;
    } else if (action === "kick") {
      const who = cleanId(body.who);
      if (who && who !== room.hostId) await redis([["HDEL", P + "players:" + code, who]]);
      st.lobby = st.lobby.filter(p => p.id !== who);
    } else if (action === "start" || action === "next") {
      const players = freeze(st.lobby);
      if (players.length < 3) return send(400, { error: "You need at least 3 players." });
      if (players.length > 12) return send(400, { error: "12 players max." });
      room.players = players; room.phase = "round"; room.round = action === "start" ? 1 : room.round + 1;
      room.tStart = room.tEnd = 0; room.revealed = false;
    } else if (action === "timer") {
      const now = Date.now();
      if (room.tStart && now < room.tEnd) { room.tStart = room.tEnd = 0; }
      else { room.tStart = now + 3000; room.tEnd = room.tStart + room.timer * 1000; }
    } else if (action === "reveal") {
      room.revealed = true;
    } else if (action === "lobby") {
      room.phase = "lobby"; room.revealed = false; room.tStart = room.tEnd = 0;
    } else {
      return send(400, { error: "Unknown action." });
    }
    await saveRoom(room);
    return send(200, { room, lobby: st.lobby });
  } catch (e) {
    return send(500, { error: "The game server had a problem. Try again in a moment." });
  }
};
