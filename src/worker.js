// PINNED KOREA — static site + /api/translate (Workers AI) + /api/board (Durable Object, SQLite)
import { DurableObject } from 'cloudflare:workers';
const CODES = { en: 'en', ko: 'ko', ja: 'ja', zh: 'zh', tw: 'tw', es: 'es' };
const NAMES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Simplified Chinese', tw: 'Traditional Chinese (Taiwan)', es: 'Spanish' };
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });


const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const hasLink = (t) => /(https?:\/\/|www\.|\.(com|net|org|kr|io|co)\b)/i.test(t);
async function sha(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
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

export default {
  async fetch(req, env) {
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
      const r = await stub.fetch('https://board' + sub + url.search, { method: req.method === 'GET' ? 'GET' : 'POST', headers: { 'x-voter': voter, 'content-type': 'application/json' }, body: req.method === 'GET' ? undefined : await req.text() });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
};
