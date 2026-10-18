require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

// Names shown on the intro screen. Edit here, or set DEVELOPERS="Name One, Name Two" in .env
const DEVELOPERS = (process.env.DEVELOPERS || 'Your Name, Teammate Name')
  .split(',').map((s) => s.trim()).filter(Boolean);
const APP_TAGLINE = process.env.APP_TAGLINE || 'Smart monitoring & automation';

const THRESHOLDS = {
  fanTempC: 30.0,   // fans ON above this temperature
  pumpSoilPct: 40,  // pump ON below this soil moisture (sensor 1)
  lightLux: 500,    // LED ON below this light level
};

const HISTORY_SIZE = 24;
const REFRESH_SECONDS = 10;
const STALE_AFTER_MS = (Number(process.env.STALE_AFTER_SECONDS) || 120) * 1000;
const VALID_MODES = ['AUTO', 'MANUAL_ON', 'MANUAL_OFF'];

const METRICS = [
  { key: 'temperature', label: 'Temperature', unit: '°C', icon: 'thermo', digits: 1, min: 0, max: 50,
    warnAbove: THRESHOLDS.fanTempC, alertText: 'Temperature is high',
    note: `Fans switch on automatically above ${THRESHOLDS.fanTempC} °C.` },
  { key: 'humidity', label: 'Humidity', unit: '%', icon: 'droplet', digits: 0, min: 0, max: 100,
    note: 'Relative humidity inside the greenhouse.' },
  { key: 'soil_moisture', label: 'Soil moisture 1', unit: '%', icon: 'sprout', digits: 0, min: 0, max: 100,
    warnBelow: THRESHOLDS.pumpSoilPct, alertText: 'Soil 1 is dry',
    note: `The pump waters automatically when Soil 1 drops below ${THRESHOLDS.pumpSoilPct}%.` },
  { key: 'soil_moisture_2', label: 'Soil moisture 2', unit: '%', icon: 'sprout', digits: 0, min: 0, max: 100,
    note: 'Second soil sensor, for monitoring only.' },
  { key: 'water_level', label: 'Water level', unit: '', icon: 'waves', digits: 0,
    note: 'Reading from the water tank level sensor.' },
  { key: 'light_level', label: 'Light', unit: 'lux', icon: 'sun', digits: 0, min: 0, max: 2000,
    warnBelow: THRESHOLDS.lightLux, alertText: 'Light is low',
    note: `The grow light switches on automatically below ${THRESHOLDS.lightLux} lux.` },
];

const DEVICE_META = {
  fan:   { label: 'Ventilation fans', relay: 'Relay 1 & 2', icon: 'fan',     onText: 'Running', rule: `Auto turns on above ${THRESHOLDS.fanTempC} °C` },
  pump:  { label: 'Water pump',       relay: 'Relay 3',     icon: 'droplet', onText: 'Pumping', rule: `Auto turns on below ${THRESHOLDS.pumpSoilPct}% soil moisture` },
  light: { label: 'Grow light',       relay: 'Relay 4',     icon: 'bulb',    onText: 'On',      rule: `Auto turns on below ${THRESHOLDS.lightLux} lux` },
};

// Runtime state (in memory — resets when the server restarts)
const devices = {
  fan:   { mode: 'AUTO', manual: false },
  pump:  { mode: 'AUTO', manual: false },
  light: { mode: 'AUTO', manual: false },
};

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

// A missing sensor value never switches a relay on in AUTO mode.
const AUTO_RULES = {
  fan:   (r) => num(r?.temperature) !== null && num(r.temperature) > THRESHOLDS.fanTempC,
  pump:  (r) => num(r?.soil_moisture) !== null && num(r.soil_moisture) < THRESHOLDS.pumpSoilPct,
  light: (r) => num(r?.light_level) !== null && num(r.light_level) < THRESHOLDS.lightLux,
};

function resolveState(key, reading) {
  const d = devices[key];
  return d.mode === 'AUTO' ? AUTO_RULES[key](reading) : d.manual;
}

function deviceSnapshot(reading) {
  return Object.fromEntries(
    Object.keys(devices).map((k) => [k, { mode: devices[k].mode, on: resolveState(k, reading) }])
  );
}

async function getStatus() {
  if (!supabase) throw new Error('Supabase credentials are missing (SUPABASE_URL / SUPABASE_KEY).');
  const { data, error } = await supabase
    .from('sensor_readings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(HISTORY_SIZE);
  if (error) throw error;

  const latest = data && data.length ? data[0] : null;
  return {
    latest,
    history: data ? [...data].reverse() : [],
    devices: deviceSnapshot(latest),
    serverTime: new Date().toISOString(),
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

app.get('/', async (req, res) => {
  let initial;
  try {
    initial = await getStatus();
  } catch (err) {
    initial = { latest: null, history: [], devices: deviceSnapshot(null), serverTime: new Date().toISOString(), error: err.message };
  }
  res.set('Cache-Control', 'no-store').send(renderPage(initial));
});

app.get('/api/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await getStatus());
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Control endpoints — accept JSON (from the app) or form posts (no-JS fallback)
Object.keys(devices).forEach((key) => {
  app.post(`/api/set-${key}`, (req, res) => {
    const mode = req.body && req.body.mode;
    if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

    if (mode === 'AUTO') devices[key].mode = 'AUTO';
    else { devices[key].mode = 'MANUAL'; devices[key].manual = mode === 'MANUAL_ON'; }

    if (req.is('application/json') || req.accepts(['html', 'json']) === 'json') {
      return res.json({ device: key, mode: devices[key].mode, manual: devices[key].manual });
    }
    res.redirect('/');
  });
});

// Hardware API endpoint (ESP32) — request and response format unchanged
app.post('/api/sensor-data', async (req, res) => {
  const body = req.body || {};
  const fields = ['temperature', 'humidity', 'soil_moisture', 'soil_moisture_2', 'water_level', 'light_level'];

  const payload = {};
  fields.forEach((f) => { if (body[f] !== undefined) payload[f] = body[f]; });

  const states = {
    fan_state:   resolveState('fan', body)   ? 'ON' : 'OFF',
    pump_state:  resolveState('pump', body)  ? 'ON' : 'OFF',
    light_state: resolveState('light', body) ? 'ON' : 'OFF',
  };

  try {
    if (supabase) {
      const { error } = await supabase.from('sensor_readings').insert([payload]);
      if (error) console.error('Insert failed:', error.message);
    }
    // Always return relay states so the hardware keeps working even if the DB write fails
    res.status(200).json(states);
  } catch (err) {
    console.error(err);
    res.status(200).json(states);
  }
});

/* ------------------------------------------------------------------ */
/*  Logo + icons                                                       */
/* ------------------------------------------------------------------ */

// Greenhouse arch with a sprout growing inside. Parts are animated with CSS.
const logoSVG = (cls) => `<svg class="logo-svg ${cls}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <path class="lg-ground" d="M8 54H56"/>
  <path class="lg-arch" d="M14 54V31a18 18 0 0 1 36 0v23"/>
  <path class="lg-stem" d="M32 54V35"/>
  <path class="lg-leaf lg-leaf-l" d="M32 44c-7 0-11.5-5-11.5-11.5 7 0 11.5 4.5 11.5 11.5z"/>
  <path class="lg-leaf lg-leaf-r" d="M32 38.5c0-7.5 4.5-12.5 12-12.5 0 7.5-4.5 12.5-12 12.5z"/>
</svg>`;

const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f5c3c"/><g transform="translate(64 64) scale(6)" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 54H56"/><path d="M14 54V31a18 18 0 0 1 36 0v23"/><path d="M32 54V35"/></g><g transform="translate(64 64) scale(6)"><path d="M32 44c-7 0-11.5-5-11.5-11.5 7 0 11.5 4.5 11.5 11.5z" fill="#c6f0cf"/><path d="M32 38.5c0-7.5 4.5-12.5 12-12.5 0 7.5-4.5 12.5-12 12.5z" fill="#7bd88f"/></g></svg>`;

const ICONS = {
  thermo:  '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  sprout:  '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  waves:   '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon:    '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  fan:     '<path d="M10.83 16.38a6.08 6.08 0 0 1-8.62-7l5.41 1.45a6.08 6.08 0 0 1 7-8.62l-1.45 5.41a6.08 6.08 0 0 1 8.62 7l-5.41-1.45a6.08 6.08 0 0 1-7 8.62l1.45-5.41Z"/><path d="M12 12v.01"/>',
  bulb:    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  alert:   '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  close:   '<path d="M18 6 6 18M6 6l12 12"/>',
  home:    '<rect width="7" height="9" x="3" y="3" rx="1.5"/><rect width="7" height="5" x="14" y="3" rx="1.5"/><rect width="7" height="9" x="14" y="12" rx="1.5"/><rect width="7" height="5" x="3" y="16" rx="1.5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  chart:   '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  list:    '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  play:    '<path d="M6 4l14 8-14 8z"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const escHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJSON = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

/* ------------------------------------------------------------------ */
/*  Installable app (PWA)                                              */
/* ------------------------------------------------------------------ */

app.get('/icon.svg', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(APP_ICON));

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: 'Greenhouse Control Center',
    short_name: 'Greenhouse',
    start_url: '/',
    display: 'standalone',
    background_color: '#071a12',
    theme_color: '#0f5c3c',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }));
});

const SERVICE_WORKER = `
const CACHE = 'greenhouse-v2';
const SHELL = ['/', '/app.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
`;

app.get('/sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(SERVICE_WORKER));
app.get('/app.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(`(${clientApp.toString()})();`));

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

// Runs before first paint: applies the saved theme and skips the intro if already seen this session.
const BOOT_SCRIPT = `(function(){var r=document.documentElement;try{var t=localStorage.getItem('gh-theme');if(t==='light'||t==='dark')r.setAttribute('data-theme',t);}catch(e){}try{if(sessionStorage.getItem('gh-intro'))r.classList.add('no-intro');}catch(e){}})();`;

const letters = (text, start) => [...text].map((ch, i) =>
  ch === ' ' ? '<span class="sp"> </span>' : `<span style="--i:${start + i}">${escHTML(ch)}</span>`).join('');

function renderPage(initial) {
  const config = {
    metrics: METRICS.map(({ key, label, unit, digits, min, max, warnAbove, warnBelow, alertText, note }) =>
      ({ key, label, unit, digits, min, max, warnAbove, warnBelow, alertText, note })),
    devices: Object.fromEntries(Object.entries(DEVICE_META).map(([k, m]) => [k, { label: m.label, onText: m.onText }])),
    staleMs: STALE_AFTER_MS,
    refreshSeconds: REFRESH_SECONDS,
    timeZone: 'Asia/Manila',
  };

  const credits = DEVELOPERS.map(escHTML).join('<span class="dot-sep">·</span>');

  const kpiCards = METRICS.map((m, i) => {
    const t = m.warnAbove ?? m.warnBelow;
    const hasRange = m.min !== undefined && m.max !== undefined;
    const marker = hasRange && t !== undefined ? `<span class="kpi-mark" style="left:${((t - m.min) / (m.max - m.min)) * 100}%"></span>` : '';
    return `
    <button type="button" class="kpi reveal" style="--d:${i + 2}" data-metric="${m.key}" data-level="neutral" aria-label="${m.label} details">
      <span class="kpi-top">
        <span class="kpi-icon">${icon(m.icon)}</span>
        <span class="kpi-label">${m.label}</span>
        <span class="kpi-go">${icon('chevron')}</span>
      </span>
      <span class="kpi-reading"><span class="kpi-value">--</span><span class="kpi-unit">${m.unit}</span></span>
      ${hasRange ? `<span class="kpi-bar"><span class="kpi-fill"></span>${marker}</span>` : '<span class="kpi-bar kpi-bar-empty"></span>'}
      <span class="kpi-delta"></span>
    </button>`;
  }).join('');

  const deviceCards = Object.entries(DEVICE_META).map(([key, m], i) => `
    <article class="device reveal" style="--d:${i + 2}" data-device="${key}" data-on="false">
      <div class="device-head">
        <span class="device-icon">${icon(m.icon, 'dev-' + key)}<span class="device-glow"></span></span>
        <div class="device-title">
          <h3>${m.label}</h3>
          <p>${m.relay}</p>
        </div>
        <div class="device-status">
          <span class="pill"><span class="pill-dot"></span><span class="dev-state">Off</span></span>
          <span class="dev-mode">Automatic</span>
        </div>
      </div>
      <form class="seg" method="POST" action="/api/set-${key}" aria-label="${m.label} mode">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button type="submit" name="mode" value="AUTO" data-mode="AUTO" aria-pressed="false">Auto</button>
        <button type="submit" name="mode" value="MANUAL_ON" data-mode="MANUAL_ON" aria-pressed="false">On</button>
        <button type="submit" name="mode" value="MANUAL_OFF" data-mode="MANUAL_OFF" aria-pressed="false">Off</button>
      </form>
      <p class="device-rule">${m.rule}</p>
    </article>`).join('');

  const navItems = [['overview', 'Overview', 'home'], ['controls', 'Controls', 'sliders'], ['trends', 'Trends', 'chart'], ['log', 'Log', 'list']];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Greenhouse Control Center</title>
  <meta name="theme-color" content="#0f5c3c">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon.svg">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Greenhouse">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script id="boot">${BOOT_SCRIPT}</script>
  <style>${PAGE_CSS}</style>
</head>
<body>
<!--PAGE-START-->
  <div class="splash" id="splash" role="presentation">
    <div class="splash-rays" aria-hidden="true"></div>
    <div class="splash-inner">
      <div class="splash-logo-wrap">${logoSVG('splash-logo')}<span class="splash-ring"></span></div>
      <h1 class="splash-title">
        <span class="splash-word big">${letters('Greenhouse', 0)}</span>
        <span class="splash-word">${letters('Control Center', 10)}</span>
      </h1>
      <p class="splash-sub">${escHTML(APP_TAGLINE)}</p>
      <div class="splash-load" aria-hidden="true"><span class="splash-bar"></span></div>
      <p class="splash-status" id="splashStatus">Connecting to sensors…</p>
    </div>
    <div class="splash-credits">
      <span class="credits-label">Developed by</span>
      <span class="credits-names">${credits}</span>
    </div>
    <button type="button" class="splash-skip" id="splashSkip">Skip intro</button>
  </div>

  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#overview" aria-label="Greenhouse Control Center">
        <span class="logo">${logoSVG('head-logo')}</span>
        <span class="brand-text"><strong>Greenhouse</strong><small>Control Center</small></span>
      </a>
      <nav class="topnav" aria-label="Sections">
        ${navItems.map(([id, label]) => `<a href="#${id}" data-nav="${id}">${label}</a>`).join('')}
      </nav>
      <div class="top-actions">
        <div class="conn" id="conn" data-state="live" role="status" aria-live="polite">
          <span class="conn-dot"></span><span id="connText">Live</span>
        </div>
        <button type="button" class="icon-btn" id="themeBtn" data-mode="system" aria-label="Theme: system">
          ${icon('monitor', 'th-system')}${icon('sun', 'th-light')}${icon('moon', 'th-dark')}
        </button>
      </div>
    </div>
  </header>

  <main class="wrap">
    <section id="overview" class="sec">
      <div class="hero reveal" style="--d:0">
        <div class="hero-main">
          <p class="eyebrow" id="today">—</p>
          <h2 id="greeting">Hello</h2>
          <p class="hero-text" id="summaryText">Loading the latest readings…</p>
          <div class="chips" id="summaryChips"></div>
        </div>
        <div class="hero-side">
          <button type="button" class="refresh-btn" id="refreshBtn">${icon('refresh')}<span>Refresh</span></button>
          <span class="countdown"><span class="cd-ring"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"/><circle class="cd-prog" id="cdProg" cx="18" cy="18" r="15"/></svg></span><span id="countdown">Next update in ${REFRESH_SECONDS}s</span></span>
          <span class="muted" id="updated">—</span>
        </div>
      </div>
      <div class="banner" id="banner" hidden>${icon('alert')}<span id="bannerText"></span></div>
      <div class="section-head reveal" style="--d:1"><h2>Environment</h2><span class="muted">Tap a card for details</span></div>
      <div class="kpis">${kpiCards}</div>
    </section>

    <section id="controls" class="sec">
      <div class="section-head reveal" style="--d:1">
        <h2>Controls</h2>
        <span class="muted">Relays switch on the next sensor sync</span>
      </div>
      <div class="devices">${deviceCards}</div>
    </section>

    <section id="trends" class="sec">
      <div class="section-head reveal" style="--d:1"><h2>Trends</h2><span class="muted">Last ${HISTORY_SIZE} readings · tap a legend item to hide it</span></div>
      <div class="charts">
        <article class="card reveal" style="--d:2">
          <h3 class="card-title">Climate</h3>
          <div class="chart-box"><canvas id="climateChart" aria-label="Temperature and humidity chart"></canvas></div>
        </article>
        <article class="card reveal" style="--d:3">
          <h3 class="card-title">Soil &amp; light</h3>
          <div class="chart-box"><canvas id="soilChart" aria-label="Soil moisture and light chart"></canvas></div>
        </article>
      </div>
    </section>

    <section id="log" class="sec">
      <div class="section-head reveal" style="--d:1"><h2>Recent readings</h2><span class="muted">Newest first</span></div>
      <article class="card table-card reveal" style="--d:2">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Temp °C</th><th>Humidity %</th><th>Soil 1 %</th><th>Soil 2 %</th><th>Water</th><th>Light lux</th></tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </article>
    </section>

    <footer class="foot">
      <span class="foot-logo">${logoSVG('foot-logo')}</span>
      <p><strong>Greenhouse Control Center</strong></p>
      <p class="muted">Developed by ${credits}</p>
      <p class="muted">Times shown in Philippine Time<!--PREVIEW-NOTE--></p>
      <button type="button" class="link-btn" id="replayIntro">${icon('play')}Replay intro</button>
    </footer>
  </main>

  <nav class="bottomnav" aria-label="Sections">
    ${navItems.map(([id, label, ic]) => `<a href="#${id}" data-nav="${id}">${icon(ic)}<span>${label}</span></a>`).join('')}
  </nav>

  <div class="sheet-wrap" id="sheetWrap" aria-hidden="true">
    <div class="sheet-backdrop" id="sheetBackdrop"></div>
    <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head">
        <span class="kpi-icon" id="sheetIcon"></span>
        <div><h3 id="sheetTitle">Details</h3><p class="muted" id="sheetSub">Last ${HISTORY_SIZE} readings</p></div>
        <button type="button" class="icon-btn" id="sheetClose" aria-label="Close details">${icon('close')}</button>
      </div>
      <div class="sheet-now"><span class="sheet-value" id="sheetValue">--</span><span class="kpi-unit" id="sheetUnit"></span></div>
      <div class="sheet-stats">
        <div><span>Lowest</span><strong id="statMin">--</strong></div>
        <div><span>Average</span><strong id="statAvg">--</strong></div>
        <div><span>Highest</span><strong id="statMax">--</strong></div>
      </div>
      <div class="sheet-chart"><canvas id="detailChart" aria-label="Detail chart"></canvas></div>
      <p class="sheet-note" id="sheetNote"></p>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
<!--PAGE-END-->
  <script>window.__CONFIG__ = ${safeJSON(config)}; window.__INITIAL__ = ${safeJSON(initial)};</script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script src="/app.js"></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const PAGE_CSS = `
/* Layout: sticky glass header, summary hero, then sensor grid, device controls, trends and log. */
:root{
  --bg:#f1f5f0; --surface:#ffffff; --surface-2:#e9efe8; --border:#dbe4da;
  --text:#0f2118; --muted:#5a6c61; --primary:#1a7a52; --primary-strong:#0f5c3c; --primary-soft:#dff1e6;
  --leaf:#4cc072; --leaf-2:#a9e8b9;
  --ok:#15803d; --ok-soft:#e0f4e6; --warn:#c2410c; --warn-soft:#fdeee2; --danger:#d42c2c; --danger-soft:#fbe8e8;
  --temp:#e8590c; --hum:#1c7ed6; --soil:#7048e8; --soil2:#c2255c; --light:#d18f00; --water:#0c8599;
  --splash-bg:#061710; --splash-bg-2:#0f3a27; --splash-fg:#eaf7ee; --splash-muted:#9cc3ab;
  --glass:rgba(241,245,240,.78);
  --font-display:"Bricolage Grotesque","Manrope",system-ui,sans-serif;
  --font-body:"Manrope",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;
  --radius:20px; --radius-sm:12px;
  --shadow:0 1px 2px rgba(15,33,24,.05),0 8px 24px -8px rgba(15,33,24,.10);
  --shadow-lg:0 2px 4px rgba(15,33,24,.06),0 24px 48px -12px rgba(15,33,24,.22);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#08130e; --surface:#0f1d16; --surface-2:#16271e; --border:#21362a;
    --text:#e6f1ea; --muted:#90a898; --primary:#43d08f; --primary-strong:#2fb877; --primary-soft:#123526;
    --leaf:#5bd884; --leaf-2:#b5f0c4;
    --ok:#4ade80; --ok-soft:#133022; --warn:#fb923c; --warn-soft:#38220f; --danger:#f87171; --danger-soft:#3a1b1b;
    --temp:#ff8a4c; --hum:#4dabf7; --soil:#9775fa; --soil2:#f06595; --light:#fcc419; --water:#3bc9db;
    --glass:rgba(8,19,14,.78);
    --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -8px rgba(0,0,0,.5);
    --shadow-lg:0 2px 4px rgba(0,0,0,.3),0 24px 48px -12px rgba(0,0,0,.6);
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#08130e; --surface:#0f1d16; --surface-2:#16271e; --border:#21362a;
  --text:#e6f1ea; --muted:#90a898; --primary:#43d08f; --primary-strong:#2fb877; --primary-soft:#123526;
  --leaf:#5bd884; --leaf-2:#b5f0c4;
  --ok:#4ade80; --ok-soft:#133022; --warn:#fb923c; --warn-soft:#38220f; --danger:#f87171; --danger-soft:#3a1b1b;
  --temp:#ff8a4c; --hum:#4dabf7; --soil:#9775fa; --soil2:#f06595; --light:#fcc419; --water:#3bc9db;
  --glass:rgba(8,19,14,.78);
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -8px rgba(0,0,0,.5);
  --shadow-lg:0 2px 4px rgba(0,0,0,.3),0 24px 48px -12px rgba(0,0,0,.6);
  color-scheme:dark;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:84px}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font-body);-webkit-font-smoothing:antialiased}
h1,h2,h3,p{margin:0}
h2,h3{text-wrap:balance}
button{font:inherit;color:inherit}
.ic{width:20px;height:20px;flex:none}
.muted{color:var(--muted);font-size:13px}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:8px}

/* ---------- Logo ---------- */
.logo-svg{display:block}
.logo-svg .lg-ground,.logo-svg .lg-arch,.logo-svg .lg-stem{stroke:currentColor;stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}
.logo-svg .lg-leaf-l{fill:var(--leaf-2)}
.logo-svg .lg-leaf-r{fill:var(--leaf)}
.logo-svg .lg-leaf{transform-box:view-box}
.logo-svg .lg-leaf-l{transform-origin:32px 44px}
.logo-svg .lg-leaf-r{transform-origin:32px 38.5px}
.head-logo .lg-leaf-l{animation:swayL 4s ease-in-out infinite}
.head-logo .lg-leaf-r{animation:swayR 4s ease-in-out infinite}
.brand:hover .head-logo .lg-leaf{animation:grow .7s cubic-bezier(.3,1.6,.5,1) both}
@keyframes swayL{0%,100%{transform:rotate(0)}50%{transform:rotate(-7deg)}}
@keyframes swayR{0%,100%{transform:rotate(0)}50%{transform:rotate(6deg)}}
@keyframes grow{from{transform:scale(0)}to{transform:scale(1)}}
@keyframes draw{to{stroke-dashoffset:0}}

/* ---------- Splash / intro ---------- */
.splash{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:calc(24px + env(safe-area-inset-top,0px)) max(24px,env(safe-area-inset-right,0px)) calc(24px + env(safe-area-inset-bottom,0px)) max(24px,env(safe-area-inset-left,0px));
  background:radial-gradient(120% 80% at 50% 38%,var(--splash-bg-2) 0%,var(--splash-bg) 62%);color:var(--splash-fg);overflow:hidden;
  animation:splashOut .7s cubic-bezier(.6,0,.2,1) 3.6s forwards}
.splash.out{animation:splashOut .6s cubic-bezier(.6,0,.2,1) forwards}
.splash.gone,.no-intro .splash{display:none}
@keyframes splashOut{to{opacity:0;transform:scale(1.06);visibility:hidden;pointer-events:none}}
.splash-rays{position:absolute;inset:-40%;background:conic-gradient(from 0deg at 50% 50%,transparent 0 20deg,rgba(123,216,143,.07) 30deg,transparent 50deg 110deg,rgba(123,216,143,.05) 125deg,transparent 145deg 220deg,rgba(123,216,143,.06) 235deg,transparent 255deg 360deg);animation:rays 18s linear infinite;opacity:0;animation:rays 18s linear infinite,fadeIn 1.2s ease .3s forwards}
@keyframes rays{to{transform:rotate(360deg)}}
@keyframes fadeIn{to{opacity:1}}
.splash-inner{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px}
.splash-logo-wrap{position:relative;width:120px;height:120px;display:grid;place-items:center;margin-bottom:6px}
.splash-logo{width:120px;height:120px;color:var(--splash-fg);filter:drop-shadow(0 0 24px rgba(123,216,143,.35))}
.splash-logo .lg-leaf-l{fill:#c6f0cf}
.splash-logo .lg-leaf-r{fill:#7bd88f}
.splash-logo .lg-ground{stroke-dasharray:50;stroke-dashoffset:50;animation:draw .5s ease-out .15s forwards}
.splash-logo .lg-arch{stroke-dasharray:110;stroke-dashoffset:110;animation:draw .9s cubic-bezier(.6,0,.3,1) .35s forwards}
.splash-logo .lg-stem{stroke-dasharray:20;stroke-dashoffset:20;animation:draw .45s ease-out 1.05s forwards}
.splash-logo .lg-leaf{transform:scale(0)}
.splash-logo .lg-leaf-l{animation:grow .6s cubic-bezier(.3,1.6,.5,1) 1.3s forwards}
.splash-logo .lg-leaf-r{animation:grow .6s cubic-bezier(.3,1.6,.5,1) 1.45s forwards}
.splash-ring{position:absolute;inset:-10px;border-radius:50%;border:1.5px solid rgba(123,216,143,.5);opacity:0;animation:ring 1.4s ease-out 1.6s 2}
@keyframes ring{0%{opacity:.8;transform:scale(.7)}100%{opacity:0;transform:scale(1.35)}}
.splash-title{display:flex;flex-direction:column;align-items:center;gap:2px;font-family:var(--font-display);font-weight:700;letter-spacing:-.02em;line-height:1.05}
.splash-word{display:block;font-size:clamp(20px,5vw,28px);color:var(--splash-muted);font-weight:600;letter-spacing:.01em}
.splash-word.big{font-size:clamp(40px,11vw,64px);color:var(--splash-fg);font-weight:800}
.splash-word span{display:inline-block;opacity:0;transform:translateY(18px) rotate(4deg);animation:letterIn .55s cubic-bezier(.2,.9,.3,1.2) forwards;animation-delay:calc(1.55s + var(--i) * 32ms)}
.splash-word .sp{width:.3em;opacity:1;transform:none;animation:none}
@keyframes letterIn{to{opacity:1;transform:none}}
.splash-sub{font-size:14px;color:var(--splash-muted);opacity:0;animation:fadeUp .6s ease 2.25s forwards}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.splash-load{width:180px;height:3px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:12px;opacity:0;animation:fadeIn .4s ease .4s forwards}
.splash-bar{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#7bd88f,#c6f0cf);animation:load 3.1s cubic-bezier(.4,0,.2,1) .4s forwards}
@keyframes load{to{width:100%}}
.splash-status{font-family:var(--font-mono);font-size:12px;color:var(--splash-muted);letter-spacing:.02em;min-height:18px;opacity:0;animation:fadeIn .4s ease .5s forwards}
.splash-credits{position:absolute;left:0;right:0;bottom:calc(28px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:center;gap:4px;padding:0 24px;text-align:center;opacity:0;animation:fadeUp .7s ease 2.45s forwards}
.credits-label{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--splash-muted)}
.credits-names{font-family:var(--font-display);font-size:17px;font-weight:600;color:var(--splash-fg)}
.dot-sep{margin:0 .5em;opacity:.5}
.splash-skip{position:absolute;top:calc(16px + env(safe-area-inset-top,0px));right:max(16px,env(safe-area-inset-right,0px));background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:var(--splash-fg);padding:8px 14px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;opacity:0;animation:fadeIn .4s ease .8s forwards}
.splash-skip:hover{background:rgba(255,255,255,.16)}
.intro-playing body{overflow:hidden}

/* Dashboard entrance after the intro */
.intro-done .reveal{animation:rise .7s cubic-bezier(.2,.8,.2,1) backwards;animation-delay:calc(var(--d,0) * 70ms)}
@keyframes rise{from{opacity:0;transform:translateY(16px)}}

/* ---------- Top bar ---------- */
.topbar{position:sticky;top:0;padding-top:env(safe-area-inset-top);z-index:20;background:var(--glass);backdrop-filter:saturate(1.5) blur(14px);-webkit-backdrop-filter:saturate(1.5) blur(14px);border-bottom:1px solid var(--border)}
.topbar-inner{max-width:1180px;margin:0 auto;padding-block:10px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;margin-right:auto}
.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:linear-gradient(145deg,var(--primary),var(--primary-strong));color:#fff;box-shadow:0 6px 16px -6px var(--primary)}
.head-logo{width:30px;height:30px}
.brand-text{display:flex;flex-direction:column;line-height:1.15}
.brand-text strong{font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-.01em}
.brand-text small{font-size:12px;color:var(--muted);font-weight:500}
.topnav{display:flex;gap:2px;padding:4px;border-radius:999px;background:var(--surface-2)}
.topnav a{padding:6px 14px;border-radius:999px;font-size:13.5px;font-weight:600;color:var(--muted);text-decoration:none;transition:background .2s,color .2s}
.topnav a:hover{color:var(--text)}
.topnav a[aria-current]{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.top-actions{display:flex;align-items:center;gap:8px}
.icon-btn{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;border:1px solid var(--border);background:var(--surface);cursor:pointer;color:var(--muted);transition:color .2s,transform .15s}
.icon-btn:hover{color:var(--text)}
.icon-btn:active{transform:scale(.92)}
#themeBtn .ic{display:none}
#themeBtn[data-mode="system"] .th-system,#themeBtn[data-mode="light"] .th-light,#themeBtn[data-mode="dark"] .th-dark{display:block;animation:pop .35s cubic-bezier(.3,1.6,.5,1)}
@keyframes pop{from{transform:scale(.4) rotate(-40deg);opacity:0}}
.conn{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;font-size:13px;font-weight:700;background:var(--ok-soft);color:var(--ok);white-space:nowrap}
.conn-dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}
.conn[data-state="stale"],.conn[data-state="idle"]{background:var(--warn-soft);color:var(--warn)}
.conn[data-state="error"]{background:var(--danger-soft);color:var(--danger)}
.conn:not([data-state="live"]) .conn-dot{animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 50%,transparent)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}

/* ---------- Layout ---------- */
.wrap{max-width:1180px;margin:0 auto;padding-block:20px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.sec{margin-top:36px}
.sec:first-child{margin-top:4px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:22px 0 12px}
.section-head h2{font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-.015em}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
.card-title{font-size:14px;font-weight:700;margin-bottom:12px}

/* ---------- Hero summary ---------- */
.hero{position:relative;overflow:hidden;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:24px;border-radius:24px;
  background:linear-gradient(135deg,#0d4f34,#1a7a52);color:#fff;box-shadow:var(--shadow-lg)}
.hero::after{content:"";position:absolute;right:-60px;top:-60px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.18),transparent 70%);pointer-events:none}
.hero-main{position:relative;min-width:0;flex:1 1 320px}
.eyebrow{font-family:var(--font-mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8}
.hero h2{font-family:var(--font-display);font-size:clamp(26px,5vw,34px);font-weight:800;letter-spacing:-.02em;margin:4px 0 6px}
.hero-text{font-size:15px;opacity:.92;max-width:52ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:background .2s,transform .15s}
.chip:hover{background:rgba(255,255,255,.22)}
.chip:active{transform:scale(.96)}
.chip.warn::before{content:"";width:7px;height:7px;border-radius:50%;background:#ffb27a}
.chip.ok::before{content:"";width:7px;height:7px;border-radius:50%;background:#a9f0bd}
.hero-side{position:relative;display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:10px}
.hero-side .muted{color:rgba(255,255,255,.75)}
.refresh-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:12px;border:0;background:rgba(255,255,255,.95);color:#0f5c3c;font-weight:700;font-size:14px;cursor:pointer;transition:transform .15s}
.refresh-btn:active{transform:scale(.95)}
.refresh-btn .ic{width:18px;height:18px}
.refresh-btn.spinning .ic{animation:spin .8s linear infinite}
.countdown{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12px;color:rgba(255,255,255,.85)}
.cd-ring svg{width:18px;height:18px;transform:rotate(-90deg);display:block}
.cd-ring circle{fill:none;stroke:rgba(255,255,255,.25);stroke-width:4}
.cd-ring .cd-prog{stroke:#fff;stroke-dasharray:94.25;stroke-dashoffset:0;stroke-linecap:round;transition:stroke-dashoffset 1s linear}

.banner{display:flex;align-items:center;gap:10px;margin-top:14px;padding:12px 14px;border-radius:14px;background:var(--warn-soft);color:var(--warn);font-size:14px;font-weight:600}
.banner[data-tone="error"]{background:var(--danger-soft);color:var(--danger)}
.banner[hidden]{display:none}

/* ---------- KPI cards ---------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:12px}
.kpi{all:unset;box-sizing:border-box;display:flex;flex-direction:column;cursor:pointer;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;position:relative;overflow:hidden;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,border-color .2s}
.kpi:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg)}
.kpi:active{transform:scale(.98)}
.kpi:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.kpi[data-level="warn"]{border-color:color-mix(in srgb,var(--warn) 45%,var(--border))}
.kpi.flash{animation:flash 1s ease}
@keyframes flash{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--primary) 40%,transparent)}100%{box-shadow:var(--shadow)}}
.kpi-top{display:flex;align-items:center;gap:10px}
.kpi-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--surface-2);color:var(--c,var(--muted));flex:none}
.kpi-icon .ic{width:18px;height:18px}
[data-metric="temperature"]{--c:var(--temp)}
[data-metric="humidity"]{--c:var(--hum)}
[data-metric="soil_moisture"]{--c:var(--soil)}
[data-metric="soil_moisture_2"]{--c:var(--soil2)}
[data-metric="water_level"]{--c:var(--water)}
[data-metric="light_level"]{--c:var(--light)}
.kpi-label{font-size:13px;color:var(--muted);font-weight:600;flex:1;min-width:0}
.kpi-go{color:var(--muted);opacity:0;transform:translateX(-4px);transition:opacity .2s,transform .2s}
.kpi-go .ic{width:16px;height:16px}
.kpi:hover .kpi-go,.kpi:focus-visible .kpi-go{opacity:1;transform:none}
.kpi-reading{display:flex;align-items:baseline;gap:4px;margin-top:14px}
.kpi-value{font-family:var(--font-display);font-size:34px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1}
.kpi-unit{font-size:14px;color:var(--muted);font-weight:600}
.kpi[data-level="warn"] .kpi-value{color:var(--warn)}
.kpi-bar{position:relative;display:block;height:5px;border-radius:5px;background:var(--surface-2);margin-top:12px}
.kpi-bar-empty{background:transparent}
.kpi-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:5px;background:var(--c);transition:width .8s cubic-bezier(.2,.8,.2,1)}
.kpi[data-level="warn"] .kpi-fill{background:var(--warn)}
.kpi-mark{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:2px;background:var(--text);opacity:.35}
.kpi-delta{display:block;margin-top:8px;font-family:var(--font-mono);font-size:11.5px;color:var(--muted);min-height:18px;font-variant-numeric:tabular-nums}

/* ---------- Devices ---------- */
.devices{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.device{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;transition:border-color .3s,box-shadow .3s}
.device[data-on="true"]{border-color:color-mix(in srgb,var(--primary) 45%,var(--border));box-shadow:var(--shadow),0 0 0 4px color-mix(in srgb,var(--primary) 9%,transparent)}
.device-head{display:flex;align-items:center;gap:12px}
.device-icon{position:relative;display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:var(--surface-2);color:var(--muted);transition:background .3s,color .3s;flex:none}
.device-icon .ic{width:24px;height:24px;position:relative;z-index:1}
.device-glow{position:absolute;inset:0;border-radius:inherit;opacity:0;transition:opacity .3s}
.device[data-on="true"] .device-icon{background:linear-gradient(145deg,var(--primary),var(--primary-strong));color:#fff}
.device[data-on="true"] .dev-fan{animation:spin 1.1s linear infinite}
.device[data-on="true"] .dev-pump{animation:drip 1.2s ease-in-out infinite}
.device[data-device="light"][data-on="true"] .device-icon{background:linear-gradient(145deg,#f2b705,#d18f00)}
.device[data-device="light"][data-on="true"] .device-glow{opacity:1;box-shadow:0 0 22px 4px rgba(242,183,5,.55);animation:glow 2.2s ease-in-out infinite}
.device[data-device="pump"][data-on="true"] .device-icon{background:linear-gradient(145deg,#339af0,#1864ab)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes drip{0%,100%{transform:translateY(0)}50%{transform:translateY(3px) scale(.95)}}
@keyframes glow{0%,100%{opacity:.7}50%{opacity:1}}
.device-title{flex:1;min-width:0}
.device-title h3{font-size:15.5px;font-weight:700}
.device-title p{font-family:var(--font-mono);font-size:11.5px;color:var(--muted)}
.device-status{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12.5px;font-weight:700;background:var(--surface-2);color:var(--muted);transition:background .3s,color .3s}
.pill-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.device[data-on="true"] .pill{background:var(--ok-soft);color:var(--ok)}
.device[data-on="true"] .pill-dot{animation:pulse 1.6s infinite}
.dev-mode{font-size:12px;color:var(--muted)}
.seg{position:relative;display:grid;grid-template-columns:repeat(3,1fr);margin-top:16px;padding:4px;border-radius:14px;background:var(--surface-2)}
.seg-thumb{position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px) / 3);border-radius:10px;background:var(--surface);box-shadow:0 1px 4px rgba(0,0,0,.14);transition:transform .35s cubic-bezier(.3,1.3,.5,1)}
.seg[data-active="MANUAL_ON"] .seg-thumb{transform:translateX(100%)}
.seg[data-active="MANUAL_OFF"] .seg-thumb{transform:translateX(200%)}
.seg button{position:relative;z-index:1;appearance:none;border:0;background:transparent;color:var(--muted);font-size:14px;font-weight:700;min-height:42px;border-radius:10px;cursor:pointer;transition:color .2s}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"][data-mode="AUTO"]{color:var(--primary)}
.seg button[aria-pressed="true"][data-mode="MANUAL_ON"]{color:var(--ok)}
.seg button[aria-pressed="true"][data-mode="MANUAL_OFF"]{color:var(--danger)}
.device.busy .seg{opacity:.7;pointer-events:none}
.device-rule{margin-top:12px;font-size:12.5px;color:var(--muted)}

/* ---------- Charts ---------- */
.charts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.charts .card{min-width:0}
.chart-box{position:relative;height:270px}

/* ---------- Table ---------- */
.table-card{padding:0;overflow:hidden}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th{text-align:left;font-family:var(--font-mono);font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--surface-2);padding:11px 16px;white-space:nowrap}
td{padding:11px 16px;border-top:1px solid var(--border);white-space:nowrap}
td:first-child{font-family:var(--font-mono);font-size:12.5px;color:var(--muted)}
tbody tr{transition:background .2s}
tbody tr:hover td{background:color-mix(in srgb,var(--surface-2) 60%,transparent)}
tr.new td{animation:rowIn 1.6s ease}
@keyframes rowIn{0%{background:color-mix(in srgb,var(--primary) 18%,transparent)}100%{background:transparent}}
td.warn{color:var(--warn);font-weight:700}
td.empty{text-align:center;color:var(--muted);padding:28px}

/* ---------- Footer ---------- */
.foot{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:44px;text-align:center;font-size:13px}
.foot-logo{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--surface-2);color:var(--primary);margin-bottom:6px}
.foot-logo .logo-svg{width:28px;height:28px}
.link-btn{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:7px 14px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;font-weight:600;cursor:pointer}
.link-btn:hover{color:var(--text)}
.link-btn .ic{width:14px;height:14px}
.preview-note{display:inline-block;margin-top:6px;padding:2px 10px;border-radius:999px;background:var(--surface-2);color:var(--muted)}

/* ---------- Bottom nav (phones) ---------- */
.bottomnav{display:none}

/* ---------- Detail sheet ---------- */
.sheet-wrap{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;visibility:hidden;pointer-events:none}
.sheet-wrap.open{visibility:visible;pointer-events:auto}
.sheet-backdrop{position:absolute;inset:0;background:rgba(4,12,8,.5);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .3s}
.sheet-wrap.open .sheet-backdrop{opacity:1}
.sheet{position:relative;width:min(560px,calc(100% - 32px));max-height:calc(100% - 48px);overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:24px;box-shadow:var(--shadow-lg);padding:20px;opacity:0;transform:translateY(24px) scale(.97);transition:opacity .3s,transform .4s cubic-bezier(.2,.9,.3,1.1)}
.sheet-wrap.open .sheet{opacity:1;transform:none}
.sheet-grip{display:none}
.sheet-head{display:flex;align-items:center;gap:12px}
.sheet-head > div{flex:1;min-width:0}
.sheet-head h3{font-family:var(--font-display);font-size:20px;font-weight:700}
.sheet-now{display:flex;align-items:baseline;gap:6px;margin-top:16px}
.sheet-value{font-family:var(--font-display);font-size:48px;font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--c,var(--text));font-variant-numeric:tabular-nums}
.sheet-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:16px}
.sheet-stats div{padding:10px 12px;border-radius:12px;background:var(--surface-2)}
.sheet-stats span{display:block;font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.sheet-stats strong{font-size:17px;font-variant-numeric:tabular-nums}
.sheet-chart{position:relative;height:220px;margin-top:16px}
.sheet-note{margin-top:12px;font-size:13px;color:var(--muted)}

/* ---------- Toast ---------- */
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:70;transform:translate(-50%,20px);opacity:0;pointer-events:none;background:var(--text);color:var(--bg);padding:11px 18px;border-radius:14px;font-size:14px;font-weight:600;box-shadow:var(--shadow-lg);transition:opacity .25s,transform .35s cubic-bezier(.3,1.4,.5,1);width:max-content;max-width:calc(100vw - 32px);text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.error{background:var(--danger);color:#fff}

/* ---------- Responsive ---------- */
@media (max-width:900px){.charts{grid-template-columns:1fr}}
@media (max-width:760px){
  .topnav{display:none}
  .bottomnav{display:grid;grid-template-columns:repeat(4,1fr);position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--glass);backdrop-filter:saturate(1.5) blur(14px);-webkit-backdrop-filter:saturate(1.5) blur(14px);border-top:1px solid var(--border);
    padding:6px max(8px,env(safe-area-inset-right,0px)) calc(6px + env(safe-area-inset-bottom,0px)) max(8px,env(safe-area-inset-left,0px))}
  .bottomnav a{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border-radius:12px;color:var(--muted);text-decoration:none;font-size:11px;font-weight:700;transition:color .2s}
  .bottomnav a .ic{width:22px;height:22px;transition:transform .3s cubic-bezier(.3,1.6,.5,1)}
  .bottomnav a[aria-current]{color:var(--primary)}
  .bottomnav a[aria-current] .ic{transform:translateY(-2px) scale(1.1)}
  .wrap{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px))}
  .toast{bottom:calc(84px + env(safe-area-inset-bottom,0px))}
  .sheet-wrap{align-items:flex-end}
  .sheet{width:100%;max-height:88%;border-radius:24px 24px 0 0;padding-bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateY(100%)}
  .sheet-grip{display:block;width:40px;height:5px;border-radius:5px;background:var(--border);margin:-6px auto 12px}
}
@media (max-width:560px){
  .brand-text small{display:none}
  .kpis{grid-template-columns:1fr 1fr;gap:10px}
  .kpi{padding:14px}
  .kpi-value{font-size:28px}
  .section-head{flex-direction:column;gap:2px}
  .hero{padding:20px}
  .hero-side{flex-direction:row;flex-wrap:wrap;align-items:center;width:100%}
  .chart-box{height:230px}
  .seg button{min-height:46px}
  .sheet-value{font-size:40px}
}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .splash{animation:splashOut .3s ease 1s forwards!important}
  html{scroll-behavior:auto}
}
`;

/* ------------------------------------------------------------------ */
/*  Client-side app (served at /app.js)                                */
/* ------------------------------------------------------------------ */

function clientApp() {
  const cfg = window.__CONFIG__;
  let state = window.__INITIAL__;
  let connected = !state.error;
  let lastLatestAt = null;
  let openMetric = null;
  let lastFocus = null;
  let countdown = cfg.refreshSeconds;
  const charts = {};
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso, opts) => new Date(iso).toLocaleTimeString('en-US', Object.assign({ timeZone: cfg.timeZone }, opts || {}));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const metricByKey = (k) => cfg.metrics.find((m) => m.key === k);

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    if (h.length !== 6) return hex;
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  /* ---------- Intro ---------- */
  let splashTimer, statusTimer;
  function playIntro(force) {
    let s = $('splash');
    if (!s) return;
    if (force) {
      const fresh = s.cloneNode(true);
      fresh.classList.remove('out', 'gone');
      s.replaceWith(fresh);
      s = fresh;
      root.classList.remove('no-intro', 'intro-done');
      window.scrollTo(0, 0);
    } else if (root.classList.contains('no-intro')) {
      root.classList.add('intro-done');
      return;
    }
    try { sessionStorage.setItem('gh-intro', '1'); } catch (e) {}
    root.classList.add('intro-playing');

    const statuses = ['Connecting to sensors…', 'Loading readings…', 'Syncing relays…', 'Ready'];
    let i = 0;
    $('splashStatus').textContent = statuses[0];
    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      i++;
      if (i < statuses.length) $('splashStatus').textContent = statuses[i];
      else clearInterval(statusTimer);
    }, 820);

    const finish = () => {
      clearTimeout(splashTimer); clearInterval(statusTimer);
      if (s.classList.contains('out')) return;
      s.classList.add('out');
      root.classList.remove('intro-playing');
      void root.offsetWidth;
      root.classList.add('intro-done');
      animateNumbersFromZero();
      setTimeout(() => s.classList.add('gone'), 650);
    };
    clearTimeout(splashTimer);
    splashTimer = setTimeout(finish, reduceMotion ? 1000 : 3600);
    s.querySelector('#splashSkip').addEventListener('click', (e) => { e.stopPropagation(); finish(); });
    s.addEventListener('click', finish);
  }

  /* ---------- Theme ---------- */
  const THEMES = ['system', 'light', 'dark'];
  function currentTheme() { return root.getAttribute('data-theme') || 'system'; }
  function applyTheme(t, announce) {
    if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    const b = $('themeBtn');
    b.dataset.mode = t;
    b.setAttribute('aria-label', 'Theme: ' + t);
    try { localStorage.setItem('gh-theme', t); } catch (e) {}
    rebuildCharts();
    if (announce) toast(t === 'system' ? 'Theme follows your device' : (t === 'dark' ? 'Dark theme' : 'Light theme'));
  }
  $('themeBtn').dataset.mode = currentTheme();
  $('themeBtn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % 3], true));
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rebuildCharts); } catch (e) {}

  /* ---------- Numbers ---------- */
  function setNumber(el, v, digits, fromZero) {
    if (v === null) { el.textContent = '--'; el._v = null; return; }
    const from = fromZero ? 0 : (el._v === undefined || el._v === null ? v : el._v);
    el._v = v;
    cancelAnimationFrame(el._raf);
    if (reduceMotion || from === v) { el.textContent = v.toFixed(digits); return; }
    const t0 = performance.now(), dur = fromZero ? 1100 : 700;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = (from + (v - from) * e).toFixed(digits);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }
  function animateNumbersFromZero() {
    const latest = state.latest || {};
    cfg.metrics.forEach((m) => {
      const el = document.querySelector('[data-metric="' + m.key + '"] .kpi-value');
      if (el) setNumber(el, num(latest[m.key]), m.digits, true);
    });
  }

  /* ---------- Status + summary ---------- */
  function readingAge() {
    if (!state.latest) return null;
    const skew = Date.now() - new Date(state.serverTime).getTime();
    return Date.now() - skew - new Date(state.latest.created_at).getTime();
  }
  function relTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
  }

  function renderStatus() {
    const age = readingAge();
    let mode = 'live', text = 'Live', banner = null, tone = 'warn';
    if (!connected) {
      mode = 'error'; text = 'Reconnecting…';
      banner = state.error || 'Cannot reach the server. Showing the last data received.'; tone = 'error';
    } else if (age === null) {
      mode = 'idle'; text = 'Waiting';
      banner = 'No sensor readings yet. Check that the controller is powered and online.';
    } else if (age > cfg.staleMs) {
      mode = 'stale'; text = 'Sensor offline';
      banner = 'No new readings for ' + relTime(age).replace(' ago', '') + '. The controller may be offline.';
    }
    $('conn').dataset.state = mode;
    $('connText').textContent = text;
    $('updated').textContent = age === null ? 'No readings yet' : 'Last reading ' + relTime(age);
    const b = $('banner');
    b.hidden = !banner;
    b.dataset.tone = tone;
    $('bannerText').textContent = banner || '';
  }

  function issuesList() {
    const latest = state.latest || {};
    const out = [];
    cfg.metrics.forEach((m) => {
      const v = num(latest[m.key]);
      if (v === null) return;
      if ((m.warnAbove != null && v > m.warnAbove) || (m.warnBelow != null && v < m.warnBelow)) out.push(m);
    });
    return out;
  }

  function renderSummary() {
    const now = new Date();
    const hr = Number(now.toLocaleString('en-US', { timeZone: cfg.timeZone, hour: 'numeric', hour12: false })) % 24;
    $('greeting').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    $('today').textContent = now.toLocaleDateString('en-US', { timeZone: cfg.timeZone, weekday: 'long', month: 'long', day: 'numeric' });

    const issues = issuesList();
    const running = Object.values(state.devices).filter((d) => d.on).length;
    const total = Object.keys(state.devices).length;
    const devText = running + ' of ' + total + ' devices running.';
    $('summaryText').textContent = !state.latest
      ? 'Waiting for the first sensor reading.'
      : issues.length
        ? issues.length + (issues.length > 1 ? ' readings need' : ' reading needs') + ' attention. ' + devText
        : 'All readings are in range. ' + devText;

    $('summaryChips').innerHTML = !state.latest ? '' : issues.length
      ? issues.map((m) => '<button type="button" class="chip warn" data-open="' + m.key + '">' + esc(m.alertText || m.label) + '</button>').join('')
      : '<button type="button" class="chip ok" data-open="temperature">Everything looks good</button>';
  }

  /* ---------- KPIs ---------- */
  function renderKpis(changed) {
    const latest = state.latest || {};
    const prev = state.history.length > 1 ? state.history[state.history.length - 2] : null;
    const introRunning = root.classList.contains('intro-playing');
    cfg.metrics.forEach((m) => {
      const el = document.querySelector('[data-metric="' + m.key + '"]');
      if (!el) return;
      const v = num(latest[m.key]);
      if (!introRunning) setNumber(el.querySelector('.kpi-value'), v, m.digits, false);

      let level = 'neutral';
      if (v !== null && m.warnAbove != null) level = v > m.warnAbove ? 'warn' : 'ok';
      if (v !== null && m.warnBelow != null) level = v < m.warnBelow ? 'warn' : 'ok';
      el.dataset.level = level;

      const fill = el.querySelector('.kpi-fill');
      if (fill && m.min != null) fill.style.width = v === null ? '0%' : Math.max(0, Math.min(100, ((v - m.min) / (m.max - m.min)) * 100)) + '%';

      const d = el.querySelector('.kpi-delta');
      const p = prev ? num(prev[m.key]) : null;
      if (v === null || p === null) d.textContent = '';
      else {
        const diff = v - p;
        const shown = Math.abs(diff).toFixed(m.digits);
        d.textContent = Number(shown) === 0 ? 'No change' : (diff > 0 ? '▲ ' : '▼ ') + shown + (m.unit ? ' ' + m.unit : '') + ' since last';
      }
      if (changed && !reduceMotion) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    });
  }

  /* ---------- Devices ---------- */
  function setSeg(card, active) {
    const seg = card.querySelector('.seg');
    seg.dataset.active = active;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === active)));
  }
  function renderDevices() {
    Object.keys(state.devices).forEach((key) => {
      const d = state.devices[key];
      const card = document.querySelector('[data-device="' + key + '"]');
      if (!card || card.classList.contains('busy')) return;
      card.dataset.on = String(d.on);
      card.querySelector('.dev-state').textContent = d.on ? cfg.devices[key].onText : 'Off';
      card.querySelector('.dev-mode').textContent = d.mode === 'AUTO' ? 'Automatic' : 'Manual override';
      setSeg(card, d.mode === 'AUTO' ? 'AUTO' : (d.on ? 'MANUAL_ON' : 'MANUAL_OFF'));
    });
  }

  /* ---------- Table ---------- */
  function renderTable(changed) {
    const cols = ['temperature', 'humidity', 'soil_moisture', 'soil_moisture_2', 'water_level', 'light_level'];
    const rows = state.history.slice().reverse().slice(0, 10);
    $('rows').innerHTML = rows.length
      ? rows.map((r, i) => '<tr' + (i === 0 && changed ? ' class="new"' : '') + '><td>' + esc(fmtTime(r.created_at)) + '</td>' +
          cols.map((c) => {
            const v = num(r[c]);
            const m = metricByKey(c);
            const warn = v !== null && m && ((m.warnAbove != null && v > m.warnAbove) || (m.warnBelow != null && v < m.warnBelow));
            return '<td' + (warn ? ' class="warn"' : '') + '>' + (v === null ? '<span class="muted">--</span>' : esc(m ? v.toFixed(m.digits) : v)) + '</td>';
          }).join('') +
        '</tr>').join('')
      : '<tr><td colspan="7" class="empty">No readings yet</td></tr>';
  }

  /* ---------- Charts ---------- */
  function gradientFill(color) {
    return (ctx) => {
      const area = ctx.chart.chartArea;
      if (!area) return 'transparent';
      const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexA(color, 0.28));
      g.addColorStop(1, hexA(color, 0));
      return g;
    };
  }
  function baseOptions(scales) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 600, easing: 'easeOutCubic' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, color: css('--muted') } },
        tooltip: { padding: 10, cornerRadius: 10, boxPadding: 4, backgroundColor: css('--text'), titleColor: css('--bg'), bodyColor: css('--bg') },
      },
      elements: { point: { radius: 0, hoverRadius: 5, hitRadius: 12 }, line: { tension: 0.38, borderWidth: 2.25 } },
      scales,
    };
  }
  function axes(leftTitle, rightTitle) {
    const grid = css('--border'), muted = css('--muted');
    const s = {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, color: muted } },
      y: { position: 'left', grid: { color: grid }, border: { display: false }, ticks: { color: muted }, title: { display: true, text: leftTitle, color: muted } },
    };
    if (rightTitle) s.y1 = { position: 'right', grid: { drawOnChartArea: false }, border: { display: false }, ticks: { color: muted }, title: { display: true, text: rightTitle, color: muted } };
    return s;
  }
  function line(label, color, axis, fill) {
    return { label, data: [], borderColor: color, backgroundColor: fill ? gradientFill(color) : color, pointBackgroundColor: color, fill: !!fill, yAxisID: axis, spanGaps: true };
  }
  function buildCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = 'Manrope, system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    charts.climate = new Chart($('climateChart'), {
      type: 'line',
      data: { labels: [], datasets: [line('Temperature (°C)', css('--temp'), 'y', true), line('Humidity (%)', css('--hum'), 'y1')] },
      options: baseOptions(axes('°C', '%')),
    });
    charts.soil = new Chart($('soilChart'), {
      type: 'line',
      data: { labels: [], datasets: [line('Soil 1 (%)', css('--soil'), 'y', true), line('Soil 2 (%)', css('--soil2'), 'y'), line('Light (lux)', css('--light'), 'y1')] },
      options: baseOptions(axes('Soil %', 'lux')),
    });
  }
  function rebuildCharts() {
    ['climate', 'soil'].forEach((k) => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } });
    buildCharts();
    renderCharts();
    if (openMetric) buildDetailChart(metricByKey(openMetric));
  }
  function renderCharts() {
    if (!charts.climate) return;
    const h = state.history;
    const labels = h.map((r) => fmtTime(r.created_at, { hour: '2-digit', minute: '2-digit' }));
    const col = (k) => h.map((r) => num(r[k]));
    charts.climate.data.labels = labels;
    charts.climate.data.datasets[0].data = col('temperature');
    charts.climate.data.datasets[1].data = col('humidity');
    charts.climate.update();
    charts.soil.data.labels = labels;
    charts.soil.data.datasets[0].data = col('soil_moisture');
    charts.soil.data.datasets[1].data = col('soil_moisture_2');
    charts.soil.data.datasets[2].data = col('light_level');
    charts.soil.update();
  }

  /* ---------- Detail sheet ---------- */
  function buildDetailChart(m) {
    if (!window.Chart || !m) return;
    if (charts.detail) charts.detail.destroy();
    const color = css('--' + ({ temperature: 'temp', humidity: 'hum', soil_moisture: 'soil', soil_moisture_2: 'soil2', water_level: 'water', light_level: 'light' }[m.key]));
    const h = state.history;
    const datasets = [Object.assign(line(m.label + (m.unit ? ' (' + m.unit + ')' : ''), color, 'y', true), { data: h.map((r) => num(r[m.key])) })];
    const t = m.warnAbove != null ? m.warnAbove : m.warnBelow;
    if (t != null) datasets.push({ label: 'Threshold', data: h.map(() => t), borderColor: css('--muted'), borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false, yAxisID: 'y' });
    const opts = baseOptions(axes(m.unit || 'value'));
    opts.plugins.legend.display = t != null;
    charts.detail = new Chart($('detailChart'), { type: 'line', data: { labels: h.map((r) => fmtTime(r.created_at, { hour: '2-digit', minute: '2-digit' })), datasets }, options: opts });
  }
  function fillSheet(m) {
    const vals = state.history.map((r) => num(r[m.key])).filter((v) => v !== null);
    const f = (v) => (v === null || v === undefined || isNaN(v) ? '--' : v.toFixed(m.digits) + (m.unit ? ' ' + m.unit : ''));
    const cur = num((state.latest || {})[m.key]);
    $('sheet').dataset.metric = m.key;
    $('sheetTitle').textContent = m.label;
    $('sheetIcon').innerHTML = document.querySelector('[data-metric="' + m.key + '"] .kpi-icon').innerHTML;
    $('sheetUnit').textContent = m.unit;
    setNumber($('sheetValue'), cur, m.digits, false);
    $('statMin').textContent = vals.length ? f(Math.min.apply(null, vals)) : '--';
    $('statMax').textContent = vals.length ? f(Math.max.apply(null, vals)) : '--';
    $('statAvg').textContent = vals.length ? f(vals.reduce((a, b) => a + b, 0) / vals.length) : '--';
    $('sheetNote').textContent = m.note || '';
  }
  function openSheet(key) {
    const m = metricByKey(key);
    if (!m) return;
    lastFocus = document.activeElement;
    openMetric = key;
    $('sheetValue')._v = undefined;
    fillSheet(m);
    const w = $('sheetWrap');
    w.classList.add('open');
    w.setAttribute('aria-hidden', 'false');
    setTimeout(() => buildDetailChart(m), 60);
    $('sheetClose').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!openMetric) return;
    openMetric = null;
    const w = $('sheetWrap');
    w.classList.remove('open');
    w.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  document.querySelectorAll('.kpi').forEach((el) => el.addEventListener('click', () => openSheet(el.dataset.metric)));
  $('summaryChips').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openSheet(b.dataset.open); });
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // Swipe down to close on phones
  (function () {
    let y0 = null;
    const sh = $('sheet');
    sh.addEventListener('touchstart', (e) => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener('touchmove', (e) => { if (y0 === null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
    sh.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      sh.style.transform = '';
      if (dy > 90) closeSheet();
      y0 = null;
    });
  })();

  /* ---------- Render ---------- */
  function renderAll() {
    const latestAt = state.latest && state.latest.created_at;
    const changed = lastLatestAt !== null && latestAt && latestAt !== lastLatestAt;
    lastLatestAt = latestAt || lastLatestAt;
    renderStatus(); renderSummary(); renderKpis(changed); renderDevices(); renderTable(changed); renderCharts();
    if (openMetric) { fillSheet(metricByKey(openMetric)); if (changed) buildDetailChart(metricByKey(openMetric)); }
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2600);
  }

  let refreshing = false;
  async function refresh(manual) {
    if (refreshing) return;
    refreshing = true;
    countdown = cfg.refreshSeconds;
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Server error');
      state = body;
      connected = true;
      if (manual) toast('Dashboard updated');
    } catch (e) {
      connected = false;
      state.error = e && e.message && e.message !== 'Failed to fetch' ? e.message : null;
      if (manual) toast('Could not reach the server', true);
    }
    setTimeout(() => btn.classList.remove('spinning'), 400);
    refreshing = false;
    renderAll();
    renderCountdown();
  }
  $('refreshBtn').addEventListener('click', () => refresh(true));

  function renderCountdown() {
    $('countdown').textContent = 'Next update in ' + Math.max(countdown, 0) + 's';
    const frac = Math.max(countdown, 0) / cfg.refreshSeconds;
    $('cdProg').style.strokeDashoffset = String(94.25 * (1 - frac));
  }

  // Device controls
  document.querySelectorAll('[data-device]').forEach((card) => {
    const key = card.dataset.device;
    card.querySelectorAll('.seg button').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (btn.getAttribute('aria-pressed') === 'true') return;
        const mode = btn.dataset.mode;
        setSeg(card, mode);
        if (mode !== 'AUTO') {
          card.dataset.on = String(mode === 'MANUAL_ON');
          card.querySelector('.dev-state').textContent = mode === 'MANUAL_ON' ? cfg.devices[key].onText : 'Off';
          card.querySelector('.dev-mode').textContent = 'Manual override';
        }
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        card.classList.add('busy');
        try {
          const r = await fetch('/api/set-' + key, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ mode }),
          });
          if (!r.ok) throw new Error();
          card.classList.remove('busy');
          await refresh(false);
          toast(cfg.devices[key].label + ' set to ' + btn.textContent.trim().toLowerCase());
        } catch (err) {
          card.classList.remove('busy');
          renderDevices();
          toast('Could not update ' + cfg.devices[key].label.toLowerCase(), true);
        }
      });
    });
  });

  // Section nav highlighting
  const navLinks = document.querySelectorAll('[data-nav]');
  const setNav = (id) => navLinks.forEach((a) => { if (a.dataset.nav === id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  setNav('overview');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) setNav(e.target.id); }), { rootMargin: '-40% 0px -55% 0px' });
    ['overview', 'controls', 'trends', 'log'].forEach((id) => { const s = $(id); if (s) io.observe(s); });
  }

  $('replayIntro').addEventListener('click', () => playIntro(true));

  // Boot
  buildCharts();
  renderAll();
  renderCountdown();
  playIntro(false);
  if (!root.classList.contains('intro-playing')) animateNumbersFromZero();

  setInterval(() => {
    countdown--;
    if (countdown <= 0) refresh(false);
    renderCountdown();
    renderStatus();
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
