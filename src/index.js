// The drexun.com website (owner, 2026-10-01): one Cloudflare worker that serves the pages (the public folder) and a
// small API over its own copy of the public stats in a D1 database.
//
// The game server SENDS, the website never reaches into it: Drexun Core posts to /api/ingest every minute (status)
// and every few minutes (players whose stats changed, new season results), with the INGEST_KEY secret as a Bearer
// token. Nothing private ever arrives here (no chat, no staff or admin logs, no IPs). The reply carries the season
// cursor and an (empty for now) list of jobs for the server: a bought VIP or a staff action from the site later.
//
// Free-plan limits this is built around: a few D1 queries per request (the bulk upsert is ONE statement over a JSON
// parameter), and every public answer is cached at the edge for a minute so page views do not each hit D1.
//
// Source: web/worker.js in the project; tools/Build-Books.ps1 copies it to _site/src/index.js. Deployed with
// dx site deploy.

const PER_PAGE = 50;
const ONLINE_SECONDS = 150;          // no status for this long = the server shows as offline
const MAX_BODY = 4 * 1024 * 1024;
const CHUNK_CHARS = 700 * 1024;      // one JSON parameter per statement stays well under D1's 2 MB value limit

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
     steam_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL,
     rating INTEGER NOT NULL, xp INTEGER NOT NULL, level INTEGER NOT NULL, title TEXT NOT NULL,
     level_xp INTEGER NOT NULL, next_level_xp INTEGER NOT NULL,
     ranked_wins INTEGER NOT NULL, ranked_losses INTEGER NOT NULL, ranked_ties INTEGER NOT NULL, ranked_rounds INTEGER NOT NULL,
     kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, headshots INTEGER NOT NULL DEFAULT 0,
     hits_head INTEGER NOT NULL DEFAULT 0, hits_body INTEGER NOT NULL DEFAULT 0, hits_legs INTEGER NOT NULL DEFAULT 0,
     weapons TEXT NOT NULL DEFAULT '[]', maps TEXT NOT NULL DEFAULT '[]', modes TEXT NOT NULL DEFAULT '[]',
     damage INTEGER NOT NULL DEFAULT 0, rounds_total INTEGER NOT NULL DEFAULT 0,
     first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_players_rating ON players (rating DESC, ranked_wins DESC, last_seen ASC)`,
  `CREATE INDEX IF NOT EXISTS ix_players_xp ON players (xp DESC, last_seen ASC)`,
  `CREATE TABLE IF NOT EXISTS season_results (
     id INTEGER PRIMARY KEY, season TEXT NOT NULL, steam_id TEXT NOT NULL, name TEXT NOT NULL,
     rating INTEGER NOT NULL, xp INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, ties INTEGER NOT NULL,
     position INTEGER, archived TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_season_player ON season_results (steam_id, id)`,
  `CREATE INDEX IF NOT EXISTS ix_season_position ON season_results (position, archived)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // The rating graph (owner, 2026-10-01): each player's rating at the end of each day they played (UTC day).
  `CREATE TABLE IF NOT EXISTS rating_history (steam_id TEXT NOT NULL, day TEXT NOT NULL, rating INTEGER NOT NULL, PRIMARY KEY (steam_id, day))`,
  // Steam avatars and names (owner, 2026-10-01: "a modern profile that includes their steam and avatar"), from Steam's
  // official Web API with the STEAM_API_KEY secret, kept a day so Steam is asked rarely.
  `CREATE TABLE IF NOT EXISTS steam_profiles (
     steam_id TEXT PRIMARY KEY, persona TEXT NOT NULL, avatar TEXT NOT NULL, avatar_full TEXT NOT NULL, fetched TEXT NOT NULL)`,
];
const STEAM_REFRESH_MS = 24 * 3600 * 1000;
const STEAM_AVATAR = /^https:\/\/avatars\.(?:[a-z]+\.)?steamstatic\.com\/[0-9a-f]{40}(?:_medium|_full)?\.jpg$/;

// Columns added after the first version: an existing table gets them once (the error for one that exists is ignored).
const ADDED_COLUMNS = [
  ...['kills', 'deaths', 'headshots', 'hits_head', 'hits_body', 'hits_legs', 'damage', 'rounds_total'].map((c) => `ALTER TABLE players ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`),
  ...['weapons', 'maps', 'modes'].map((c) => `ALTER TABLE players ADD COLUMN ${c} TEXT NOT NULL DEFAULT '[]'`),
];

let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    try {
      if (url.pathname === '/api/ingest') return await ingest(request, env);
      if (url.pathname === '/auth/steam') return steamSignIn(request, env, url);
      if (url.pathname === '/auth/steam/callback') return await steamCallback(request, env, url);
      if (url.pathname === '/auth/logout') return signOut(request, url);
      if (url.pathname === '/api/me') return await me(request, env);
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
    } catch (error) {
      console.error('request failed', url.pathname, error && error.stack || error);
      return json({ error: 'Something went wrong. Try again in a minute.' }, 500, 0);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

// ---------------------------------------------------------------------------------------------- from the server

async function ingest(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, 0);
  if (!env.INGEST_KEY) return json({ error: 'INGEST_KEY is not set on the worker' }, 503, 0);
  if (!(await sameText(request.headers.get('Authorization') || '', `Bearer ${env.INGEST_KEY}`))) return json({ error: 'wrong key' }, 401, 0);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413, 0);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'not JSON' }, 400, 0); }
  if (!body || body.v !== 1) return json({ error: 'unknown version' }, 400, 0);

  await ensureSchema(env);
  const now = new Date().toISOString();
  const writes = [];
  if (body.season !== undefined) writes.push(setMeta(env, 'season', JSON.stringify(cleanSeason(body.season))));

  if (body.kind === 'status') {
    const s = body.status || {};
    const status = {
      map: str(s.map, 64),
      players: Array.isArray(s.players) ? s.players.slice(0, 64).map((name) => str(name, 64)) : [],
      max: int(s.max),
      mapSecondsLeft: s.mapSecondsLeft === null || s.mapSecondsLeft === undefined ? null : int(s.mapSecondsLeft),
      connect: str(s.connect, 64),
      received: now,
    };
    writes.push(setMeta(env, 'status', JSON.stringify(status)));
  } else if (body.kind === 'stats') {
    const players = (Array.isArray(body.players) ? body.players : []).map(cleanPlayer).filter(Boolean);
    for (const chunk of chunks(players)) writes.push(upsertPlayers(env, chunk), saveRatings(env, chunk, now.slice(0, 10)));
    const results = (Array.isArray(body.seasonResults) ? body.seasonResults : []).map(cleanResult).filter(Boolean);
    for (const chunk of chunks(results)) writes.push(upsertResults(env, chunk));
    writes.push(setMeta(env, 'stats_received', now));
  } else {
    return json({ error: 'unknown kind' }, 400, 0);
  }

  if (writes.length > 0) await env.DB.batch(writes);
  const cursor = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM season_results').first('id');
  return json({ ok: true, seasonCursor: cursor, jobs: [] }, 200, 0);
}

function upsertPlayers(env, rows) {
  return env.DB.prepare(`
    INSERT INTO players (steam_id, name, name_lower, rating, xp, level, title, level_xp, next_level_xp,
      ranked_wins, ranked_losses, ranked_ties, ranked_rounds, kills, deaths, headshots, hits_head, hits_body, hits_legs, weapons, maps, modes, damage, rounds_total,
      first_seen, last_seen)
    SELECT json_extract(value, '$.steamId'), json_extract(value, '$.name'), lower(json_extract(value, '$.name')),
      json_extract(value, '$.rating'), json_extract(value, '$.xp'), json_extract(value, '$.level'), json_extract(value, '$.title'),
      json_extract(value, '$.levelXp'), json_extract(value, '$.nextLevelXp'),
      json_extract(value, '$.rankedWins'), json_extract(value, '$.rankedLosses'), json_extract(value, '$.rankedTies'), json_extract(value, '$.rankedRounds'),
      json_extract(value, '$.kills'), json_extract(value, '$.deaths'), json_extract(value, '$.headshots'),
      json_extract(value, '$.hitsHead'), json_extract(value, '$.hitsBody'), json_extract(value, '$.hitsLegs'),
      json_extract(value, '$.weapons'), json_extract(value, '$.maps'), json_extract(value, '$.modes'),
      json_extract(value, '$.damage'), json_extract(value, '$.roundsTotal'),
      json_extract(value, '$.firstSeen'), json_extract(value, '$.lastSeen')
    FROM json_each(?1) WHERE true
    ON CONFLICT (steam_id) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower,
      rating = excluded.rating, xp = excluded.xp, level = excluded.level, title = excluded.title, level_xp = excluded.level_xp,
      next_level_xp = excluded.next_level_xp, ranked_wins = excluded.ranked_wins, ranked_losses = excluded.ranked_losses,
      ranked_ties = excluded.ranked_ties, ranked_rounds = excluded.ranked_rounds, kills = excluded.kills,
      deaths = excluded.deaths, headshots = excluded.headshots, hits_head = excluded.hits_head, hits_body = excluded.hits_body,
      hits_legs = excluded.hits_legs, weapons = excluded.weapons, maps = excluded.maps, modes = excluded.modes,
      damage = excluded.damage, rounds_total = excluded.rounds_total, first_seen = excluded.first_seen,
      last_seen = excluded.last_seen`).bind(JSON.stringify(rows));
}

// Today's rating of every player in the batch (the last one of the day wins): the points of the rating graph.
function saveRatings(env, rows, day) {
  return env.DB.prepare(`
    INSERT INTO rating_history (steam_id, day, rating)
    SELECT json_extract(value, '$.steamId'), ?2, json_extract(value, '$.rating') FROM json_each(?1) WHERE true
    ON CONFLICT (steam_id, day) DO UPDATE SET rating = excluded.rating`).bind(JSON.stringify(rows.map((r) => ({ steamId: r.steamId, rating: r.rating }))), day);
}

function upsertResults(env, rows) {
  return env.DB.prepare(`
    INSERT OR REPLACE INTO season_results (id, season, steam_id, name, rating, xp, wins, losses, ties, position, archived)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.season'), json_extract(value, '$.steamId'), json_extract(value, '$.name'),
      json_extract(value, '$.rating'), json_extract(value, '$.xp'), json_extract(value, '$.wins'), json_extract(value, '$.losses'),
      json_extract(value, '$.ties'), json_extract(value, '$.position'), json_extract(value, '$.archived')
    FROM json_each(?1)`).bind(JSON.stringify(rows));
}

function cleanPlayer(p) {
  if (!p || !isSteamId(p.steamId)) return null;
  const rankedWins = int(p.rankedWins), rankedLosses = int(p.rankedLosses), rankedTies = int(p.rankedTies);
  return {
    steamId: p.steamId, name: str(p.name, 64) || '?',
    rating: int(p.rating), xp: int(p.xp), level: int(p.level), title: str(p.title, 32), levelXp: int(p.levelXp), nextLevelXp: int(p.nextLevelXp),
    rankedWins, rankedLosses, rankedTies, rankedRounds: rankedWins + rankedLosses + rankedTies,
    kills: int(p.kills), deaths: int(p.deaths), headshots: int(p.headshots),
    hitsHead: int(p.hitsHead), hitsBody: int(p.hitsBody), hitsLegs: int(p.hitsLegs),
    // Stored as JSON text (one small list per player); only well-formed entries are kept.
    weapons: JSON.stringify((Array.isArray(p.weapons) ? p.weapons : []).slice(0, 5)
      .filter((w) => w && /^[a-z0-9_]{1,32}$/.test(w.weapon))
      .map((w) => ({ weapon: w.weapon, kills: int(w.kills), headshots: int(w.headshots), hitsHead: int(w.hitsHead), hitsBody: int(w.hitsBody), hitsLegs: int(w.hitsLegs) }))),
    maps: JSON.stringify((Array.isArray(p.maps) ? p.maps : []).slice(0, 5)
      .filter((m) => m && str(m.map, 64))
      .map((m) => ({ map: str(m.map, 64), wins: int(m.wins), losses: int(m.losses) }))),
    modes: JSON.stringify((Array.isArray(p.modes) ? p.modes : []).slice(0, 5)
      .filter((m) => m && str(m.mode, 64))
      .map((m) => ({ mode: str(m.mode, 64), wins: int(m.wins), losses: int(m.losses) }))),
    damage: int(p.damage), roundsTotal: int(p.rankedRoundsTotal),
    firstSeen: isoOr(p.firstSeen), lastSeen: isoOr(p.lastSeen),
  };
}

function cleanResult(r) {
  if (!r || !Number.isSafeInteger(r.id) || r.id <= 0 || !isSteamId(r.steamId)) return null;
  return {
    id: r.id, season: str(r.season, 16), steamId: r.steamId, name: str(r.name, 64) || '?',
    rating: int(r.rating), xp: int(r.xp), wins: int(r.wins), losses: int(r.losses), ties: int(r.ties),
    position: Number.isSafeInteger(r.position) ? r.position : null, archived: isoOr(r.archived),
  };
}

function cleanSeason(s) {
  if (!s || typeof s !== 'object') return null;
  return { ends: isoOr(s.ends), placementRounds: Math.max(1, int(s.placementRounds) || 10) };
}

// ---------------------------------------------------------------------------------------------- public API

async function api(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'GET only' }, 405, 0);

  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  await ensureSchema(env);
  const path = url.pathname;
  let response;
  if (path === '/api/status') response = json(await status(env), 200, 30);
  else if (path === '/api/leaderboard') response = json(await leaderboard(env, url), 200, 60);
  else if (path === '/api/search') response = json(await search(env, url), 200, 60);
  else if (path === '/api/halloffame') response = json(await hallOfFame(env), 200, 120);
  else if (path.startsWith('/api/player/')) {
    const player = await playerPage(env, decodeURIComponent(path.slice('/api/player/'.length)));
    response = player ? json(player, 200, 60) : json({ error: 'No player with that id.' }, 404, 60);
  } else {
    return json({ error: 'Unknown API address.' }, 404, 0);
  }

  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function status(env) {
  const [statusText, seasonText, statsReceived] = await Promise.all([getMeta(env, 'status'), getMeta(env, 'season'), getMeta(env, 'stats_received')]);
  const s = statusText ? JSON.parse(statusText) : null;
  const age = s ? (Date.now() - Date.parse(s.received)) / 1000 : Infinity;
  return {
    online: age <= ONLINE_SECONDS,
    map: s ? s.map : null,
    players: s && age <= ONLINE_SECONDS ? s.players : [],
    max: s ? s.max : null,
    mapSecondsLeft: s && age <= ONLINE_SECONDS ? s.mapSecondsLeft : null,
    connect: s && s.connect ? s.connect : 'drexun.ggwp.cc:25401',
    lastSeen: s ? s.received : null,
    season: seasonText ? JSON.parse(seasonText) : null,
    statsUpdated: statsReceived,
  };
}

async function placementRounds(env) {
  const season = await getMeta(env, 'season');
  const parsed = season ? JSON.parse(season) : null;
  return parsed && parsed.placementRounds ? parsed.placementRounds : 10;
}

async function leaderboard(env, url) {
  const type = url.searchParams.get('type') === 'level' ? 'level' : 'rating';
  const page = Math.min(Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1), 1000);
  const offset = (page - 1) * PER_PAGE;
  const placement = await placementRounds(env);
  const where = type === 'rating' ? 'ranked_rounds >= ?1' : 'xp > 0 AND ?1 = ?1';
  const order = type === 'rating' ? 'rating DESC, ranked_wins DESC, last_seen ASC' : 'xp DESC, last_seen ASC';
  const [rows, total] = await Promise.all([
    env.DB.prepare(`SELECT * FROM players WHERE ${where} ORDER BY ${order} LIMIT ?2 OFFSET ?3`).bind(placement, PER_PAGE, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${where}`).bind(placement).first('n'),
  ]);
  return {
    type, page, perPage: PER_PAGE, total, placementRounds: placement,
    rows: await withSteam(env, rows.results.map((row, i) => ({ position: offset + i + 1, ...publicPlayer(row) }))),
  };
}

async function search(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 32);
  if (isSteamId(q)) {
    const row = await env.DB.prepare('SELECT * FROM players WHERE steam_id = ?1').bind(q).first();
    return { query: q, rows: await withSteam(env, row ? [publicPlayer(row)] : []) };
  }
  if (q.length < 2) return { query: q, rows: [] };
  const like = '%' + q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await env.DB.prepare(
    "SELECT * FROM players WHERE name_lower LIKE ?1 ESCAPE '\\' ORDER BY (name_lower = ?2) DESC, xp DESC LIMIT 25",
  ).bind(like, q.toLowerCase()).all();
  return { query: q, rows: await withSteam(env, rows.results.map(publicPlayer)) };
}

async function playerPage(env, steamId) {
  if (!isSteamId(steamId)) return null;
  const row = await env.DB.prepare('SELECT * FROM players WHERE steam_id = ?1').bind(steamId).first();
  if (!row) return null;
  const placement = await placementRounds(env);
  const [ratingAhead, levelAhead, seasons] = await Promise.all([
    row.ranked_rounds >= placement
      ? env.DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ranked_rounds >= ?1 AND steam_id <> ?2 AND (rating > ?3
          OR (rating = ?3 AND ranked_wins > ?4) OR (rating = ?3 AND ranked_wins = ?4 AND last_seen < ?5))`)
        .bind(placement, row.steam_id, row.rating, row.ranked_wins, row.last_seen).first('n')
      : Promise.resolve(null),
    row.xp > 0
      ? env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE xp > 0 AND steam_id <> ?1 AND (xp > ?2 OR (xp = ?2 AND last_seen < ?3))')
        .bind(row.steam_id, row.xp, row.last_seen).first('n')
      : Promise.resolve(null),
    env.DB.prepare('SELECT season, rating, wins, losses, position, archived FROM season_results WHERE steam_id = ?1 ORDER BY id DESC LIMIT 36')
      .bind(row.steam_id).all(),
  ]);
  // The graph covers the running season: from the last season end (its results' archive time), at most 92 days back.
  const lastEnd = await env.DB.prepare('SELECT MAX(archived) AS t FROM season_results').first('t');
  const floor = new Date(Date.now() - 92 * 86400000).toISOString();
  const seasonStart = lastEnd && lastEnd > floor ? lastEnd : floor;
  const history = await env.DB.prepare('SELECT day, rating FROM rating_history WHERE steam_id = ?1 AND day >= ?2 ORDER BY day LIMIT 100')
    .bind(row.steam_id, seasonStart.slice(0, 10)).all();
  const [shown] = await withSteam(env, [publicPlayer(row)]);
  return {
    ...shown,
    levelXp: row.level_xp, nextLevelXp: row.next_level_xp,
    hitsHead: row.hits_head, hitsBody: row.hits_body, hitsLegs: row.hits_legs,
    weapons: parseList(row.weapons), maps: parseList(row.maps), modes: parseList(row.modes),
    damage: row.damage, roundsTotal: row.rounds_total,
    ratingHistory: history.results, seasonStart,
    rankedRounds: row.ranked_rounds, placementRounds: placement,
    ratingPosition: ratingAhead === null ? null : ratingAhead + 1,
    levelPosition: levelAhead === null ? null : levelAhead + 1,
    firstSeen: row.first_seen, lastSeen: row.last_seen,
    seasons: seasons.results,
  };
}

async function hallOfFame(env) {
  const rows = await env.DB.prepare(`
    SELECT r.season, r.archived, r.position, r.steam_id, r.name, r.rating, r.wins, r.losses
    FROM season_results r
    WHERE r.position BETWEEN 1 AND 5
    ORDER BY r.archived DESC, r.position ASC LIMIT 600`).all();
  // One block per season end (a season can only end once, but a manual !newseason reuses the month's label).
  const seasons = [];
  for (const r of rows.results) {
    let block = seasons[seasons.length - 1];
    if (!block || block.archived !== r.archived) {
      block = { season: r.season, archived: r.archived, finishers: [] };
      seasons.push(block);
    }
    block.finishers.push({
      position: r.position, steamId: r.steam_id, name: r.name,
      rating: r.rating, wins: r.wins, losses: r.losses,
    });
  }
  await withSteam(env, seasons.flatMap((s) => s.finishers));
  return { seasons };
}

// Adds avatar (64 px), avatarFull (184 px) and steamName to every player of the list. Missing or
// day-old ones are asked from Steam in one call (up to 100 ids); without the key, or when Steam does not answer within
// 3 seconds, the list simply goes out without them.
async function withSteam(env, players) {
  const ids = [...new Set(players.filter((p) => p && p.steamId).map((p) => p.steamId))];
  if (ids.length === 0) return players;
  const known = new Map();
  const rows = await env.DB.prepare('SELECT * FROM steam_profiles WHERE steam_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(ids)).all();
  for (const row of rows.results) known.set(row.steam_id, row);

  const stale = ids.filter((id) => !known.has(id) || Date.now() - Date.parse(known.get(id).fetched) > STEAM_REFRESH_MS).slice(0, 100);
  if (env.STEAM_API_KEY && stale.length > 0) {
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(env.STEAM_API_KEY)}&steamids=${stale.join(',')}`;
      const answer = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (answer.ok) {
        const fetched = new Date().toISOString();
        const fresh = ((await answer.json()).response?.players || [])
          .filter((s) => isSteamId(s.steamid) && STEAM_AVATAR.test(s.avatarmedium || '') && STEAM_AVATAR.test(s.avatarfull || ''))
          .map((s) => ({ steamId: s.steamid, persona: str(s.personaname, 64), avatar: s.avatarmedium, avatarFull: s.avatarfull, fetched }));
        for (const s of fresh) known.set(s.steamId, { steam_id: s.steamId, persona: s.persona, avatar: s.avatar, avatar_full: s.avatarFull, fetched });
        if (fresh.length > 0) {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO steam_profiles (steam_id, persona, avatar, avatar_full, fetched)
            SELECT json_extract(value, '$.steamId'), json_extract(value, '$.persona'), json_extract(value, '$.avatar'),
              json_extract(value, '$.avatarFull'), json_extract(value, '$.fetched')
            FROM json_each(?1)`).bind(JSON.stringify(fresh)).run();
        }
      } else {
        console.warn('Steam answered', answer.status);
      }
    } catch (error) {
      console.warn('Steam did not answer', String(error));
    }
  }

  for (const p of players) {
    const s = p && p.steamId ? known.get(p.steamId) : null;
    if (s) Object.assign(p, { avatar: s.avatar, avatarFull: s.avatar_full, steamName: s.persona });
  }
  return players;
}

function publicPlayer(row) {
  return {
    steamId: row.steam_id, name: row.name,
    rating: row.rating, xp: row.xp, level: row.level, title: row.title,
    wins: row.ranked_wins, losses: row.ranked_losses,
    kills: row.kills, deaths: row.deaths, headshots: row.headshots,
  };
}

// ---------------------------------------------------------------------------------------------- Steam login
// Owner, 2026-10-01 ("login with steam"). Steam's own OpenID 2.0 sign-in: the player types their password only on
// steamcommunity.com; Steam sends back a signed answer naming their SteamID, which is checked with Steam again
// (check_authentication) before it is believed. The website then sets ONE cookie: the SteamID and an expiry, signed
// with the SESSION_SECRET worker secret (HMAC-SHA256), so it cannot be made up or changed. Nothing is stored server-side.

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const SESSION_COOKIE = 'dx_session';
const SESSION_DAYS = 30;

// The site's own address for Steam's return trip: always https://drexun.com online; on this PC (dx site dev, which
// presents requests as coming to drexun.com) the SITE_ORIGIN value from .dev.vars, http://127.0.0.1:8787.
function siteOrigin(env, url) {
  if (env.SITE_ORIGIN) return env.SITE_ORIGIN;
  return url.hostname === 'drexun.com' ? 'https://drexun.com' : url.origin;
}

function steamSignIn(request, env, url) {
  if (!env.SESSION_SECRET) return json({ error: 'Steam login is not set up yet (SESSION_SECRET).' }, 503, 0);
  const origin = siteOrigin(env, url);
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${origin}/auth/steam/callback`,
    'openid.realm': `${origin}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return Response.redirect(`${STEAM_OPENID}?${params}`, 302);
}

async function steamCallback(request, env, url) {
  if (!env.SESSION_SECRET) return json({ error: 'Steam login is not set up yet (SESSION_SECRET).' }, 503, 0);
  const q = url.searchParams;
  const claimed = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/.exec(q.get('openid.claimed_id') || '');
  const returnTo = q.get('openid.return_to') || '';
  if (q.get('openid.mode') !== 'id_res' || !claimed || q.get('openid.op_endpoint') !== STEAM_OPENID
    || !returnTo.startsWith(`${siteOrigin(env, url)}/auth/steam/callback`)) {
    return signInFailed(url, 'Steam did not confirm the sign-in.');
  }

  // Ask Steam whether it really sent this answer.
  const check = new URLSearchParams();
  for (const [key, value] of q) if (key.startsWith('openid.')) check.set(key, value);
  check.set('openid.mode', 'check_authentication');
  let valid = false;
  try {
    const answer = await fetch(STEAM_OPENID, {
      method: 'POST', body: check, signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    valid = answer.ok && /(^|\n)is_valid\s*:\s*true(\n|$)/.test(await answer.text());
  } catch (error) {
    console.warn('Steam check failed', String(error));
  }
  if (!valid) return signInFailed(url, 'Steam could not confirm the sign-in. Try again.');

  const steamId = claimed[1];
  const cookie = await makeSession(env, steamId);
  const headers = new Headers({ Location: `/player?id=${steamId}`, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', `${SESSION_COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

function signInFailed(url, message) {
  return new Response(null, { status: 302, headers: { Location: `/?signin=${encodeURIComponent(message)}`, 'Cache-Control': 'no-store' } });
}

// Sign-out is a POST from the site's own button (a link elsewhere cannot sign anyone out).
function signOut(request, url) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}

// Who is signed in (never cached): { signedIn, steamId, name, avatar, hasStats }.
async function me(request, env) {
  const steamId = await readSession(request, env);
  if (!steamId) return json({ signedIn: false }, 200, 0);
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT steam_id, name, rating, level FROM players WHERE steam_id = ?1').bind(steamId).first();
  const [shown] = await withSteam(env, [{ steamId, name: row ? row.name : null }]);
  return json({
    signedIn: true, steamId, hasStats: !!row,
    name: (row && row.name) || shown.steamName || 'Player', avatar: shown.avatar || null,
  }, 200, 0);
}

async function makeSession(env, steamId) {
  const payload = `${steamId}.${Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400}`;
  return `${payload}.${await sign(env, payload)}`;
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookie = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
  const m = /^(7656119\d{10})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m || Number(m[2]) < Date.now() / 1000) return null;
  return (await sameText(m[3], await sign(env, `${m[1]}.${m[2]}`))) ? m[1] : null;
}

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------------------------- helpers

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  // Only the columns an older table really lacks (one look at the table instead of a failing ALTER per column).
  const have = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('players')").all()).results.map((c) => c.name));
  const missing = ADDED_COLUMNS.filter((sql) => !have.has(/ADD COLUMN (\w+)/.exec(sql)[1]));
  for (const sql of missing) {
    try { await env.DB.prepare(sql).run(); } catch (error) { console.warn('adding a column failed', sql, String(error)); }
  }
  schemaReady = true;
}

function getMeta(env, key) {
  return env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first('value');
}

function setMeta(env, key, value) {
  return env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value);
}

function* chunks(rows) {
  let current = [], size = 2;
  for (const row of rows) {
    const length = JSON.stringify(row).length + 1;
    if (current.length > 0 && size + length > CHUNK_CHARS) { yield current; current = []; size = 2; }
    current.push(row);
    size += length;
  }
  if (current.length > 0) yield current;
}

function json(data, status, maxAgeSeconds) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAgeSeconds > 0 ? `public, max-age=${maxAgeSeconds}` : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(JSON.stringify(data), { status, headers });
}

// The pages only load their own files plus Google Fonts; nothing may frame them.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://*.steamstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Compares the key without leaking how many characters matched (both sides hashed first: equal lengths).
async function sameText(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function parseList(text) { try { const list = JSON.parse(text || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
function isSteamId(value) { return typeof value === 'string' && /^7656119\d{10}$/.test(value); }
function int(value) { return Number.isFinite(value) ? Math.trunc(value) : 0; }
function str(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''; }
function isoOr(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString(); }
