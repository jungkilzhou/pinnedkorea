// PINNED KOREA — static site + /api/translate (Workers AI) + /api/board (Durable Object, SQLite)
import { DurableObject } from 'cloudflare:workers';
const CODES = { en: 'en', ko: 'ko', ja: 'ja', zh: 'zh', tw: 'tw', es: 'es' };
const NAMES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Simplified Chinese', tw: 'Traditional Chinese (Taiwan)', es: 'Spanish' };
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });



// ---- Korean place-name localisation (Revised Romanization fallback + Workers AI) ----
const RL = 'g kk n d tt r m b pp s ss  j jj ch k t p h'.split(' ');
const RV = 'a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i'.split(' ');
const RT = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'p', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const BRAND = [[/세븐일레븐/g, '7-Eleven'], [/이마트24/g, 'emart24'], [/미니스톱/g, 'Ministop'], [/씨유|CU/g, 'CU'], [/지에스25|GS25/g, 'GS25']];
function romanize(t) {
  let o = t;
  const keep = [];
  BRAND.forEach(([re, v], i) => { o = o.replace(re, () => { keep.push(v); return '\u0001' + (keep.length - 1) + '\u0002'; }); });
  o = o.replace(/지하/g, 'B').replace(/(\d)호선/g, 'Line $1').replace(/([가-힣]+)역/g, '$1 Stn.');
  let r = '';
  for (const ch of o) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const n = c - 0xac00, f = n % 28, v = ((n - f) / 28) % 21, l = Math.floor(n / 588);
      r += RL[l] + RV[v] + RT[f];
    } else r += ch;
  }
  r = r.replace(/\u0001(\d+)\u0002/g, (m, i) => ' ' + keep[+i] + ' ').replace(/\s+/g, ' ').trim();
  return r.replace(/(^|[\s(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
async function localize(env, ctx, items, lang) {
  if (lang === 'ko' || !NAMES[lang]) return items;
  items.forEach((d) => { d.o = d.n; d.n = romanize(d.n); d.a = romanize(d.a); });
  if (!env.AI) return items;
  try {
    const key = new Request('https://pk-cache.local/loc/' + lang + '/' + (await sha(items.map((d) => d.o + '|' + d.a).join('\n'))));
    const hit = await caches.default.match(key);
    let arr = hit ? await hit.json() : null;
    if (!arr) {
      const src = items.map((d) => ({ n: d.o, a: d.a }));
      const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You localize Korean place names and addresses for a foreign tourist. Target language: ' + NAMES[lang] + '. For each item return its name (n) and address (a) written so the tourist can read and say it: brand names in their international form (CU, GS25, 7-Eleven, emart24), station names as "<Name> Station Line N" in the target language, other names transliterated by sound (Japanese in katakana, Chinese in common Chinese usage, English/Spanish in Revised Romanization) with common words translated (e.g. restroom, police box). Keep numbers exact. Output ONLY a JSON array with the same length and order: [{"n":"...","a":"..."}].' },
          { role: 'user', content: JSON.stringify(src) },
        ],
        max_tokens: 1200, temperature: 0.1,
      });
      let resp = r && (r.response !== undefined ? r.response : r.result && r.result.response);
      if (typeof resp === 'string') { const m = resp.match(/\[[\s\S]*\]/); resp = m ? JSON.parse(m[0]) : null; }
      if (resp && !Array.isArray(resp) && typeof resp === 'object') resp = resp.items || resp.result || Object.values(resp).find(Array.isArray) || null;
      arr = Array.isArray(resp) ? resp : null;
      if (Array.isArray(arr) && arr.length === items.length) ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(arr), { headers: { 'cache-control': 'public, max-age=2592000' } })));
    }
    if (Array.isArray(arr) && arr.length === items.length) items.forEach((d, i) => { const x = arr[i] || {}; if (x.n && String(x.n).length < 80) d.n = String(x.n); if (x.a && String(x.a).length < 160) d.a = String(x.a); });
  } catch (e) { /* keep romanized */ }
  return items;
}

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const hasLink = (t) => /(https?:\/\/|www\.|\.(com|net|org|kr|io|co)\b)/i.test(t);
async function sha(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function notify(env, origin, kind, b) {
  const isPost = kind === 'post';
  const payload = {
    _subject: isPost ? '[PINNED KOREA] 새 글: ' + clip(b.place, 60) : '[PINNED KOREA] 새 답글 (글 #' + Number(b.postId) + ')',
    _template: 'box', _captcha: 'false',
    종류: isPost ? '새 글' : '새 답글',
    닉네임: clip(b.nick, 24) || 'Traveler',
    장소: isPost ? clip(b.place, 60) : '(글 #' + Number(b.postId) + ')',
    내용: clip(b.text, 600),
    시간: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    바로가기: origin + '/#sec-board',
  };
  try {
    await fetch('https://formsubmit.co/ajax/' + env.NOTIFY_EMAIL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin, referer: origin + '/' },
      body: JSON.stringify(payload),
    });
  } catch (e) { /* best-effort */ }
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT, place TEXT, body TEXT, ts INTEGER, th TEXT, likes INTEGER DEFAULT 0, reports INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS replies(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, nick TEXT, body TEXT, ts INTEGER, th TEXT, reports INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS votes(post_id INTEGER, voter TEXT, PRIMARY KEY(post_id, voter));
      CREATE TABLE IF NOT EXISTS rate(voter TEXT, ts INTEGER);`);
  }
  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  limited(voter) {
    const now = Date.now();
    this.sql.exec('DELETE FROM rate WHERE ts < ?', now - 600000);
    const n = this.rows('SELECT COUNT(*) c FROM rate WHERE voter=?', voter)[0].c;
    if (n >= 6) return true;
    this.sql.exec('INSERT INTO rate(voter, ts) VALUES(?,?)', voter, now);
    return false;
  }
  async fetch(req) {
    const u = new URL(req.url);
    const voter = req.headers.get('x-voter') || 'anon';
    if (u.pathname === '/list') {
      const top = u.searchParams.get('sort') === 'top';
      const posts = this.rows(`SELECT id,nick,place,body,ts,likes FROM posts WHERE reports<3 ORDER BY ${top ? 'likes DESC, ts DESC' : 'ts DESC'} LIMIT 60`);
      const ids = posts.map((p) => p.id);
      const rep = ids.length ? this.rows(`SELECT id,post_id,nick,body,ts FROM replies WHERE reports<3 AND post_id IN (${ids.join(',')}) ORDER BY ts ASC`) : [];
      const mine = new Set(this.rows('SELECT post_id FROM votes WHERE voter=?', voter).map((r) => r.post_id));
      posts.forEach((p) => { p.replies = rep.filter((r) => r.post_id === p.id); p.liked = mine.has(p.id); });
      return Response.json({ posts });
    }
    if (u.pathname === '/events') {
      const v = await this.ctx.storage.get('events');
      return v ? new Response(v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=1800' } }) : Response.json({ error: 'none' }, { status: 404 });
    }
    if (u.pathname === '/rank') {
      const v = await this.ctx.storage.get('rank');
      return v ? new Response(v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=1800' } }) : Response.json({ error: 'none' }, { status: 404 });
    }
    if (u.pathname === '/rank-set') { await this.ctx.storage.put('rank', await req.text()); return Response.json({ ok: true }); }
    if (u.pathname === '/events-set') { await this.ctx.storage.put('events', await req.text()); return Response.json({ ok: true }); }
    const b = await req.json().catch(() => ({}));
    if (u.pathname === '/post') {
      const nick = clip(b.nick, 24) || 'Traveler', place = clip(b.place, 60), body = clip(b.text, 600);
      if (!place || body.length < 4) return Response.json({ error: 'short' }, { status: 400 });
      if (hasLink(body) || hasLink(place) || hasLink(nick)) return Response.json({ error: 'link' }, { status: 400 });
      if (this.limited(voter)) return Response.json({ error: 'rate' }, { status: 429 });
      const token = crypto.randomUUID();
      const r = this.rows('INSERT INTO posts(nick,place,body,ts,th) VALUES(?,?,?,?,?) RETURNING id', nick, place, body, Date.now(), await sha(token));
      return Response.json({ id: r[0].id, token });
    }
    if (u.pathname === '/reply') {
      const nick = clip(b.nick, 24) || 'Traveler', body = clip(b.text, 400), pid = Number(b.postId);
      if (!pid || body.length < 2) return Response.json({ error: 'short' }, { status: 400 });
      if (hasLink(body) || hasLink(nick)) return Response.json({ error: 'link' }, { status: 400 });
      if (!this.rows('SELECT id FROM posts WHERE id=?', pid).length) return Response.json({ error: 'nopost' }, { status: 404 });
      if (this.limited(voter)) return Response.json({ error: 'rate' }, { status: 429 });
      const token = crypto.randomUUID();
      const r = this.rows('INSERT INTO replies(post_id,nick,body,ts,th) VALUES(?,?,?,?,?) RETURNING id', pid, nick, body, Date.now(), await sha(token));
      return Response.json({ id: r[0].id, token });
    }
    if (u.pathname === '/like') {
      const pid = Number(b.postId);
      if (!this.rows('SELECT id FROM posts WHERE id=?', pid).length) return Response.json({ error: 'nopost' }, { status: 404 });
      const had = this.rows('SELECT 1 x FROM votes WHERE post_id=? AND voter=?', pid, voter).length;
      if (had) { this.sql.exec('DELETE FROM votes WHERE post_id=? AND voter=?', pid, voter); this.sql.exec('UPDATE posts SET likes=MAX(0,likes-1) WHERE id=?', pid); }
      else { this.sql.exec('INSERT INTO votes(post_id,voter) VALUES(?,?)', pid, voter); this.sql.exec('UPDATE posts SET likes=likes+1 WHERE id=?', pid); }
      return Response.json({ liked: !had, likes: this.rows('SELECT likes FROM posts WHERE id=?', pid)[0].likes });
    }
    if (u.pathname === '/delete') {
      const tbl = b.kind === 'reply' ? 'replies' : 'posts', id = Number(b.id), h = await sha(String(b.token || ''));
      const r = this.rows(`SELECT id FROM ${tbl} WHERE id=? AND th=?`, id, h);
      if (!r.length) return Response.json({ error: 'forbidden' }, { status: 403 });
      this.sql.exec(`DELETE FROM ${tbl} WHERE id=?`, id);
      if (tbl === 'posts') { this.sql.exec('DELETE FROM replies WHERE post_id=?', id); this.sql.exec('DELETE FROM votes WHERE post_id=?', id); }
      return Response.json({ ok: true });
    }
    if (u.pathname === '/report') {
      const tbl = b.kind === 'reply' ? 'replies' : 'posts';
      this.sql.exec(`UPDATE ${tbl} SET reports=reports+1 WHERE id=?`, Number(b.id));
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

const RC = { 11: 'seoul', 26: 'busan', 27: 'daegu', 28: 'incheon', 29: 'gwangju', 30: 'daejeon', 31: 'ulsan', 36: 'chungnam', 41: 'gyeonggi', 43: 'chungbuk', 44: 'chungnam', 46: 'jeonnam', 47: 'gyeongbuk', 48: 'gyeongnam', 50: 'jeju', 51: 'gangwon', 42: 'gangwon', 52: 'jeonbuk', 45: 'jeonbuk' };
const RXY = { seoul: [37.56, 126.99], gyeonggi: [37.45, 127.45], incheon: [37.45, 126.55], gangwon: [37.75, 128.3], chungbuk: [36.75, 127.8], chungnam: [36.5, 126.85], daejeon: [36.35, 127.4], gyeongbuk: [36.55, 128.8], daegu: [35.87, 128.6], gyeongnam: [35.4, 128.2], busan: [35.14, 129.05], ulsan: [35.55, 129.3], jeonbuk: [35.75, 127.15], jeonnam: [34.95, 126.95], gwangju: [35.16, 126.85], jeju: [33.38, 126.55] };
// Pull festivals from KTO TourAPI (EngService2) and keep them in the Board DO. Needs the TOUR_KEY secret.
async function refreshEvents(env) {
  if (!env.TOUR_KEY) return { ok: false, why: 'no TOUR_KEY' };
  const d = new Date(Date.now() + 9 * 3600e3), ymd = (x) => x.toISOString().slice(0, 10).replace(/-/g, '');
  const start = ymd(d), cut = ymd(new Date(d.getTime() + 400 * 864e5));
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const r = await fetch('https://apis.data.go.kr/B551011/EngService2/searchFestival2?serviceKey=' + encodeURIComponent(env.TOUR_KEY) + '&MobileOS=ETC&MobileApp=PinnedKorea&_type=json&numOfRows=100&pageNo=' + p + '&arrange=A&eventStartDate=' + start);
    if (!r.ok) return { ok: false, why: 'http ' + r.status };
    const j = await r.json(), bd = j.response && j.response.body, it = bd && bd.items && bd.items.item;
    if (!it) break;
    for (const x of it) {
      const la = parseFloat(x.mapy), lo = parseFloat(x.mapx);
      if (!(la > 0) || !(lo > 0) || x.eventenddate < start || x.eventstartdate > cut) continue;
      let reg = RC[String(x.lDongRegnCd || '')];
      if (!reg) reg = Object.keys(RXY).sort((a, b) => ((RXY[a][0] - la) ** 2 + (RXY[a][1] - lo) ** 2) - ((RXY[b][0] - la) ** 2 + (RXY[b][1] - lo) ** 2))[0];
      out.push({ id: x.contentid, t: String(x.title || '').trim(), s: x.eventstartdate, e: x.eventenddate, r: reg, la: +la.toFixed(4), lo: +lo.toFixed(4), a: String(x.addr1 || '').trim(), i: String(x.firstimage || '').replace('http://', 'https://') });
    }
    if (p * 100 >= bd.totalCount) break;
  }
  if (!out.length) return { ok: false, why: 'empty' };
  out.sort((a, b) => (a.s + a.t).localeCompare(b.s + b.t));
  const stub = env.BOARD.get(env.BOARD.idFromName('main'));
  await stub.fetch('https://board/events-set', { method: 'POST', body: JSON.stringify({ upd: d.toISOString().slice(0, 19) + '+09:00', ev: out }) });
  return { ok: true, n: out.length };
}

const SIDO = { 11: '서울', 26: '부산', 27: '대구', 28: '인천', 29: '광주', 30: '대전', 31: '울산', 36: '세종', 41: '경기', 42: '강원', 51: '강원', 43: '충북', 44: '충남', 45: '전북', 52: '전북', 46: '전남', 47: '경북', 48: '경남', 50: '제주' };
// Foreign visitors by district (KTO DataLab, mobile-network based). Data lags ~1 month, so find the latest available day first.
async function refreshRank(env) {
  if (!env.TOUR_KEY) return { ok: false, why: 'no TOUR_KEY' };
  const base = 'https://apis.data.go.kr/B551011/DataLabService/locgoRegnVisitrDDList?serviceKey=' + encodeURIComponent(env.TOUR_KEY) + '&MobileOS=ETC&MobileApp=PinnedKorea&_type=json';
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const cnt = async (s, e, rows, page) => {
    const r = await fetch(base + '&numOfRows=' + rows + '&pageNo=' + page + '&startYmd=' + s + '&endYmd=' + e);
    if (!r.ok) throw new Error('http ' + r.status);
    return (await r.json()).response.body;
  };
  const now = new Date(Date.now() + 9 * 3600e3);
  let probe = null;
  for (let k = 3; k <= 70 && !probe; k += 7) { const d = new Date(now.getTime() - k * 864e5); if ((await cnt(fmt(d), fmt(d), 1, 1)).totalCount > 0) probe = d; }
  if (!probe) return { ok: false, why: 'no data' };
  let last = probe;
  for (let k = 1; k <= 6; k++) { const d = new Date(probe.getTime() + k * 864e5); if (d > now) break; if ((await cnt(fmt(d), fmt(d), 1, 1)).totalCount > 0) last = d; }
  const first = new Date(last.getTime() - 13 * 864e5), tot = {};
  for (let p = 1; p <= 20; p++) {
    const b = await cnt(fmt(first), fmt(last), 1000, p), it = b.items && b.items.item;
    if (!it) break;
    for (const x of it) if (x.touDivCd === '3') { const o = (tot[x.signguCode] = tot[x.signguCode] || { n: x.signguNm, v: 0 }); o.v += parseFloat(x.touNum) || 0; }
    if (p * 1000 >= b.totalCount) break;
  }
  const top = Object.entries(tot).sort((a, b) => b[1].v - a[1].v).slice(0, 12).map(([c, o]) => ({ c, n: (SIDO[c.slice(0, 2)] || '') + ' ' + o.n, v: Math.round(o.v / 14) }));
  if (!top.length) return { ok: false, why: 'empty' };
  const stub = env.BOARD.get(env.BOARD.idFromName('main'));
  await stub.fetch('https://board/rank-set', { method: 'POST', body: JSON.stringify({ from: fmt(first), to: fmt(last), days: 14, top }) });
  return { ok: true, to: fmt(last) };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/translate') {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      const origin = req.headers.get('Origin');
      if (origin) { try { if (new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403); } catch (e) { return json({ error: 'forbidden' }, 403); } }
      let b;
      try { b = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const text = String((b && b.text) || '').trim().slice(0, 400);
      const from = CODES[b && b.from], to = CODES[b && b.to];
      if (!text || !from || !to) return json({ error: 'bad request' }, 400);
      if (from === to) return json({ text });
      try {
        let out = '';
        try {
          const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You are a professional live interpreter helping a traveler in Korea. Translate the user message from ' + NAMES[from] + ' to ' + NAMES[to] + '. Use natural, polite, spoken language that a native speaker would actually say. Keep names, numbers and addresses exact. Output ONLY the translation, with no quotes, notes or explanations.' },
              { role: 'user', content: text },
            ],
            max_tokens: 300,
            temperature: 0.2,
          });
          out = String((r && (r.response || (r.result && r.result.response))) || '').trim();
        } catch (e) { out = ''; }
        if (!out) {
          const m = (c) => (c === 'tw' ? 'zh' : c);
          const r2 = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: m(from), target_lang: m(to) });
          out = (r2 && r2.translated_text) || '';
        }
        if (!out) return json({ error: 'empty' }, 502);
        return json({ text: out });
      } catch (e) {
        return json({ error: 'translate failed' }, 502);
      }
    }
    if (url.pathname === '/api/stores') {
      const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
      if (!(lat > 32 && lat < 39) || !(lon > 124 && lon < 132)) return json({ error: 'bad' }, 400);
      if (!env.KAKAO_KEY) return json({ ok: false, reason: 'nokey' });
      try {
        const out = [];
        for (const pg of [1, 2]) {
          const r = await fetch('https://dapi.kakao.com/v2/local/search/category.json?category_group_code=CS2&radius=1500&sort=distance&size=15&page=' + pg + '&x=' + lon.toFixed(5) + '&y=' + lat.toFixed(5), { headers: { Authorization: 'KakaoAK ' + env.KAKAO_KEY }, cf: { cacheTtl: 86400, cacheEverything: true } });
          if (!r.ok) return json({ ok: false, reason: 'upstream' }, 502);
          const j = await r.json();
          for (const d of j.documents || []) out.push({ id: d.id, n: d.place_name, x: +d.x, y: +d.y, a: d.road_address_name || d.address_name || '', p: d.phone || '', e: romanize(d.place_name) });
          if (!j.meta || j.meta.is_end) break;
        }
        return new Response(JSON.stringify({ ok: true, items: out }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' } });
      } catch (err) { return json({ ok: false, reason: 'fail' }, 502); }
    }
    if (url.pathname === '/api/near') {
      const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon')), k = url.searchParams.get('k') || '', lg = url.searchParams.get('l') || 'ko';
      const Q = { cs: ['c', 'CS2'], subway: ['c', 'SW8'], cafe: ['c', 'CE7'], wc: ['k', '화장실'], taxi: ['k', '택시승강장'], bus: ['k', '버스정류장'] }[k];
      if (!Q || !(lat > 32 && lat < 39) || !(lon > 124 && lon < 132)) return json({ error: 'bad' }, 400);
      if (!env.KAKAO_KEY) return json({ ok: false, reason: 'nokey' });
      try {
        const base = Q[0] === 'c' ? 'https://dapi.kakao.com/v2/local/search/category.json?category_group_code=' + Q[1] : 'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(Q[1]);
        const r = await fetch(base + '&radius=' + (k === 'subway' || k === 'taxi' ? 3000 : 1500) + '&sort=distance&size=15&x=' + lon.toFixed(4) + '&y=' + lat.toFixed(4), { headers: { Authorization: 'KakaoAK ' + env.KAKAO_KEY }, cf: { cacheTtl: 3600, cacheEverything: true } });
        if (!r.ok) return json({ ok: false, reason: 'upstream' }, 502);
        const j = await r.json();
        const items = (j.documents || []).filter((d) => k !== 'wc' || /화장실/.test(d.place_name + ' ' + d.category_name)).slice(0, k === 'wc' ? 10 : 8).map((d) => ({ id: d.id, n: d.place_name, x: +d.x, y: +d.y, a: d.road_address_name || d.address_name || '', m: +d.distance || 0, p: d.phone || '' }));
        await localize(env, ctx, items, lg);
        return new Response(JSON.stringify({ ok: true, items }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' } });
      } catch (err) { return json({ ok: false, reason: 'fail' }, 502); }
    }
    if (url.pathname === '/api/weather') {
      const f = (k) => parseFloat(url.searchParams.get(k));
      const lat = f('lat'), lon = f('lon'), s = url.searchParams.get('s') || '', e = url.searchParams.get('e') || '';
      if (!(lat > 32 && lat < 39) || !(lon > 124 && lon < 132) || !/^\d{4}-\d\d-\d\d$/.test(s) || !/^\d{4}-\d\d-\d\d$/.test(e)) return json({ error: 'bad' }, 400);
      try {
        const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + lat.toFixed(2) + '&lon=' + lon.toFixed(2), { headers: { 'user-agent': 'PinnedKorea/1.0 (+https://pinnedkorea.autoboxtv.workers.dev)' }, cf: { cacheTtl: 3600, cacheEverything: true } });
        if (!r.ok) return json({ error: 'upstream' }, 502);
        const j = await r.json();
        const ts = (j.properties && j.properties.timeseries) || [];
        const day = {};
        for (const t of ts) {
          const d = new Date(new Date(t.time).getTime() + 9 * 3600e3), key = d.toISOString().slice(0, 10);
          if (key < s || key > e) continue;
          const o = (day[key] = day[key] || { mx: -99, mn: 99, p: 0, sn: 0 });
          const T = t.data.instant.details.air_temperature;
          if (T > o.mx) o.mx = T; if (T < o.mn) o.mn = T;
          const n6 = t.data.next_6_hours;
          if (n6 && new Date(t.time).getUTCHours() % 6 === 0) {
            o.p += (n6.details && n6.details.precipitation_amount) || 0;
            if (/snow|sleet/.test(n6.summary.symbol_code || '')) o.sn += 1;
          }
        }
        const keys = Object.keys(day).sort();
        if (!keys.length) return json({ error: 'range' }, 502);
        return new Response(JSON.stringify({ time: keys, temperature_2m_max: keys.map((k) => day[k].mx), temperature_2m_min: keys.map((k) => day[k].mn), precipitation_sum: keys.map((k) => day[k].p), snowfall_sum: keys.map((k) => (day[k].sn ? 1 : 0)), src: 'MET Norway' }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
      } catch (err) { return json({ error: 'fail' }, 502); }
    }
    if (url.pathname === '/api/rank') {
      const stub = env.BOARD.get(env.BOARD.idFromName('main'));
      const r = await stub.fetch('https://board/rank');
      if (r.ok) return r;
      return env.ASSETS.fetch(new Request(url.origin + '/rank.json'));
    }
    if (url.pathname === '/api/events') {
      const stub = env.BOARD.get(env.BOARD.idFromName('main'));
      const r = await stub.fetch('https://board/events');
      if (r.ok) return r;
      return env.ASSETS.fetch(new Request(url.origin + '/events.json'));
    }
    if (url.pathname === '/api/events-refresh' && req.method === 'POST' && env.REFRESH_TOKEN && req.headers.get('x-token') === env.REFRESH_TOKEN) {
      return json({ events: await refreshEvents(env), rank: await refreshRank(env).catch((e) => ({ ok: false, why: String(e) })) });
    }
    if (url.pathname.startsWith('/api/board')) {
      const origin = req.headers.get('Origin');
      if (req.method !== 'GET') {
        if (!origin) return json({ error: 'forbidden' }, 403);
        try { if (new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403); } catch (e) { return json({ error: 'forbidden' }, 403); }
      }
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const voter = await sha('pk|' + ip);
      const stub = env.BOARD.get(env.BOARD.idFromName('main'));
      const sub = url.pathname.replace('/api/board', '') || '/list';
      const raw = req.method === 'GET' ? undefined : await req.text();
      const r = await stub.fetch('https://board' + sub + url.search, { method: req.method === 'GET' ? 'GET' : 'POST', headers: { 'x-voter': voter, 'content-type': 'application/json' }, body: raw });
      if (r.ok && (sub === '/post' || sub === '/reply') && env.NOTIFY_EMAIL) {
        let b = {}; try { b = JSON.parse(raw); } catch (e) {}
        ctx.waitUntil(notify(env, url.origin, sub === '/post' ? 'post' : 'reply', b));
      }
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(Promise.all([refreshEvents(env), refreshRank(env)])); },
};
