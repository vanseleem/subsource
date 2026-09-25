'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const AdmZip  = require('adm-zip');
const app     = express();
const PORT    = process.env.PORT || 7860;

const BASE_URL = process.env.SPACE_HOST
  ? `https://${process.env.SPACE_HOST}`
  : `http://localhost:${PORT}`;

// ── TUNE THESE ───────────────────────────────────────────────────────────────
const MAX_SUBS_PER_LANG = 2;   // subtitles returned per language (1 = 1×EN + 1×AR)
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SUBSOURCE_KEY = process.env.SUBSOURCE_KEY || 'sk_18f87dd437b4ee7f4bb38805130b21158420077731184a42cea7094fb6a3cfd4';
const TMDB_KEY      = process.env.TMDB_KEY      || '30166e2db6b420d3f230808cd1bb2c90';

app.get('/', (req, res) => res.send('Van Subs v33 💡'));

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    id:          'org.van.humansubtitles',
    name:        'vansubs+ SSource',
    description: 'Pure logic subtitle engine. Arabic & English. No AI, no foreign langs.',
    version:     '34.0.0',
    resources:   ['subtitles'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tt'],
    catalogs:    []
  });
});

app.get('/subtitles/:type/:id.json',        (req, res) => handleRequest(req, res));
app.get('/subtitles/:type/:id/:extra.json', (req, res) => handleRequest(req, res));

app.get('/health', (req, res) => res.json({
  status:   'ok',
  version:  '34.0.0',
  cache:    cache.size,
  zips:     subStore.size,
  uptime:   Math.floor(process.uptime()) + 's',
  base_url: BASE_URL
}));

// ── In‑memory caches (unchanged) ─────────────────────────────────────────
const cache = new Map();
const TTL_MOVIE   = 7 * 24 * 60 * 60 * 1000;
const TTL_EPISODE = 8 * 60 * 60 * 1000;
function getTTL(type) { return type === 'series' ? TTL_EPISODE : TTL_MOVIE; }
function cacheKey(imdbId, type, season, episode) {
  return `${imdbId}|${type}|${season ?? 'x'}|${episode ?? 'x'}`;
}

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, v] of cache.entries()) { if (now - v.ts > v.ttl) { cache.delete(k); n++; } }
  if (n > 0) console.log(`[Cache] Evicted ${n} stale entries`);
}, 15 * 60 * 1000);

const subStore = new Map();
let   subSeq   = 0;

setInterval(() => {
  if (subStore.size > 500) {
    const keys = [...subStore.keys()].slice(0, 250);
    keys.forEach(k => subStore.delete(k));
    console.log('[ZipStore] Flushed 250 old entries');
  }
}, 30 * 60 * 1000);

// ── Helper functions from the original SubSource (unchanged) ──────────────
function seasonEpisodeFromFilename(filename) {
  if (!filename) return { season: null, episode: null };
  const n = filename.toLowerCase();
  const m1 = n.match(/s(\d{1,2})[\.\-_\s]?e(\d{1,3})/);
  if (m1) return { season: parseInt(m1[1], 10), episode: parseInt(m1[2], 10) };
  const m2 = n.match(/[._\-\s](\d{1,2})x(\d{1,3})[._\-\s]/);
  if (m2) return { season: parseInt(m2[1], 10), episode: parseInt(m2[2], 10) };
  return { season: null, episode: null };
}

// ── NEW: Foreign language signals (from SubDL) ─────────────────────────────
const FOREIGN_SIGNALS = [
  'italian','italiano','[ita]','(ita)','.ita.','-ita.','_ita.','.ita-','_ita_','-ita-',
  '.it.','-it.','_it.','[it]','(it)','it.srt','it.ass',
  ' ita.', ' ita ', ' ita-', ' ita_', '.ita ', '-ita ', '_ita ', 'ita.srt', 'ita.ass', 'ita.ssa', 'ita.vtt',
  'spanish','español','espanol','latino','castellano',
  '.es.','-es.','_es.','[es]','(es)','.spa.','-spa.','_spa.','.lat.','-lat.','_lat.','[lat]','(lat)',
  'french','français','francais','.fr.','-fr.','_fr.','.fre.','-fre.','_fre.',
  'portuguese','português','brazil','brasil','.pt.','-pt.','_pt.','.por.','-por.','_por.','.br.','-br.','_br.',
  'german','deutsch','.de.','-de.','_de.','.ger.','-ger.','_ger.',
  'turkish','türkçe','.tr.','-tr.','_tr.','.tur.','-tur.','_tur.',
  'russian','.ru.','-ru.','_ru.','.rus.','-rus.','_rus.',
  'chinese','.zh.','-zh.','_zh.','korean','.ko.','-ko.','_ko.',
  'hindi','.hi.','-hi.','_hi.',
  'dutch','nederlands','.nl.','-nl.','_nl.','.dut.','-dut.','_dut.','[nl]','(nl)',
];

function isForeignFilename(filename) {
  const n = (filename || '').toLowerCase();
  return FOREIGN_SIGNALS.some(s => n.includes(s));
}

// ── NEW: AI garbage / human verification (from SubDL) ──────────────────────
function isHumanVerified(filename) {
  const AI_GARBAGE = [
    'ai-translated','machine translation','chatgpt','translated from','auto-translated',
    'google translate','deepl','whisper','ai generated','machine-translated','openai',
    'gpt-4','gpt4','auto translate','ai.translated','aitranslated','autotranslated',
    'machine.translation','subscene-ai','opensubtitles-bot','mtranslated','mt.translated',
    'ai_translated','translated.by.ai','translated_by_ai',
  ];
  const n = (filename || '').toLowerCase();
  return !AI_GARBAGE.some(f => n.includes(f));
}

// ── NEW: Unwanted subtitle patterns (from SubDL) ────────────────────────────
const UNWANTED = [
  '.forced.','.forced_','_forced.','[forced]','(forced)',
  'en.forced','ar.forced','fr.forced','forced.sub',
  'commentary','director\'s cut','directors cut','director.cut',
  'extended','extended.cut','extended-cut','uncut','unrated',
  'remastered','restored','special.edition','special-edition','anniversary','criterion',
];
function isUnwantedSubtitle(filename) {
  const n = (filename || '').toLowerCase();
  return UNWANTED.some(f => n.includes(f));
}

// ── NEW: Advanced scoring (from SubDL) ──────────────────────────────────────
const FORMAT_TIERS = [
  { name: 'bluray', tags: ['bluray','blu-ray','bdrip','bdremux','remux'], pts: 17 },
  { name: 'web',    tags: ['webdl','web-dl','webrip','web-rip'], pts: 17 },
  { name: 'hdtv',   tags: ['hdtv','amzn','atvp','dsnp','nf','hulu'], pts: 13 },
  { name: 'dvd',    tags: ['dvdrip','hdrip','dvd'], pts: 9 },
];
function detectTier(text) {
  if (!text) return null;
  const n = text.toLowerCase();
  for (const t of FORMAT_TIERS) { if (t.tags.some(tag => n.includes(tag))) return t; }
  return null;
}

const SCENE_GROUPS = [
  'qxr','psa','galaxyrg','ntb','deflate','epsilon','tigole','framestor',
  'yts','yify','rarbg','fgt','amzn','flux','cm','tepes','heve','evo',
  'ion10','glhf','killers','playbd','mzabi','amiable','bstroke',
  'me7alh','raptor','d3g','rmteam','wdym','lama','mteam',
  'cinephiles','yawntic','terminal','esir',
];
function extractReleaseGroup(filename) {
  if (!filename) return null;
  let m = filename.match(/[-.]([a-zA-Z0-9_]{2,20})(?:\.\w{3})?$/);
  if (!m) m = filename.match(/\s[-–]\s([a-zA-Z0-9_]{2,20})(?:\.\w{3})?$/);
  if (!m) {
    const n = filename.toLowerCase();
    for (const g of SCENE_GROUPS) { if (n.includes(g)) return g; }
    return null;
  }
  return m[1].toLowerCase();
}

function normalizeRelease(name) {
  if (!name) return [];
  return name.toLowerCase()
    .replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
}

function scoreTrack(filename, streamTitle, rating = 0, season = null, episode = null, lang = null, contentType = null) {
  if (!filename) return 0;
  const n = filename.toLowerCase();
  const strmTokens = normalizeRelease(streamTitle || '');
  let s = 0;
  const isMovie = contentType === 'movie';

  // Episode matching (for series)
  if (season != null && episode != null) {
    const pat = `s${String(season).padStart(2,'0')}e${String(episode).padStart(2,'00')}`;
    if (n.includes(pat)) s += 500;
    else {
      const loose = `s${season}e${episode}`;
      if (loose !== pat && n.includes(loose)) s += 500;
    }
  }

  // Format tier matching
  const subTier  = detectTier(n);
  let   strmTier = detectTier(streamTitle || '');
  if (!strmTier && !streamTitle) strmTier = FORMAT_TIERS.find(t => t.name === 'web') || null;
  if (subTier) {
    if (strmTier) {
      s += subTier.name === strmTier.name ? subTier.pts * 2 : -120;
    } else {
      s += subTier.pts;
    }
  }

  // Release group matching
  const subGroup  = extractReleaseGroup(filename);
  const strmGroup = extractReleaseGroup(streamTitle || '');
  if (subGroup && strmGroup && subGroup === strmGroup)  s += 15;
  else if (subGroup && strmTokens.includes(subGroup)) s += 15;

  // Rating boost
  if (isMovie) {
    if (rating > 0) s += Math.round(rating * (lang === 'Arabic' ? 6 : 18));
  } else {
    if (rating > 0) s += Math.round(rating * 4);
  }

  // Year match from stream title
  if (streamTitle) {
    const m = streamTitle.match(/\b(19|20)\d{2}\b/);
    if (m && n.includes(m[0])) s += 50;
  }

  // Codec / resolution / audio bonuses (from SubDL)
  const VIDEO_CODECS = { x265: 8, x264: 7, hevc: 8, h265: 8, h264: 7 };
  const RESOLUTIONS  = { '2160p': 2, '4k': 2, 'uhd': 2, '1080p': 2, '720p': 1 };
  const AUDIO_CODECS = { 'truehd.atmos': 3, 'truehd': 2, 'atmos': 2, 'ddp5.1': 3, 'ddp5': 2, 'ddp': 1, 'dts-hd': 3, 'dts.hd': 3, 'dts': 2, 'ac3': 1, 'aac': 1, 'eac3': 2 };
  for (const [tag, pts] of Object.entries(VIDEO_CODECS)) { if (n.includes(tag)) { s += pts; break; } }
  for (const [tag, pts] of Object.entries(RESOLUTIONS))  { if (n.includes(tag)) { s += pts; break; } }
  for (const [tag, pts] of Object.entries(AUDIO_CODECS)) { if (n.includes(tag)) { s += pts; break; } }

  // Sync keywords
  const SYNC_BOOST   = ['sync','synced','corrected','fixed','updated','proper','repack','retail','remux','bd.sync','bluray.sync'];
  const SYNC_PENALTY = ['unsynced','unsync','rough','workprint','not.synced','not_synced','notsynced','raw.sub','raw_sub'];
  SYNC_BOOST.forEach(b   => { if (n.includes(b)) s += 30; });
  SYNC_PENALTY.forEach(p => { if (n.includes(p)) s -= 60; });

  // File extension preference (SRT is usually best)
  if (/\.srt$/i.test(filename)) s += 15;

  // Hearing impaired / SDH penalty
  if (/\b(sdh|hearing.impaired)\b/i.test(n)) s -= 20;

  return s;
}

// ── ZIP handling with foreign‑language filter (adapted from SubDL) ────────
function pickFileFromZip(zip, lang, season, episode) {
  let entries = zip.getEntries()
    .filter(e => !e.isDirectory)
    .filter(e => /\.(srt|ass|ssa|vtt)$/i.test(e.entryName))
    .filter(e => !isForeignFilename(e.entryName));   // <-- NEW: reject foreign files

  if (!entries.length) return null;

  if (season != null && episode != null) {
    const padded = `s${String(season).padStart(2,'0')}e${String(episode).padStart(2,'0')}`;
    const loose  = `s${season}e${episode}`;
    const exact  = entries.find(e => e.entryName.toLowerCase().includes(padded))
                || entries.find(e => e.entryName.toLowerCase().includes(loose));
    if (exact) return exact;
  }

  const hints = lang === 'Arabic'
    ? ['arabic','arab','.ar.','_ar_','.ara.','_ara_','ar.srt','ar.ass','-ar.','-ara.']
    : ['english','eng','.en.','_en_','.eng.','_eng_','en.srt','en.ass','-en.','-eng.'];
  const hinted = entries.find(e => hints.some(h => e.entryName.toLowerCase().includes(h)));
  if (hinted) return hinted;

  if (entries.length === 1) return entries[0];

  // Fallback: Arabic usually smallest, English largest
  return [...entries].sort((a, b) =>
    lang === 'Arabic' ? a.header.size - b.header.size : b.header.size - a.header.size
  )[0];
}

// ── SubSource‑specific download headers (unchanged) ────────────────────────
const DOWNLOAD_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/zip, application/octet-stream, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-API-Key':       SUBSOURCE_KEY,
  'Origin':          'https://subsource.net',
  'Referer':         'https://subsource.net/',
};

async function resolveUrl(rawUrl, lang, season, episode) {
  if (/\.(srt|ass|ssa|vtt)(\?|$)/i.test(rawUrl)) {
    return { url: rawUrl, extractedName: null };
  }

  async function downloadWithFallback(dlUrl) {
    let r = await safeFetch(dlUrl, { headers: DOWNLOAD_HEADERS }, 20000);
    if (r && r.ok) return r;
    const blocked = r && [429, 403, 503, 401].includes(r.status);
    if (!blocked) return r;
    const PROXIES = [
      `https://corsproxy.io/?url=${encodeURIComponent(dlUrl)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(dlUrl)}`,
      `https://thingproxy.freeboard.io/fetch/${dlUrl}`,
    ];
    for (const proxyUrl of PROXIES) {
      let host = proxyUrl;
      try { host = new URL(proxyUrl).hostname; } catch {}
      console.log(`[ZIP] Blocked (${r.status}) – retrying via ${host}`);
      await new Promise(resolve => setTimeout(resolve, 400));
      r = await safeFetch(proxyUrl, { headers: DOWNLOAD_HEADERS }, 15000);
      if (r && r.ok) return r;
    }
    return r;
  }

  try {
    const r = await downloadWithFallback(rawUrl);
    if (!r || !r.ok) {
      console.error(`[ZIP] HTTP ${r?.status || 'null'} – all attempts failed`);
      return null;
    }
    const buf  = await r.buffer();
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      console.log(`[ZIP] Not a ZIP (${buf.length}B), treating as direct subtitle`);
      return { url: rawUrl, extractedName: null };
    }
    const zip  = new AdmZip(buf);
    const best = pickFileFromZip(zip, lang, season, episode);
    if (!best) { console.error(`[ZIP] no subtitle file found in archive`); return null; }
    const ext = best.entryName.split('.').pop().toLowerCase();
    const id  = `s${++subSeq}`;
    subStore.set(id, { buffer: best.getData(), ext });
    console.log(`[ZIP] "${best.entryName}" (${best.header.size}B) lang=${lang} → /sub/${id}`);
    return { url: `${BASE_URL}/sub/${id}.${ext}`, extractedName: best.entryName };
  } catch (e) {
    console.error(`[ZIP] error: ${e.message}`);
    return null;
  }
}

app.get('/sub/:id', (req, res) => {
  const id   = req.params.id.replace(/\.[^.]+$/, '');
  const item = subStore.get(id);
  if (!item) return res.status(404).send('Not found');
  const mime = item.ext === 'vtt' ? 'text/vtt' : 'text/plain';
  res.setHeader('Content-Type', `${mime}; charset=utf-8`);
  res.setHeader('Content-Disposition', `inline; filename="sub.${item.ext}"`);
  res.send(item.buffer);
});

// ── Remaining SubSource API helpers (unchanged) ────────────────────────────
const ALLOWED_LANGS = new Set(['arabic', 'english']);
function isAllowedLanguage(lang) { return ALLOWED_LANGS.has((lang || '').toLowerCase().trim()); }

async function safeFetch(url, opts = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin':          'https://subsource.net',
    'Referer':         'https://subsource.net/',
    ...opts.headers,
  };
  try {
    const response = await fetch(url, { ...opts, headers, signal: controller.signal });
    if (!response.ok) console.error(`[Fetch] HTTP ${response.status} ${url}`);
    return response;
  } catch (e) {
    if (e.name === 'AbortError') console.error(`[Fetch] Timeout: ${url}`);
    else                         console.error(`[Fetch] Error: ${e.message} ${url}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SS_HEADERS = () => ({ 'X-API-Key': SUBSOURCE_KEY, 'Origin': 'https://subsource.net', 'Referer': 'https://subsource.net/' });

async function searchMovieByImdb(imdbId) {
  const url = `https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=${imdbId}`;
  const r = await safeFetch(url, { headers: SS_HEADERS() }, 12000);
  if (!r || !r.ok) return null;
  const data = await r.json();
  const movies = data.data || data.movies || (Array.isArray(data) ? data : []);
  if (!movies.length) return null;
  return movies[0].id || movies[0].movieId || movies[0].movie_id;
}

async function searchMovieByText(query) {
  const url = `https://api.subsource.net/api/v1/movies/search?searchType=text&q=${encodeURIComponent(query)}`;
  const r = await safeFetch(url, { headers: SS_HEADERS() }, 12000);
  if (!r || !r.ok) return null;
  const data = await r.json();
  const movies = data.data || data.movies || (Array.isArray(data) ? data : []);
  if (!movies.length) return null;
  return movies[0].id || movies[0].movieId || movies[0].movie_id;
}

async function fetchSubsForLang(movieId, langName, season, episode) {
  let url = `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=${langName}&per_page=50`;
  if (season  != null) url += `&season=${season}`;
  if (episode != null) url += `&episode=${episode}`;
  const r = await safeFetch(url, { headers: SS_HEADERS() }, 12000);
  if (!r || !r.ok) return [];
  const data = await r.json();
  return data.data || data.subtitles || [];
}

function normalizeSub(raw, lang) {
  const id = raw.subtitleId || raw.id || raw._id || raw.subtitle_id;
  if (!id) return null;
  let filename = raw.releaseInfo || raw.release_info || raw.filename || raw.release_name || raw.name || raw.title || '';
  if (typeof filename !== 'string') filename = String(filename);
  filename = filename.trim() || `SubSource-${id}`;
  return {
    filename,
    url:            `https://api.subsource.net/api/v1/subtitles/${id}/download`,
    lang,
    rating:         parseFloat(raw.rating) || 0,
    hearingImpaired: raw.hearingImpaired === true || raw.hearingImpaired === 'true' || false,
  };
}

// ── Updated fetchSubtitlesFromSubSource (still uses SubSource API) ─────────
async function fetchSubtitlesFromSubSource(imdbId, type, season, episode, streamTitle) {
  let movieId = await searchMovieByImdb(imdbId);
  if (!movieId && streamTitle) {
    const cleanTitle = streamTitle
      .replace(/[\s\.]S\d{1,2}E\d{1,3}.*$/i, '')
      .replace(/[\s\.]Season\s*\d+.*$/i, '')
      .replace(/\./g, ' ').trim();
    if (cleanTitle) movieId = await searchMovieByText(cleanTitle);
  }
  if (!movieId) { console.log(`║  [SS] Not found`); return { arabic: [], english: [] }; }

  const isEpisode = type === 'series' && season != null && episode != null;
  const tasks = isEpisode
    ? [
        { lang: 'Arabic',  name: 'arabic',  s: season, e: episode },
        { lang: 'Arabic',  name: 'arabic',  s: season, e: null    },
        { lang: 'English', name: 'english', s: season, e: episode },
        { lang: 'English', name: 'english', s: season, e: null    },
      ]
    : [
        { lang: 'Arabic',  name: 'arabic',  s: null, e: null },
        { lang: 'English', name: 'english', s: null, e: null },
      ];

  const results = await Promise.all(
    tasks.map(t => fetchSubsForLang(movieId, t.name, t.s, t.e)
      .then(raws => raws.map(r => normalizeSub(r, t.lang)).filter(Boolean))
    )
  );

  let arabic = [], english = [];
  if (isEpisode) {
    const [arEp, arPk, enEp, enPk] = results;
    const guard = (s) => passesEpisodeGuard(s.filename, season, episode);
    arabic  = dedup([...arEp.filter(guard), ...arPk.filter(guard)]);
    english = dedup([...enEp.filter(guard), ...enPk.filter(guard)]);
  } else {
    arabic  = dedup(results[0]);
    english = dedup(results[1]);
  }

  console.log(`║  [SS] AR=${arabic.length} EN=${english.length}`);
  return { arabic, english };
}

function passesEpisodeGuard(filename, targetSeason, targetEp) {
  const { season: fs, episode: fe } = seasonEpisodeFromFilename(filename);
  if (fs === null && fe === null) return true;
  if (fs !== null && fs !== targetSeason) return false;
  if (fe !== null && fe !== targetEp)     return false;
  return true;
}

function dedup(arr) {
  const seen = new Set();
  return arr.filter(s => {
    const key = (s.filename || '').toLowerCase().replace(/[\s.\-_]+/g, '.');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Main request handler – now uses the advanced filtering & scoring ───────
async function handleRequest(req, res) {
  const { type } = req.params;
  const rawId    = req.params.id.replace('.json', '');
  const extra    = req.params.extra ? decodeURIComponent(req.params.extra.replace('.json', '')) : '';
  const parts   = rawId.split(':');
  const imdbId  = parts[0];
  const season  = parts[1] ? parseInt(parts[1]) : null;
  const episode = parts[2] ? parseInt(parts[2]) : null;
  const filenameMatch = extra.match(/filename=([^&]+)/i);
  const streamTitle   = filenameMatch ? decodeURIComponent(filenameMatch[1]) : '';

  console.log(
    `\n╔═ [VanSubs v34] ${type.toUpperCase()} ${imdbId}` +
    (season != null ? ` S${String(season).padStart(2,'0')}E${String(episode ?? 0).padStart(2,'0')}` : '') +
    (streamTitle ? `\n║  hint: "${streamTitle}"` : '')
  );

  const ck  = cacheKey(imdbId, type, season, episode);
  const hit = cache.get(ck);
  if (hit && (Date.now() - hit.ts) < hit.ttl) {
    console.log(`╚═ ✅ Cache hit — ${hit.subtitles.length} tracks`);
    return res.json({ subtitles: hit.subtitles });
  }

  // Fetch raw subtitles
  let arabic = [], english = [];
  try {
    ({ arabic, english } = await fetchSubtitlesFromSubSource(imdbId, type, season, episode, streamTitle));
  } catch (e) { console.error(`║  [SS] FATAL: ${e.message}`); }

  // ── Apply the SubDL‑inspired filters ──────────────────────────────────────
  const filterAndDedup = (arr, lang) => {
    const seen = new Set();
    return arr.filter(s => {
      if (!s.filename || !s.url) return false;
      if (!isHumanVerified(s.filename))      { console.log(`║  [AI-DROP] "${s.filename}"`);      return false; }
      if (isForeignFilename(s.filename))     { console.log(`║  [FOREIGN-DROP] "${s.filename}"`); return false; }
      if (isUnwantedSubtitle(s.filename))    { console.log(`║  [UNWANTED-DROP] "${s.filename}"`);return false; }
      if (!isAllowedLanguage(lang))          return false;
      // dedup (in‑place)
      const key = s.filename.toLowerCase().replace(/[\s.\-_]+/g, '.');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  english = filterAndDedup(english, 'english');
  arabic  = filterAndDedup(arabic, 'arabic');

  // ── Score using the advanced function ─────────────────────────────────────
  const scoredEnglish = english.map(s => ({
    ...s,
    _score: scoreTrack(s.filename, streamTitle, s.rating, season, episode, 'english', type)
  })).sort((a, b) => b._score - a._score);

  const scoredArabic = arabic.map(s => ({
    ...s,
    _score: scoreTrack(s.filename, streamTitle, s.rating, season, episode, 'arabic', type)
  })).sort((a, b) => b._score - a._score);

  const topEnglish = scoredEnglish.slice(0, MAX_SUBS_PER_LANG);
  const topArabic  = scoredArabic.slice(0, MAX_SUBS_PER_LANG);

  // ── Resolve URLs (ZIP extraction, etc.) ────────────────────────────────────
  const resolveAll = async (arr) => {
    const out = await Promise.all(arr.map(async s => {
      const result = await resolveUrl(s.url, s.lang, season, episode);
      if (!result) return null;
      return { ...s, url: result.url, filename: result.extractedName || s.filename };
    }));
    return out.filter(Boolean);
  };

  const resEnglish = await resolveAll(topEnglish);
  const resArabic  = await resolveAll(topArabic);

  // ── Build final Stremio‑compatible list (English first, then Arabic) ──────
  const subtitles = [...resEnglish, ...resArabic].map((s, i) => ({
    id:   `van_${s.lang === 'Arabic' ? 'ar' : 'en'}_${imdbId}_${i}`,
    url:  s.url,
    lang: s.lang === 'Arabic' ? 'ara' : 'eng',
    name: `${s.lang === 'Arabic' ? '🇸🇦 Arabic' : '🇺🇸 English'} ${s.filename || ''}`.trim().substring(0, 100),
  }));

  cache.set(ck, { subtitles, ts: Date.now(), ttl: getTTL(type) });

  console.log(`║  ✅ ${subtitles.length} tracks (EN:${resEnglish.length} AR:${resArabic.length})`);
  resEnglish.forEach((s, i) => console.log(`║    EN[${i}] ${String(s._score).padStart(4)}pt  r=${s.rating.toFixed(1)}  "${s.filename}"`));
  resArabic.forEach((s, i)  => console.log(`║    AR[${i}] ${String(s._score).padStart(4)}pt  r=${s.rating.toFixed(1)}  "${s.filename}"`));
  console.log(`╚═ done`);
  res.json({ subtitles });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nVan Subs v34 — advanced engine — port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});