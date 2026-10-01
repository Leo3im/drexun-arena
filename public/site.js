// The live parts of drexun.com: server status, leaderboards, search, player pages, hall of fame. Each page has the
// placeholders it needs (ids below); everything a player typed (names) is put in as text, never as HTML.
// Source: web/site.js.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function get(path) {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The website answered ${response.status}.`);
    return data;
  }

  function fill(target, ...children) { target.replaceChildren(...children.flat().filter(Boolean)); }
  function problem(target, error) { fill(target, el('p', { class: 'box error', text: `Could not load this: ${error.message}` })); }

  const number = (n) => (n ?? 0).toLocaleString('en-US');
  const seasonName = (label) => {
    const m = /^(\d{4})-(\d{2})$/.exec(label || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : (label || '');
  };
  const date = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  // "today", "yesterday", else the date (in the reader's own time zone).
  function dayName(iso) {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(new Date()) - day(new Date(iso))) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : date(iso);
  }
  function ago(iso) {
    const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (seconds < 90) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  }
  function until(iso) {
    const seconds = (Date.parse(iso) - Date.now()) / 1000;
    if (!(seconds > 0)) return 'soon';
    const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600);
    return days > 0 ? `${days} day${days === 1 ? '' : 's'} ${hours} h` : `${hours} h ${Math.floor((seconds % 3600) / 60)} min`;
  }
  const titleClass = (title) => 't-' + String(title || '').toLowerCase().replace(/[^a-z]/g, '');
  // Wins and losses spelled out (owner, 2026-10-01: "76-43-2" did not explain itself). Ties are not counted or shown
  // anywhere (owner, same day).
  const record = (p) => `${p.wins} W · ${p.losses} L`;
  const winRate = (w, l) => (w + l > 0 ? Math.round((100 * w) / (w + l)) + '%' : '-');
  // Same rules as in game (KillStatsRules): kills per death, just the kills while there are no deaths yet.
  const kd = (p) => ((p.deaths > 0 ? p.kills / p.deaths : p.kills || 0)).toFixed(2);
  const hsPercent = (p) => (p.kills > 0 ? Math.round((100 * Math.min(p.headshots, p.kills)) / p.kills) : 0) + '%';

  // The Steam avatar next to a name; without one (no Steam data yet) a square with the first letter,
  // so every row lines up the same.
  const avatar = (p, size) => (p.avatar
    ? el('img', { class: 'av', src: size > 64 ? p.avatarFull : p.avatar, alt: '', width: size, height: size, loading: 'lazy', referrerpolicy: 'no-referrer' })
    : el('span', { class: 'av letter', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px`, text: (p.name || '?').trim().charAt(0).toUpperCase() || '?' }));
  function nameLink(p, size = 28) {
    return el('a', { class: 'pname', href: `/player?id=${encodeURIComponent(p.steamId)}` }, avatar(p, size), el('span', { text: p.name }));
  }
  const titleTag = (p) => el('span', { class: `title-tag ${titleClass(p.title)}`, text: p.title });
  // Places are plain numbers everywhere (owner, 2026-10-01: no medals, no badges). The top 5 of the season, who win VIP,
  // only get a thin blue line on their row in the rating list.
  const VIP_PLACES = 5;
  const place = (position) => String(position);

  // ------------------------------------------------------------------------------------------ server status

  async function serverStatus(target) {
    try {
      const s = await get('/api/status');
      const players = s.players || [];
      const parts = [
        el('div', { class: 'status-line' },
          el('span', { class: 'state' }, el('span', { class: `dot ${s.online ? 'on' : 'off'}` }), s.online ? 'Online' : 'Offline'),
          s.online ? el('span', { class: 'big-num' }, String(players.length), el('small', { text: ` / ${s.max ?? '?'} players` })) : null),
      ];
      if (s.online) {
        const left = s.mapSecondsLeft;
        parts.push(el('p', {}, 'Map ', el('span', { class: 'map', text: s.map || '?' }),
          left === null || left === undefined ? '' : left <= 0 ? ' · changes after this round' : ` · changes in about ${Math.max(1, Math.round(left / 60))} min`));
        if (players.length > 0) parts.push(el('ul', { class: 'chips', 'aria-label': 'Players online' }, players.map((name) => el('li', { text: name }))));
        else parts.push(el('p', { class: 'note', text: 'Nobody is on right now. Join and the first duel starts as soon as someone else does.' }));
      } else {
        parts.push(el('p', { class: 'note', text: s.lastSeen ? `No signal from the server since ${ago(s.lastSeen)}. It may be restarting or updating.` : 'The server has not reported in yet.' }));
      }
      parts.push(el('a', { class: 'play', href: `steam://connect/${s.connect}` , text: 'Join the server' }));
      parts.push(el('p', { class: 'note' }, 'Or open the CS2 console and type ', el('code', { text: `connect ${s.connect}` })));
      if (s.season && s.season.ends) parts.push(el('p', { class: 'updated', text: `Season ends in ${until(s.season.ends)} (${date(s.season.ends)})` }));
      fill(target, parts);
    } catch (error) { problem(target, error); }
  }

  // ------------------------------------------------------------------------------------------ home page lists

  async function miniBoard(target, type) {
    try {
      const data = await get(`/api/leaderboard?type=${type}`);
      const rows = data.rows.slice(0, 5);
      if (rows.length === 0) {
        fill(target, type === 'rating' ? placingRows(data) : el('li', { class: 'empty', text: 'Nobody has played yet.' }));
        return;
      }
      fill(target, rows.map((p) => el('li', {},
        el('span', { class: 'pos' }, place(p.position)),
        el('span', { class: 'who' }, nameLink(p, 22)),
        el('span', { class: 'val', text: type === 'rating' ? `${p.rating} rating` : `Lv ${p.level}` }))));
    } catch (error) { fill(target, el('li', { class: 'empty', text: error.message })); }
  }

  // An empty rating list (a season just started): who is closest to their placement rounds, or an invitation to be first.
  function placingRows(data) {
    const placing = data.placing || [];
    if (placing.length === 0) {
      return [el('li', { class: 'wide' }, el('b', { text: 'A new season has started.' }), `Play ${data.placementRounds} ranked rounds to be the first on the list.`)];
    }
    return [
      el('li', { class: 'wide' }, el('b', { text: 'A new season has started.' }), `Players join this list after ${data.placementRounds} ranked rounds. Closest so far:`),
      ...placing.map((p) => el('li', {},
        el('span', { class: 'pos', text: '' }),
        el('span', { class: 'who' }, nameLink(p, 22)),
        el('span', { class: 'val', text: `${p.rankedRounds}/${data.placementRounds} rounds` }))),
    ];
  }

  // ------------------------------------------------------------------------------------------ leaderboard + search

  function boardTable(rows, type, offsetStart) {
    const head = type === 'level'
      ? ['#', 'Player', 'Level', 'Title', 'XP']
      : ['#', 'Player', 'Rating', 'Wins', 'Losses', 'Win rate', 'K/D', 'Level'];
    const optional = type === 'level' ? [3] : [5, 6, 7];
    return el('div', { class: 'tbl board' }, el('table', {},
      el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: [i > 1 ? 'num' : '', optional.includes(i) ? 'opt' : ''].join(' ').trim() || null, scope: 'col', text: h })))),
      el('tbody', {}, rows.map((p, i) => el('tr', { class: type === 'rating' && (p.position ?? offsetStart + i + 1) <= VIP_PLACES ? 'vip' : null },
        el('td', {}, place(p.position ?? offsetStart + i + 1)),
        el('td', { class: 'player' }, nameLink(p)),
        ...(type === 'level'
          ? [el('td', { class: 'num', text: p.level }), el('td', { class: 'num opt' }, el('span', { class: titleClass(p.title), text: p.title })), el('td', { class: 'num', text: number(p.xp) })]
          : [el('td', { class: 'num', text: p.rating }), el('td', { class: 'num', text: p.wins }), el('td', { class: 'num', text: p.losses }),
             el('td', { class: 'num opt', text: winRate(p.wins, p.losses) }),
             el('td', { class: 'num opt', text: kd(p) }), el('td', { class: 'num opt' }, `Lv ${p.level}`)]))))));
  }

  async function leaderboardPage() {
    const params = new URLSearchParams(location.search);
    const type = params.get('type') === 'level' ? 'level' : 'rating';
    const q = (params.get('q') || '').trim();
    const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
    const board = $('board'), pager = $('pager'), input = $('q');
    if (input) input.value = q;
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (!q && a.dataset.type === type) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });

    if (q) {
      $('board-title').textContent = `Search: ${q}`;
      try {
        const data = await get(`/api/search?q=${encodeURIComponent(q)}`);
        if (data.rows.length === 0) fill(board, el('p', { class: 'box empty', text: q.length < 2 ? 'Type at least 2 letters.' : `No player found for "${q}".` }));
        else if (data.rows.length === 1 && data.rows[0].steamId && (data.rows[0].name.toLowerCase() === q.toLowerCase() || data.rows[0].steamId === q)) location.replace(`/player?id=${data.rows[0].steamId}`);
        else fill(board, el('div', { class: 'tbl board' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Player', 'Level', 'Rating', 'Wins · losses'].map((h, i) => el('th', { class: i ? 'num' : null, scope: 'col', text: h })))),
          el('tbody', {}, data.rows.map((p) => el('tr', {}, el('td', { class: 'player' }, nameLink(p), titleTag(p)),
            el('td', { class: 'num', text: p.level }), el('td', { class: 'num', text: p.rating }), el('td', { class: 'num', text: record(p) })))))));
      } catch (error) { problem(board, error); }
      fill(pager);
      return;
    }

    $('board-title').textContent = type === 'level' ? 'Top level · all time' : 'Top rating · this season';
    try {
      const data = await get(`/api/leaderboard?type=${type}&page=${page}`);
      if (data.rows.length === 0) {
        fill(board, type === 'rating' ? el('div', { class: 'box placing' }, el('ol', { class: 'mini' }, placingRows(data))) : el('p', { class: 'box empty', text: 'Nobody has played yet.' }));
      } else {
        fill(board, boardTable(data.rows, type, (page - 1) * data.perPage));
      }
      const pages = Math.max(1, Math.ceil(data.total / data.perPage));
      const link = (n, label) => el('a', { href: `/leaderboard?type=${type}&page=${n}`, text: label });
      if (data.total === 0) fill(pager); else fill(pager, page > 1 ? link(page - 1, '← Previous') : null, el('span', { text: `Page ${page} of ${pages} · ${number(data.total)} players` }), page < pages ? link(page + 1, 'Next →') : null);
      $('board-note').textContent = type === 'level'
        ? 'Levels never reset: this is everyone who has played, by total XP.'
        : `Rating starts at 1000 every month. A player shows up here after ${data.placementRounds} ranked rounds this season. The top 5 at the season end win VIP (blue line).`;
    } catch (error) { problem(board, error); }
  }

  // ------------------------------------------------------------------------------------------ weapons, maps, hit spread

  // The death event's weapon keys as players know them, with the kind of weapon. Unknown keys are shown as they come.
  const WEAPONS = {
    ak47: ['AK-47', 'Rifle'], m4a1: ['M4A4', 'Rifle'], m4a1_silencer: ['M4A1-S', 'Rifle'], galilar: ['Galil AR', 'Rifle'], famas: ['FAMAS', 'Rifle'],
    sg556: ['SG 553', 'Rifle'], aug: ['AUG', 'Rifle'], awp: ['AWP', 'Sniper'], ssg08: ['SSG 08', 'Sniper'], scar20: ['SCAR-20', 'Sniper'], g3sg1: ['G3SG1', 'Sniper'],
    deagle: ['Desert Eagle', 'Pistol'], revolver: ['R8 Revolver', 'Pistol'], glock: ['Glock-18', 'Pistol'], usp_silencer: ['USP-S', 'Pistol'], hkp2000: ['P2000', 'Pistol'],
    p250: ['P250', 'Pistol'], fiveseven: ['Five-SeveN', 'Pistol'], tec9: ['Tec-9', 'Pistol'], cz75a: ['CZ75-Auto', 'Pistol'], elite: ['Dual Berettas', 'Pistol'],
    mac10: ['MAC-10', 'SMG'], mp9: ['MP9', 'SMG'], mp7: ['MP7', 'SMG'], mp5sd: ['MP5-SD', 'SMG'], ump45: ['UMP-45', 'SMG'], p90: ['P90', 'SMG'], bizon: ['PP-Bizon', 'SMG'],
    nova: ['Nova', 'Shotgun'], xm1014: ['XM1014', 'Shotgun'], mag7: ['MAG-7', 'Shotgun'], sawedoff: ['Sawed-Off', 'Shotgun'],
    negev: ['Negev', 'Machine gun'], m249: ['M249', 'Machine gun'], knife: ['Knife', 'Melee'], taser: ['Zeus x27', 'Taser'],
    hegrenade: ['HE Grenade', 'Grenade'], inferno: ['Molotov', 'Grenade'],
  };
  const weaponInfo = (key) => WEAPONS[key] || [String(key).replace(/_/g, ' ').toUpperCase(), 'Weapon'];
  // "am_redline_shwdn" -> "Redline Shwdn": the usual arena prefixes off, words capitalised.
  const mapName = (map) => String(map).replace(/^(am|aim|awp|arena|1v1)_/i, '').split('_').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || map;
  const share = (part, total) => (total > 0 ? Math.round((100 * part) / total) : 0);

  // A small figure: head, body (with arms) and legs lit by how many of the hits landed there.
  function figure(head, body, legs, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const total = head + body + legs;
    const most = Math.max(head, body, legs, 1);
    const part = (tag, attrs, hits) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      node.setAttribute('class', total > 0 ? 'fig-part on' : 'fig-part');
      if (total > 0) node.style.opacity = String(0.22 + 0.78 * (hits / most));
      return node;
    };
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 96');
    svg.setAttribute('width', String(Math.round(size * 40 / 96)));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'figure');
    svg.append(
      part('circle', { cx: 20, cy: 9, r: 7.5 }, head),
      part('path', { d: 'M9 19h22l5 26-5 2-3-16v22H12V31l-3 16-5-2z' }, body),
      part('path', { d: 'M12 55h7l-1 39h-7zM21 55h7l1 39h-7z' }, legs));
    return svg;
  }

  function hitSpread(h) {
    const total = h.hitsHead + h.hitsBody + h.hitsLegs;
    const row = (label, hits) => el('div', { class: 'spread-row' },
      el('span', { class: 'k', text: label }), el('b', { text: `${share(hits, total)}%` }), el('span', { class: 's', text: `${number(hits)} hits` }));
    return el('div', { class: 'spread' }, figure(h.hitsHead, h.hitsBody, h.hitsLegs, 96),
      el('div', {}, row('Head', h.hitsHead), row('Body', h.hitsBody), row('Legs', h.hitsLegs)));
  }

  function weaponsTable(weapons) {
    if (!weapons || weapons.length === 0) return el('p', { class: 'note', text: 'No kills in a ranked round yet.' });
    return el('div', { class: 'tbl board weapons' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Weapon', 'Kills', 'Headshots', 'Hits head · body · legs'].map((h, i) => el('th', { class: [i ? 'num' : '', i === 3 ? 'opt' : ''].join(' ').trim() || null, scope: 'col', text: h })))),
      el('tbody', {}, weapons.map((w) => {
        const [name, kind] = weaponInfo(w.weapon);
        const total = w.hitsHead + w.hitsBody + w.hitsLegs;
        return el('tr', {},
          el('td', { class: 'player' }, el('b', { class: 'wname', text: name }), el('span', { class: 'alias', text: kind })),
          el('td', { class: 'num big', text: number(w.kills) }),
          el('td', { class: 'num', text: `${share(w.headshots, w.kills)}%` }),
          el('td', { class: 'num opt' }, el('span', { class: 'mini-spread' }, figure(w.hitsHead, w.hitsBody, w.hitsLegs, 34),
            total > 0 ? `${share(w.hitsHead, total)}% · ${share(w.hitsBody, total)}% · ${share(w.hitsLegs, total)}%` : '-')));
      }))));
  }

  function mapsList(maps) {
    if (!maps || maps.length === 0) return el('p', { class: 'note', text: 'No ranked rounds yet.' });
    return el('ul', { class: 'maps' }, maps.map((m) => {
      const rate = share(m.wins, m.wins + m.losses);
      return el('li', {},
        el('span', { class: 'map', text: mapName(m.map) }),
        el('span', { class: 'rate' }, el('b', { class: rate >= 60 ? 'good' : null, text: `${rate}%` }), el('small', { text: `${m.wins} W · ${m.losses} L` })),
        el('div', { class: 'bar' }, el('span', { style: `width:${rate}%` })));
    }));
  }

  // The round types as the game names them (K4's lang file); unknown ones from their key ("k4.rounds.xyz" -> "Xyz").
  const MODES = {
    'k4.rounds.rifle': 'Rifle', 'k4.rounds.pistol': 'Pistol only', 'k4.rounds.scout': 'Scout only', 'k4.rounds.sniper': 'Sniper',
    'k4.rounds.shotgun': 'Shotgun', 'k4.rounds.smg': 'SMG', 'k4.rounds.lmg': 'LMG', 'k4.rounds.awp': 'AWP only', 'k4.rounds.deagle': 'Deagle',
    'k4.rounds.knife': 'Knife only', 'k4.rounds.random': 'Random weapons',
  };
  const modeName = (mode) => MODES[mode] || (String(mode).split('.').pop() || mode).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  // Wins and losses per map or mode, best first by games played: name, win %, "12 W · 8 L" and a bar.
  function winList(items, nameOf, nameClass) {
    return el('ul', { class: 'maps' }, items.map((m) => {
      const rate = share(m.wins, m.wins + m.losses);
      return el('li', {},
        el('span', { class: nameClass, text: nameOf(m) }),
        el('span', { class: 'rate' }, el('b', { class: rate >= 60 ? 'good' : null, text: `${rate}%` }), el('small', { text: `${m.wins} W · ${m.losses} L` })),
        el('div', { class: 'bar' }, el('span', { style: `width:${rate}%` })));
    }));
  }

  // The season's rating as a line, one point per day played, with the peak marked. Plain SVG, no library.
  function ratingGraph(history, current) {
    const ns = 'http://www.w3.org/2000/svg';
    const points = (history || []).map((h) => ({ day: h.day, rating: h.rating }));
    if (points.length === 0) return el('p', { class: 'note', text: 'The graph starts with the first ranked round of the season.' });
    if (points.length === 1) points.unshift({ day: points[0].day, rating: points[0].rating });
    const W = 600, H = 150, pad = 8;
    const values = points.map((p) => p.rating);
    const low = Math.min(...values), high = Math.max(...values);
    const span = Math.max(20, high - low);
    const x = (i) => pad + (i * (W - 2 * pad)) / (points.length - 1);
    const y = (v) => H - pad - ((v - low) * (H - 2 * pad)) / span;
    const make = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = make('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph', preserveAspectRatio: 'none', role: 'img', 'aria-label': `Rating this season, from ${values[0]} to ${values[values.length - 1]}` });
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join(' ');
    svg.append(
      make('polygon', { points: `${x(0)},${H} ${line} ${x(points.length - 1)},${H}`, class: 'graph-fill' }),
      make('polyline', { points: line, class: 'graph-line' }));
    const peakIndex = values.lastIndexOf(high);
    svg.append(make('circle', { cx: x(peakIndex), cy: y(high), r: 4, class: 'graph-peak' }));
    const peak = Math.max(high, current || 0);
    return el('div', {},
      el('div', { class: 'graph-head' },
        el('span', {}, 'Peak ', el('b', { text: String(peak) })),
        el('span', {}, 'Now ', el('b', { text: String(current) })),
        el('span', { class: 'note', text: `${date(points[0].day)} – ${date(points[points.length - 1].day)}` })),
      svg);
  }

  // ------------------------------------------------------------------------------------------ player page

  async function playerPage(signedIn) {
    const id = new URLSearchParams(location.search).get('id') || '';
    const head = $('player-head'), body = $('player');
    try {
      const p = await get(`/api/player/${encodeURIComponent(id)}`);
      document.title = `${p.name} · Drexun Arena`;
      // A profile card: Steam avatar (when the website has Steam access), name, title, Steam name if it differs.
      const sameName = !p.steamName || p.steamName.trim().toLowerCase() === p.name.trim().toLowerCase();
      const isMe = (await signedIn)?.steamId === p.steamId;
      fill(head,
        el('div', { class: 'tag', text: isMe ? '[DX] YOUR PROFILE' : '[DX] PLAYER' }),
        el('div', { class: 'profile' },
          p.avatarFull ? el('img', { class: 'av big', src: p.avatarFull, alt: `${p.name}'s Steam avatar`, width: 112, height: 112, referrerpolicy: 'no-referrer' })
            : el('div', { class: 'av big blank', 'aria-hidden': 'true', text: (p.name || '?').trim().charAt(0).toUpperCase() }),
          el('div', {},
            el('h1', {}, el('span', { class: 'name', text: p.name })),
            el('p', { class: 'lede' }, 'Level ', String(p.level), ' ', el('span', { class: titleClass(p.title), text: p.title }),
              p.ratingPosition && p.ratingPosition <= VIP_PLACES ? ` · #${p.ratingPosition} this season` : ''),
            sameName ? null : el('p', { class: 'note' }, 'On Steam: ', el('span', { text: p.steamName })),
            el('p', { class: 'profile-links' },
              el('a', { class: 'btn ghost', href: `https://steamcommunity.com/profiles/${p.steamId}`, rel: 'noopener noreferrer', target: '_blank', text: 'Steam profile' })))),
        el('div', { class: 'meta' },
          el('span', {}, 'Joined ', el('b', { text: date(p.firstSeen) })),
          el('span', {}, 'Last played ', el('b', { text: dayName(p.lastSeen) }))));

      const levelSpan = Math.max(1, p.nextLevelXp - p.levelXp);
      const progress = Math.min(100, Math.max(0, Math.round((100 * (p.xp - p.levelXp)) / levelSpan)));
      const placed = p.rankedRounds >= p.placementRounds;
      const tile = (k, v, s, extra) => el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('div', { class: 'v' }, v), s ? el('div', { class: 's' }, s) : null, extra || null);
      const tiles = el('div', { class: 'tiles' },
        tile('Rating this season', String(p.rating), placed ? `#${p.ratingPosition} on the leaderboard` : `placement ${p.rankedRounds}/${p.placementRounds}`),
        tile('Ranked this season', el('span', {}, String(p.wins), el('small', { text: ' wins ' }), String(p.losses), el('small', { text: ' losses' })),
          `${winRate(p.wins, p.losses)} won · ${p.wins + p.losses} rounds`),
        tile('Level', String(p.level), `${number(p.xp - p.levelXp)} / ${number(levelSpan)} XP to level ${p.level + 1}`,
          el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('span', { style: `width:${progress}%` }))),
        tile('K/D', kd(p), `${number(p.kills)} kills · ${number(p.deaths)} deaths · ${hsPercent(p)} headshots`),
        tile('Damage / round', p.roundsTotal > 0 ? (p.damage / p.roundsTotal).toFixed(1) : '-', p.roundsTotal > 0 ? `${number(p.damage)} damage · ${number(p.roundsTotal)} ranked rounds` : 'after the first ranked round'),
        tile('Total XP', number(p.xp), p.levelPosition ? `#${p.levelPosition} by level, all time` : null));

      const seasons = p.seasons || [];
      const history = seasons.length === 0
        ? el('p', { class: 'note', text: 'No finished seasons yet.' })
        : el('div', { class: 'tbl board' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Season', 'Place', 'Rating', 'Wins', 'Losses'].map((h, i) => el('th', { class: i ? 'num' : null, scope: 'col', text: h })))),
          el('tbody', {}, seasons.map((s) => el('tr', {},
            el('td', { text: seasonName(s.season) }),
            el('td', { class: 'num' }, s.position ? place(s.position) : el('span', { class: 'note', text: 'in placement' })),
            el('td', { class: 'num', text: s.rating }),
            el('td', { class: 'num', text: s.wins }),
            el('td', { class: 'num', text: s.losses }))))));
      const hits = p.hitsHead + p.hitsBody + p.hitsLegs;
      fill(body, tiles,
        el('section', { class: 'box rating-box' }, el('h4', { text: 'Rating this season' }), ratingGraph(p.ratingHistory, p.rating)),
        el('div', { class: 'grid2 detail' },
          el('section', { class: 'box' }, el('h4', { text: 'Where your hits land' }),
            hits > 0 ? hitSpread(p) : el('p', { class: 'note', text: 'No hits recorded yet.' }),
            el('p', { class: 'note', text: 'Every hit on your opponent in ranked rounds, all time.' })),
          el('section', { class: 'box' }, el('h4', { text: 'Top maps' }), mapsList(p.maps),
            el('p', { class: 'note', text: 'Ranked rounds, all time.' })),
          el('section', { class: 'box' }, el('h4', { text: 'Top modes' }),
            p.modes && p.modes.length ? winList(p.modes, (m) => modeName(m.mode), 'mode-name') : el('p', { class: 'note', text: 'No ranked rounds yet.' }),
            el('p', { class: 'note', text: 'Ranked rounds, all time.' }))),
        el('section', { class: 'sec' }, el('h2', { text: 'Top weapons' }), weaponsTable(p.weapons)),
        el('section', { class: 'sec' }, el('h2', { text: 'Past seasons' }), history));
    } catch (error) {
      // Signed in but never played: say so, instead of "not found".
      const who = await signedIn;
      if (who && who.steamId === id) {
        fill(head, el('div', { class: 'tag', text: '[DX] YOUR PROFILE' }), el('h1', {}, el('span', { class: 'name', text: who.name })));
        fill(body, el('p', { class: 'box empty', text: 'You are signed in. Your stats show up here after your first ranked round on the server.' }),
          el('p', {}, el('a', { class: 'btn', href: 'steam://connect/drexun.ggwp.cc:25401', text: 'Join the server' })));
        return;
      }
      fill(head, el('div', { class: 'tag', text: '[DX] PLAYER' }), el('h1', { text: 'Player not found' }));
      fill(body, el('p', { class: 'box empty', text: `${error.message} Search by name on the leaderboard page.` }), el('p', {}, el('a', { class: 'btn', href: '/leaderboard', text: 'Leaderboard' })));
    }
  }

  // ------------------------------------------------------------------------------------------ hall of fame

  async function hallOfFamePage() {
    const target = $('hof');
    try {
      const data = await get('/api/halloffame');
      if (data.seasons.length === 0) { fill(target, el('p', { class: 'box empty', text: 'The first season has not ended yet.' })); return; }
      fill(target, data.seasons.map((s) => el('section', { class: 'season-block' },
        el('h3', { text: seasonName(s.season) }),
        el('div', { class: 'podium' }, s.finishers.map((f) => el('div', { class: `box ${f.position === 1 ? 'first' : ''}` },
          el('div', { class: 'place' }, `#${f.position} · ${f.position === 1 ? 'Champion' : 'VIP'}`),
          el('h4', {}, nameLink(f)),
          el('p', { class: 'note', text: `${f.rating} rating · ${f.wins} wins · ${f.losses} losses` })))))));
    } catch (error) { problem(target, error); }
  }

  // ------------------------------------------------------------------------------------------ Steam login

  // The nav's account slot: "Sign in with Steam", or the signed-in player's avatar + "My stats" and a sign-out button.
  // Returns who is signed in (or null) so a page can mark their own row.
  async function account() {
    const slot = $('account');
    let who = null;
    try { who = await get('/api/me'); } catch { return null; }
    if (!slot || !who || !who.signedIn) return null;
    // Avatar + name; a click opens a small menu (My stats, Sign out). A click anywhere else closes it again.
    const menu = el('details', { class: 'me-menu' },
      el('summary', { title: who.name },
        who.avatar ? el('img', { class: 'av', src: who.avatar, alt: '', width: 26, height: 26, referrerpolicy: 'no-referrer' })
          : el('span', { class: 'av letter', 'aria-hidden': 'true', style: 'width:26px;height:26px', text: (who.name || '?').charAt(0).toUpperCase() }),
        el('span', { class: 'who', text: who.name })),
      el('div', { class: 'menu' },
        el('a', { href: `/player?id=${encodeURIComponent(who.steamId)}`, text: 'My stats' }),
        el('form', { method: 'post', action: '/auth/logout' }, el('button', { type: 'submit', text: 'Sign out' }))));
    document.addEventListener('click', (event) => { if (!menu.contains(event.target)) menu.removeAttribute('open'); });
    fill(slot, menu);
    return who;
  }

  // The signed-in player's own rows (leaderboards, hall of fame) get a highlight.
  let mine = null;
  function markMine() {
    if (!mine) return;
    document.querySelectorAll(`a.pname[href="/player?id=${mine}"]`).forEach((a) => {
      const row = a.closest('tr, li, .box');
      if (row) row.classList.add('me');
    });
  }

  // A sign-in that went wrong comes back to the home page with ?signin=<what happened>.
  function signInNotice() {
    const message = new URLSearchParams(location.search).get('signin');
    const wrap = document.querySelector('.wrap');
    if (message && wrap) wrap.prepend(el('p', { class: 'box error', role: 'alert', text: message.slice(0, 160) }));
  }

  // ------------------------------------------------------------------------------------------ start

  if ($('server-status')) {
    serverStatus($('server-status'));
    setInterval(() => { if (!document.hidden) serverStatus($('server-status')); }, 60000);
  }
  // ------------------------------------------------------------------------------------------ motion
  // Owner, 2026-10-01: "modern feel like animation". Sections rise in when they scroll into view, numbers count up,
  // bars fill, table rows appear one after the other. Nothing of it for people who ask for reduced motion.
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');

  const seen = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); seen.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' })
    : null;
  function reveal(node) {
    if (!seen || calm || node.classList.contains('reveal')) return;
    node.classList.add('reveal');
    seen.observe(node);
  }
  document.querySelectorAll('.wrap > section.sec, .guide-cards .box, .grid2 > .box, .cmd-grid > div, ul.rules-short li, .site-footer').forEach(reveal);

  // "1169", "9,806", "1.47", "25%" count up from 0; anything else (words, records like "76 wins") is left alone.
  let statusCounted = false;   // the live status box redraws every minute: count up only the first time
  function countUp(node) {
    if (calm || node.dataset.counted || node.children.length) return;
    if (node.closest('#server-status')) { if (statusCounted) return; statusCounted = true; }
    const m = /^([\d,]*\.?\d+)(%?)$/.exec(node.textContent.trim());
    if (!m) return;
    node.dataset.counted = '1';
    const text = m[1], target = parseFloat(text.replace(/,/g, '')), decimals = (text.split('.')[1] || '').length, commas = text.includes(',');
    if (!(target > 0)) return;
    const start = performance.now(), ms = 900;
    const show = (v) => { node.textContent = (commas ? Math.round(v).toLocaleString('en-US') : v.toFixed(decimals)) + m[2]; };
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      show(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step); else show(target);
    };
    show(0);
    requestAnimationFrame(step);
    setTimeout(() => show(target), ms + 400);   // a background tab pauses animation frames: the real value always lands
  }

  // Bars (level progress, map win rates) fill from empty.
  function fillBar(span) {
    if (calm || span.dataset.filled) return;
    span.dataset.filled = '1';
    const width = span.style.width;
    span.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { span.style.width = width; }));
  }

  // Everything above also for what arrives later from the API (tiles, rows, lists).
  function animate(root) {
    root.querySelectorAll('.big-num, .tile .v, .spread-row b, ul.maps .rate b').forEach(countUp);
    root.querySelectorAll('.bar span').forEach(fillBar);
    root.querySelectorAll('.board tbody').forEach((body) => [...body.children].forEach((tr, i) => tr.style.setProperty('--i', String(Math.min(i, 30)))));
    root.querySelectorAll('.guide-cards .box, .grid2 > .box, .podium').forEach(reveal);
  }
  if (!calm && 'MutationObserver' in window) {
    new MutationObserver((changes) => changes.forEach((c) => c.addedNodes.forEach((n) => { if (n.nodeType === 1) animate(n.parentElement || n); })))
      .observe(document.body, { childList: true, subtree: true });
  }

  // Phones: the menu button (three lines) opens and closes the page links; a tap on a link or outside closes them.
  const nav = document.querySelector('.site-nav');
  const menuButton = document.querySelector('.menu-btn');
  if (nav && menuButton) {
    const setMenu = (open) => { nav.classList.toggle('open', open); menuButton.setAttribute('aria-expanded', String(open)); };
    menuButton.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
    nav.querySelectorAll('.site-links a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
    document.addEventListener('click', (event) => { if (!nav.contains(event.target)) setMenu(false); });
  }

  // Back to the top (bottom right), shown after scrolling down a bit.
  const toTop = el('button', { type: 'button', class: 'to-top', 'aria-label': 'Back to the top', title: 'Back to the top' });
  toTop.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M6 14l6-6 6 6"/></svg>';
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  document.body.append(toTop);
  const showToTop = () => toTop.classList.toggle('show', window.scrollY > 500);
  window.addEventListener('scroll', showToTop, { passive: true });
  showToTop();

  signInNotice();
  const signedIn = account().then((who) => { mine = who ? who.steamId : null; markMine(); return who; });
  if ($('top-rating')) miniBoard($('top-rating'), 'rating').then(markMine);
  if ($('top-level')) miniBoard($('top-level'), 'level').then(markMine);
  if ($('board')) leaderboardPage().then(markMine);
  if ($('player')) playerPage(signedIn);
  if ($('hof')) hallOfFamePage().then(markMine);
})();
