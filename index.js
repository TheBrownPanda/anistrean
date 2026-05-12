import express from 'express';
import { META, ANIME } from '@consumet/extensions';

const app = express();
const PORT = process.env.PORT || 4000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const PROVIDER_LIST = [
  { name: 'AnimeKai', create: () => new ANIME.AnimeKai() },
  { name: 'AnimePahe', create: () => new ANIME.AnimePahe() },
  { name: 'KickAssAnime', create: () => new ANIME.KickAssAnime() },
  { name: 'Hianime', create: () => new ANIME.Hianime() },
];

let currentProviderIdx = 0, anilist = null, providerName = '';

function initProvider(idx) {
  if (idx >= PROVIDER_LIST.length) idx = 0;
  currentProviderIdx = idx;
  const entry = PROVIDER_LIST[idx];
  try {
    anilist = new META.Anilist(entry.create());
    providerName = entry.name;
    console.log('Active provider:', providerName);
  } catch (err) {
    console.error('Failed:', entry.name, err.message);
    if (idx + 1 < PROVIDER_LIST.length) initProvider(idx + 1);
  }
}

async function withFallback(fn) {
  const start = currentProviderIdx;
  for (let i = 0; i < PROVIDER_LIST.length; i++) {
    const idx = (start + i) % PROVIDER_LIST.length;
    if (i > 0) initProvider(idx);
    try { return await fn(anilist); }
    catch (err) {
      console.warn(PROVIDER_LIST[idx].name, 'failed:', err.message);
      if (i === PROVIDER_LIST.length - 1) throw err;
    }
  }
}

initProvider(0);

app.get('/api/health', (_, res) => res.json({ status: 'ok', provider: providerName }));

app.get('/api/provider', (req, res) => {
  const { name } = req.query;
  if (name) {
    const idx = PROVIDER_LIST.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) { initProvider(idx); return res.json({ provider: providerName }); }
    return res.status(400).json({ error: 'Unknown. Available: ' + PROVIDER_LIST.map(p => p.name).join(', ') });
  }
  res.json({ current: providerName, available: PROVIDER_LIST.map(p => p.name) });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    res.json(await anilist.search(q, Number(page)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/info/:id', async (req, res) => {
  try {
    const { dub = 'false' } = req.query;
    res.json(await withFallback(al => al.fetchAnimeInfo(req.params.id, dub === 'true')));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WATCH endpoint - extract episode ID from the raw URL to preserve $ and = chars
app.use('/api/watch', async (req, res) => {
  try {
    // Extract everything after /api/watch/
    const fullPath = req.originalUrl;
    const prefix = '/api/watch/';
    const idx = fullPath.indexOf(prefix);
    if (idx === -1) return res.status(400).json({ error: 'Invalid request' });
    let epId = fullPath.substring(idx + prefix.length);
    // Remove any query string
    const qIdx = epId.indexOf('?');
    if (qIdx !== -1) epId = epId.substring(0, qIdx);
    // Decode URI components (in case frontend encoded the $)
    epId = decodeURIComponent(epId);
    if (!epId) return res.status(400).json({ error: 'Episode ID required' });
    console.log('Watch request for episode:', epId);
    const data = await withFallback(al => al.fetchEpisodeSources(epId));
    res.json(data);
  } catch (err) {
    console.error('Watch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers/*', async (req, res) => {
  try {
    const epId = decodeURIComponent(req.originalUrl.replace('/api/servers/', '').split('?')[0]);
    res.json(await withFallback(al => al.fetchEpisodeServers(epId)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trending', async (req, res) => {
  try { res.json(await anilist.fetchTrendingAnime(Number(req.query.page||1), Number(req.query.perPage||20))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/recent', async (req, res) => {
  try { res.json(await anilist.fetchRecentEpisodes(undefined, Number(req.query.page||1), Number(req.query.perPage||20))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/popular', async (req, res) => {
  try { res.json(await anilist.fetchPopularAnime(Number(req.query.page||1), Number(req.query.perPage||20))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/proxy', async (req, res) => {
  try {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    if (referer) headers['Referer'] = referer;
    const response = await fetch(url, { headers });
    const ct = response.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (ct?.includes('mpegurl') || url.endsWith('.m3u8')) {
      let text = await response.text();
      const base = url.substring(0, url.lastIndexOf('/') + 1);
      text = text.replace(/^(?!#)(.+\.(ts|m3u8|key).*)$/gm, m => {
        const abs = m.startsWith('http') ? m : base + m;
        return '/api/proxy?url=' + encodeURIComponent(abs);
      });
      res.send(text);
    } else {
      res.send(Buffer.from(await response.arrayBuffer()));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log('\n  AniStream API v3.1 on port ' + PORT);
  console.log('  /api/health | /api/info/:id | /api/watch/{epId}\n');
});
