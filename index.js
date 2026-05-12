// AniStream API v4 - Direct AnimePahe scraper
// No Consumet dependency - scrapes AnimePahe directly
import express from 'express';

const app = express();
const PORT = process.env.PORT || 4000;
const PAHE_BASE = process.env.PAHE_BASE || 'https://animepahe.ru';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Shared headers for AnimePahe requests
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Referer': PAHE_BASE + '/',
  'Cookie': '__ddg2_=; __ddg1_=',
};

async function paheFetch(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { ...HEADERS, ...opts.headers },
    redirect: 'follow',
    ...opts,
  });
  if (!resp.ok) throw new Error(`AnimePahe returned ${resp.status} for ${url}`);
  return resp;
}

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', provider: 'AnimePahe', base: PAHE_BASE }));

// ─── Search AnimePahe ────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const resp = await paheFetch(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(q)}`);
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch {
      // Sometimes returns HTML instead of JSON (DDoS guard page)
      res.status(503).json({ error: 'AnimePahe returned a challenge page. The server may need a cookie refresh.', raw: text.substring(0, 200) });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get anime info page (scrape session from URL) ──────────────────────────
app.get('/api/anime/:session', async (req, res) => {
  try {
    const { session } = req.params;
    // Fetch the anime page to get metadata
    const resp = await paheFetch(`${PAHE_BASE}/anime/${session}`);
    const html = await resp.text();
    
    // Extract anime ID from the page (used for episode API)
    const idMatch = html.match(/let\s+id\s*=\s*(\d+)/);
    const titleMatch = html.match(/<h1><span>(.*?)<\/span>/);
    
    if (!idMatch) {
      return res.status(404).json({ error: 'Could not extract anime ID from page' });
    }
    
    res.json({
      session,
      id: parseInt(idMatch[1]),
      title: titleMatch ? titleMatch[1] : session,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get episodes (paginated) ────────────────────────────────────────────────
app.get('/api/episodes/:session', async (req, res) => {
  try {
    const { session } = req.params;
    const { page = 1, id } = req.query;
    
    // If no ID provided, fetch it from the anime page first
    let animeId = id;
    if (!animeId) {
      const pageResp = await paheFetch(`${PAHE_BASE}/anime/${session}`);
      const html = await pageResp.text();
      const idMatch = html.match(/let\s+id\s*=\s*(\d+)/);
      if (!idMatch) return res.status(404).json({ error: 'Could not find anime ID' });
      animeId = idMatch[1];
    }
    
    const resp = await paheFetch(`${PAHE_BASE}/api?m=release&id=${animeId}&sort=episode_asc&page=${page}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get all episodes (auto-paginate) ────────────────────────────────────────
app.get('/api/episodes/:session/all', async (req, res) => {
  try {
    const { session } = req.params;
    
    // Get anime ID
    const pageResp = await paheFetch(`${PAHE_BASE}/anime/${session}`);
    const html = await pageResp.text();
    const idMatch = html.match(/let\s+id\s*=\s*(\d+)/);
    if (!idMatch) return res.status(404).json({ error: 'Could not find anime ID' });
    const animeId = idMatch[1];
    
    // Fetch all pages
    let allEpisodes = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const resp = await paheFetch(`${PAHE_BASE}/api?m=release&id=${animeId}&sort=episode_asc&page=${page}`);
      const data = await resp.json();
      if (data.data) {
        allEpisodes = allEpisodes.concat(data.data);
      }
      hasMore = page < (data.last_page || 1);
      page++;
      if (page > 20) break; // Safety limit
    }
    
    res.json({ total: allEpisodes.length, episodes: allEpisodes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get streaming sources for an episode ────────────────────────────────────
app.get('/api/play/:animeSession/:episodeSession', async (req, res) => {
  try {
    const { animeSession, episodeSession } = req.params;
    
    // Fetch the play page
    const resp = await paheFetch(`${PAHE_BASE}/play/${animeSession}/${episodeSession}`);
    const html = await resp.text();
    
    // Extract Kwik URLs from the page
    // AnimePahe embeds multiple quality options as kwik.si/e/ URLs
    const kwikPattern = /href="(https:\/\/kwik\.[^"]+)"/g;
    const qualityPattern = /(\d+p)/g;
    
    // Find all download/stream buttons with quality labels
    const buttons = [];
    const buttonPattern = /data-src="(https:\/\/kwik\.[^"]+)"[^>]*>.*?(\d+p)/gs;
    let match;
    
    // Try the newer format first
    const srcPattern = /https:\/\/kwik\.\w+\/[ef]\/\w+/g;
    const kwikUrls = html.match(srcPattern) || [];
    
    // Also try to extract from the structured data
    const dataPattern = /"kwik":"(https:[^"]+)"/g;
    while ((match = dataPattern.exec(html)) !== null) {
      kwikUrls.push(match[1].replace(/\\\//g, '/'));
    }
    
    // Extract quality info
    const qualityInfo = [];
    const qlPattern = /(\d+)p.*?https:\/\/kwik/gs;
    
    // Parse the page for structured source data
    // AnimePahe typically has a JS object with sources
    const sourcePattern = /data-resolution="(\d+)"[^>]*data-src="([^"]+)"/g;
    while ((match = sourcePattern.exec(html)) !== null) {
      qualityInfo.push({ quality: match[1] + 'p', url: match[2] });
    }
    
    // Fallback: just grab all kwik URLs
    if (qualityInfo.length === 0 && kwikUrls.length > 0) {
      const unique = [...new Set(kwikUrls)];
      unique.forEach((url, i) => {
        qualityInfo.push({ quality: 'source_' + (i + 1), url });
      });
    }
    
    if (qualityInfo.length === 0) {
      // Return the raw HTML snippet for debugging
      const snippet = html.substring(html.indexOf('kwik') - 200, html.indexOf('kwik') + 500);
      return res.json({ sources: [], debug: 'No kwik URLs found', snippet: snippet.substring(0, 500) });
    }
    
    res.json({ sources: qualityInfo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Resolve Kwik URL to m3u8 ───────────────────────────────────────────────
app.get('/api/kwik', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    
    // Fetch the Kwik page
    const resp = await fetch(url, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': PAHE_BASE + '/',
      },
      redirect: 'follow',
    });
    const html = await resp.text();
    
    // Kwik uses obfuscated JS to hide the m3u8/mp4 URL
    // The pattern typically involves a packed/eval JS that contains the source URL
    
    // Try to find direct m3u8 or mp4 URL
    let sourceUrl = null;
    
    // Pattern 1: Direct m3u8 in source tag
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (m3u8Match) sourceUrl = m3u8Match[0];
    
    // Pattern 2: Direct mp4
    if (!sourceUrl) {
      const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (mp4Match) sourceUrl = mp4Match[0];
    }
    
    // Pattern 3: Packed JS eval - extract the URL from the obfuscated code
    if (!sourceUrl) {
      // Look for the eval(function(p,a,c,k,e,d) pattern
      const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}(?:\(.*?\))\)/s);
      if (evalMatch) {
        // Try to extract the source URL from the packed arguments
        // The URL is typically in the dictionary portion of the packed code
        const packedArgs = evalMatch[0];
        const urlInPacked = packedArgs.match(/https?:[\\\/]+[^'"\s]+\.(?:m3u8|mp4)[^'"\s|]*/);
        if (urlInPacked) {
          sourceUrl = urlInPacked[0].replace(/\\\//g, '/');
        }
      }
    }
    
    // Pattern 4: Look for the source in a form action or post data
    if (!sourceUrl) {
      const formMatch = html.match(/action="(https?:\/\/[^"]+)"/);
      if (formMatch) sourceUrl = formMatch[1];
    }
    
    if (sourceUrl) {
      res.json({ url: sourceUrl, type: sourceUrl.includes('.m3u8') ? 'hls' : 'mp4' });
    } else {
      // Return raw page for debugging
      res.json({ 
        url: null, 
        error: 'Could not extract stream URL from Kwik',
        pageLength: html.length,
        hasEval: html.includes('eval(function'),
        snippet: html.substring(0, 1000)
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── HLS/MP4 Proxy ──────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  try {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const headers = { 'User-Agent': HEADERS['User-Agent'] };
    if (referer) headers['Referer'] = referer;
    else headers['Referer'] = 'https://kwik.si/';
    
    const response = await fetch(url, { headers, redirect: 'follow' });
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

// ─── Map AniList title to AnimePahe session ──────────────────────────────────
app.get('/api/map', async (req, res) => {
  try {
    const { title, altTitle } = req.query;
    if (!title) return res.status(400).json({ error: 'title required' });
    
    const resp = await paheFetch(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(title)}`);
    const text = await resp.text();
    
    let data;
    try { data = JSON.parse(text); } 
    catch { return res.status(503).json({ error: 'Challenge page returned' }); }
    
    if (!data.data || !data.data.length) {
      // Try alt title
      if (altTitle && altTitle !== title) {
        const resp2 = await paheFetch(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(altTitle)}`);
        const text2 = await resp2.text();
        try { data = JSON.parse(text2); } catch { return res.status(503).json({ error: 'Challenge page' }); }
      }
    }
    
    if (!data.data || !data.data.length) {
      return res.json({ found: false, results: [] });
    }
    
    // Find best match
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const t1 = normalize(title);
    const t2 = altTitle ? normalize(altTitle) : '';
    
    let best = data.data[0]; // Default to first result
    for (const item of data.data) {
      const n = normalize(item.title);
      if (n === t1 || n === t2) { best = item; break; }
      if (n.includes(t1) || t1.includes(n)) { best = item; break; }
    }
    
    res.json({ found: true, anime: best });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Combined: AniList ID → search → episodes → sources (convenience) ───────
app.get('/api/watch-by-title', async (req, res) => {
  try {
    const { title, episode = 1 } = req.query;
    if (!title) return res.status(400).json({ error: 'title required' });
    
    // Step 1: Search
    const searchResp = await paheFetch(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(title)}`);
    const searchData = await searchResp.json();
    if (!searchData.data?.length) return res.status(404).json({ error: 'Anime not found' });
    
    const anime = searchData.data[0];
    
    // Step 2: Get anime page for ID
    const animeResp = await paheFetch(`${PAHE_BASE}/anime/${anime.session}`);
    const animeHtml = await animeResp.text();
    const idMatch = animeHtml.match(/let\s+id\s*=\s*(\d+)/);
    if (!idMatch) return res.status(500).json({ error: 'Could not get anime ID' });
    
    // Step 3: Get episodes
    const epResp = await paheFetch(`${PAHE_BASE}/api?m=release&id=${idMatch[1]}&sort=episode_asc&page=1`);
    const epData = await epResp.json();
    
    const ep = epData.data?.find(e => e.episode === parseInt(episode));
    if (!ep) return res.status(404).json({ error: `Episode ${episode} not found` });
    
    res.json({
      anime: { title: anime.title, session: anime.session, id: parseInt(idMatch[1]) },
      episode: ep,
      playUrl: `${PAHE_BASE}/play/${anime.session}/${ep.session}`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`\n  AniStream API v4 (AnimePahe) on port ${PORT}`);
  console.log(`  Base: ${PAHE_BASE}`);
  console.log(`  /api/health | /api/search?q= | /api/map?title=`);
  console.log(`  /api/episodes/:session/all | /api/play/:anime/:ep`);
  console.log(`  /api/kwik?url= | /api/proxy?url=\n`);
});
