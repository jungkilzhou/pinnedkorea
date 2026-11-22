// PINNED KOREA — static site + /api/translate (Cloudflare Workers AI)
const CODES = { en: 'en', ko: 'ko', ja: 'ja', zh: 'zh', es: 'es' };
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

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
        const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: from, target_lang: to });
        const out = r && r.translated_text;
        if (!out) return json({ error: 'empty' }, 502);
        return json({ text: out });
      } catch (e) {
        return json({ error: 'translate failed' }, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
