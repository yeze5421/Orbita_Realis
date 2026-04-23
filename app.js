const canvas = document.getElementById('space');
const ctx = canvas.getContext('2d', { alpha: true });
const modeLabel = document.getElementById('modeLabel');
const zoomLabel = document.getElementById('zoomLabel');
const timeLabel = document.getElementById('timeLabel');
const realTimeLabel = document.getElementById('realTimeLabel');
const simTimeLabel = document.getElementById('simTimeLabel');
const planetNameEl = document.getElementById('planetName');
const planetSubtitleEl = document.getElementById('planetSubtitle');
const planetDescriptionEl = document.getElementById('planetDescription');
const factsGridEl = document.getElementById('factsGrid');
const detailBadgeEl = document.getElementById('detailBadge');
const statusTextEl = document.getElementById('statusText');
const homeBtn = document.getElementById('homeBtn');
const pauseBtn = document.getElementById('pauseBtn');
const speedButtons = Array.from(document.querySelectorAll('.speed-btn'));

const DPR = Math.min(window.devicePixelRatio || 1, 4.5);
const J2000_JD = 2451545.0;
const SIM_SECONDS_PER_REAL_SECOND = 3600; // 1 real second = 1 simulated hour
const SPEED_PRESETS = [1 / 60, 1, 24, 168, 720, 8760];
const SPEED_LABELS = ['1 min/s', '1 h/s', '1 d/s', '1 w/s', '1 mo/s', '1 y/s'];

let W = 1;
let H = 1;
let running = true;
let appTime = 0;
let timeScale = 1.0;
let drag = null;
let lastClickTime = 0;
let hoveredPlanet = null;
let suppressClick = false;
let detailMode = false;
let focusedPlanet = null;
let camera = { x: 0, y: 0, zoom: 1.0 };
let targetCamera = { x: 0, y: 0, zoom: 1.0 };
let detailZoom = 1.0;
let targetDetailZoom = 1.0;
let overviewYaw = -0.42;
let targetOverviewYaw = -0.42;
let overviewTilt = 0.58;
let targetOverviewTilt = 0.58;
let detailYaw = 0;
let targetDetailYaw = 0;
let detailTilt = 0.08;
let targetDetailTilt = 0.08;
let simulationDate = new Date();
let simulationJD = dateToJulian(simulationDate);

const stars = [];
const ringDots = [];
const textures = new Map();
const textureSamples = new Map();
const frameCache = new Map();

const config = {
  orbitOpacity: 0.12,
  focusZoom: 1.65,
  maxOverviewZoom: 4.5,
  minOverviewZoom: 0.35,
  detailRadius: 360,
  maxDetailZoom: 3.35,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function fract(x) { return x - Math.floor(x); }
function degToRad(v) { return v * Math.PI / 180; }
function radToDeg(v) { return v * 180 / Math.PI; }
function normalizeRad(v) {
  const twoPi = Math.PI * 2;
  v %= twoPi;
  if (v < 0) v += twoPi;
  return v;
}
function dateToJulian(date) { return date.getTime() / 86400000 + 2440587.5; }
function julianToDate(jd) { return new Date((jd - 2440587.5) * 86400000); }
function formatLocalTime(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
function formatSimUTC(date) {
  const iso = date.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}
function formatSimRate(multiplier) {
  const seconds = SIM_SECONDS_PER_REAL_SECOND * multiplier;
  if (Math.abs(seconds - 3600) < 1e-9) return '1 h/s';
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(2)} d/s`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(2)} h/s`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(2)} min/s`;
  return `${seconds.toFixed(2)} s/s`;
}
function updateSpeedButtons() {
  speedButtons.forEach((btn) => {
    const v = Number(btn.dataset.speed);
    btn.classList.toggle('active', Math.abs(v - timeScale) < 1e-9);
  });
}
function setTimeScale(nextScale) {
  timeScale = clamp(nextScale, SPEED_PRESETS[0], SPEED_PRESETS[SPEED_PRESETS.length - 1]);
  updateSpeedButtons();
  const label = formatSimRate(timeScale);
  timeLabel.textContent = label;
  statusTextEl.textContent = `Simulation speed set to ${label}.`;
}
function stepTimePreset(direction) {
  let index = SPEED_PRESETS.findIndex((v) => Math.abs(v - timeScale) < 1e-9);
  if (index < 0) index = SPEED_PRESETS.reduce((best, v, i) => Math.abs(v - timeScale) < Math.abs(SPEED_PRESETS[best] - timeScale) ? i : best, 0);
  index = clamp(index + direction, 0, SPEED_PRESETS.length - 1);
  setTimeScale(SPEED_PRESETS[index]);
}
function hexToRgb(hex) {
  const s = hex.replace('#', '');
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mixColor(a, b, t) {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}
function mulColor(a, m) {
  return { r: Math.round(a.r * m), g: Math.round(a.g * m), b: Math.round(a.b * m) };
}
function rotateObjectPoint(x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = z * cy - x * sy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return { x: x1, y: y2, z: z2 };
}
function projectOverviewWorld(world) {
  const cy = Math.cos(overviewYaw), sy = Math.sin(overviewYaw);
  const x1 = world.x * cy - world.z * sy;
  const z1 = world.x * sy + world.z * cy;
  const ct = Math.cos(overviewTilt), st = Math.sin(overviewTilt);
  const y2 = world.y * ct - z1 * st;
  const z2 = world.y * st + z1 * ct;
  return { x: x1, y: y2, depth: z2 };
}
function screenFromProjected(projected) {
  return {
    x: W * 0.5 + (projected.x - camera.x) * camera.zoom,
    y: H * 0.54 + (projected.y - camera.y) * camera.zoom,
    depth: projected.depth,
  };
}
function textureSizeForPlanet(planet) {
  if (planet.id === 'earth' || planet.id === 'jupiter' || planet.id === 'saturn') return { w: 4096, h: 2048 };
  if (planet.id === 'mars' || planet.id === 'neptune' || planet.id === 'uranus') return { w: 3584, h: 1792 };
  return { w: 3072, h: 1536 };
}
function noise2(x, y) { return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123); }
function fbm(x, y, octaves = 5) {
  let total = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.13;
  }
  return total / norm;
}
function drawTextShadow(text, x, y, fill, font, align = 'left') {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(text, x + 2, y + 2);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}
function solveKepler(meanAnomaly, eccentricity) {
  let E = eccentricity < 0.8 ? meanAnomaly : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - eccentricity * Math.sin(E) - meanAnomaly;
    const fp = 1 - eccentricity * Math.cos(E);
    E -= f / fp;
  }
  return E;
}

const PLANETS = [
  {
    id: 'mercury', name: 'Mercury', kind: 'Rocky world', displayOrbit: 120, radius: 9,
    aAU: 0.38709893, e: 0.20563069, inclinationDeg: 7.00487, ascendingNodeDeg: 48.33167,
    perihelionLongitudeDeg: 77.45645, meanLongitudeDeg: 252.25084, siderealDays: 87.9691,
    rotationDays: 58.646, axialTiltDeg: 0.03,
    description: 'The smallest planet, baked by the Sun on one side and frozen on the other. Its cratered surface looks like a scarred stone world.',
    subtitle: 'Orbital position uses approximate real heliocentric elements',
    palette: ['#9a9aa1', '#6b6b73', '#babac2'],
    facts: { 'Diameter': '4,879 km', 'Day Length': '58.6 Earth days', 'Year': '87.97 days', 'Moons': '0' },
    labels: [{ lat: 6, lon: 20, title: 'Caloris Basin' }, { lat: -18, lon: -42, title: 'Heavily cratered terrain' }],
    type: 'rock',
  },
  {
    id: 'venus', name: 'Venus', kind: 'Cloud-shrouded world', displayOrbit: 165, radius: 15,
    aAU: 0.72333199, e: 0.00677323, inclinationDeg: 3.39471, ascendingNodeDeg: 76.68069,
    perihelionLongitudeDeg: 131.53298, meanLongitudeDeg: 181.97973, siderealDays: 224.70069,
    rotationDays: -243.025, axialTiltDeg: 177.36,
    description: 'Venus hides its surface under thick sulfuric clouds. The visible planet is a luminous, turbulent blanket of pale yellow atmosphere.',
    subtitle: 'Dense atmosphere, retrograde spin, runaway greenhouse heat',
    palette: ['#f3d58a', '#d1aa5d', '#fff0c2'],
    facts: { 'Diameter': '12,104 km', 'Surface Temp': '465°C', 'Year': '224.70 days', 'Moons': '0' },
    labels: [{ lat: 12, lon: -10, title: 'High cloud tops' }, { lat: -22, lon: 50, title: 'Sulfuric cloud swirls' }],
    type: 'venus',
  },
  {
    id: 'earth', name: 'Earth', kind: 'Ocean world', displayOrbit: 220, radius: 16,
    aAU: 1.00000011, e: 0.01671022, inclinationDeg: 0.00005, ascendingNodeDeg: -11.26064,
    perihelionLongitudeDeg: 102.94719, meanLongitudeDeg: 100.46435, siderealDays: 365.25636,
    rotationDays: 0.99726968, axialTiltDeg: 23.44,
    description: 'Earth mixes oceans, continents, clouds, and polar ice. In shadow, faint city-light style glows hint at life and civilization.',
    subtitle: 'Liquid water, weather, continents, life',
    palette: ['#1f6fff', '#178a4d', '#d6c099'],
    facts: { 'Diameter': '12,742 km', 'Atmosphere': 'Nitrogen / Oxygen', 'Year': '365.26 days', 'Moons': '1' },
    labels: [{ lat: 12, lon: 8, title: 'Africa' }, { lat: 46, lon: 98, title: 'Asia' }, { lat: -14, lon: -60, title: 'South America' }, { lat: 72, lon: -42, title: 'Greenland / Arctic ice' }],
    type: 'earth',
  },
  {
    id: 'mars', name: 'Mars', kind: 'Desert planet', displayOrbit: 285, radius: 12,
    aAU: 1.52366231, e: 0.09341233, inclinationDeg: 1.85061, ascendingNodeDeg: 49.57854,
    perihelionLongitudeDeg: 336.04084, meanLongitudeDeg: 355.45332, siderealDays: 686.97959,
    rotationDays: 1.025957, axialTiltDeg: 25.19,
    description: 'Mars shows rusty plains, dark volcanic provinces, giant canyon systems, and bright polar caps.',
    subtitle: 'Dust storms, canyons, polar ice',
    palette: ['#cf6e42', '#8d3c28', '#f4d6c4'],
    facts: { 'Diameter': '6,779 km', 'Gravity': '0.38 g', 'Year': '686.98 days', 'Moons': '2' },
    labels: [{ lat: 2, lon: -72, title: 'Olympus Mons region' }, { lat: -14, lon: -60, title: 'Valles Marineris' }, { lat: 82, lon: 30, title: 'North polar cap' }],
    type: 'mars',
  },
  {
    id: 'jupiter', name: 'Jupiter', kind: 'Gas giant', displayOrbit: 405, radius: 36,
    aAU: 5.20336301, e: 0.04839266, inclinationDeg: 1.30530, ascendingNodeDeg: 100.55615,
    perihelionLongitudeDeg: 14.75385, meanLongitudeDeg: 34.40438, siderealDays: 4332.589,
    rotationDays: 0.41354, axialTiltDeg: 3.13,
    description: 'Jupiter is rendered with layered cloud bands, soft storms, and the iconic Great Red Spot.',
    subtitle: 'Colossal gas giant with giant storms',
    palette: ['#e5c29b', '#b77643', '#f0dfbd'],
    facts: { 'Diameter': '139,820 km', 'Great Red Spot': 'Bigger than Earth', 'Year': '11.86 Earth years', 'Moons': '95+' },
    labels: [{ lat: -21, lon: -25, title: 'Great Red Spot' }, { lat: 8, lon: 46, title: 'Equatorial cloud belts' }],
    type: 'jupiter',
  },
  {
    id: 'saturn', name: 'Saturn', kind: 'Ringed gas giant', displayOrbit: 540, radius: 30,
    aAU: 9.53707032, e: 0.05415060, inclinationDeg: 2.48446, ascendingNodeDeg: 113.71504,
    perihelionLongitudeDeg: 92.43194, meanLongitudeDeg: 49.94432, siderealDays: 10759.22,
    rotationDays: 0.44401, axialTiltDeg: 26.73,
    description: 'Saturn appears soft and golden, with banded atmosphere and broad rings rendered as layered translucent ice bands.',
    subtitle: 'Elegant rings and pale atmospheric bands',
    palette: ['#e7d5a3', '#b99856', '#fff1c4'],
    facts: { 'Diameter': '116,460 km', 'Rings': 'Ice and rock', 'Year': '29.45 Earth years', 'Moons': '145+' },
    labels: [{ lat: 18, lon: 20, title: 'Upper atmosphere haze' }, { lat: 0, lon: -42, title: 'Equatorial bands' }, { lat: 0, lon: 0, title: 'Ring plane' }],
    type: 'saturn',
    ring: { inner: 1.35, outer: 2.25 },
  },
  {
    id: 'uranus', name: 'Uranus', kind: 'Ice giant', displayOrbit: 650, radius: 22,
    aAU: 19.19126393, e: 0.04716771, inclinationDeg: 0.76986, ascendingNodeDeg: 74.22988,
    perihelionLongitudeDeg: 170.96424, meanLongitudeDeg: 313.23218, siderealDays: 30688.5,
    rotationDays: -0.71833, axialTiltDeg: 97.77,
    description: 'Uranus is subtle and glassy, with cold cyan tones and faint atmospheric banding.',
    subtitle: 'Methane-rich ice giant with tilted axis',
    palette: ['#88dddf', '#6dc4d2', '#c8ffff'],
    facts: { 'Diameter': '50,724 km', 'Axis Tilt': '97.8°', 'Year': '84.0 Earth years', 'Moons': '27' },
    labels: [{ lat: 18, lon: 14, title: 'Methane haze' }, { lat: -8, lon: -32, title: 'Subtle cloud bands' }],
    type: 'uranus',
    ring: { inner: 1.25, outer: 1.5, subtle: true },
  },
  {
    id: 'neptune', name: 'Neptune', kind: 'Dynamic ice giant', displayOrbit: 760, radius: 21,
    aAU: 30.06896348, e: 0.00858587, inclinationDeg: 1.76917, ascendingNodeDeg: 131.72169,
    perihelionLongitudeDeg: 44.97135, meanLongitudeDeg: 304.88003, siderealDays: 60182.0,
    rotationDays: 0.67125, axialTiltDeg: 28.32,
    description: 'Neptune glows deep blue, with luminous cloud streaks and storm systems inspired by the Great Dark Spot.',
    subtitle: 'Deep blue methane atmosphere and storms',
    palette: ['#2f78ff', '#1738a8', '#77b7ff'],
    facts: { 'Diameter': '49,244 km', 'Winds': 'Up to 2,100 km/h', 'Year': '164.8 Earth years', 'Moons': '14' },
    labels: [{ lat: -20, lon: 28, title: 'Dark storm region' }, { lat: 16, lon: -40, title: 'Bright methane cloud tops' }],
    type: 'neptune',
  },
];

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function initStars() {
  stars.length = 0;
  for (let i = 0; i < 1600; i++) {
    stars.push({
      x: Math.random(), y: Math.random(),
      size: Math.random() ** 2 * 2.4 + 0.2,
      alpha: Math.random() * 0.9 + 0.1,
      hue: 210 + Math.random() * 60,
      pulse: Math.random() * Math.PI * 2,
    });
  }
}

function initRingDots() {
  ringDots.length = 0;
  for (let i = 0; i < 520; i++) {
    const r = lerp(1.45, 2.15, Math.random());
    const a = Math.random() * Math.PI * 2;
    ringDots.push({ r, a, s: Math.random() * 1.4 + 0.4, alpha: Math.random() * 0.45 + 0.15 });
  }
}

function buildTextures() {
  for (const p of PLANETS) {
    const { w, h } = textureSizeForPlanet(p);
    const tex = generateTexture(p, w, h);
    textures.set(p.id, tex);
    const sample = tex.getContext('2d').getImageData(0, 0, tex.width, tex.height);
    textureSamples.set(p.id, sample);
    frameCache.set(p.id, buildOverviewFrames(p, tex));
  }
}

function generateTexture(planet, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  const img = g.createImageData(width, height);
  const data = img.data;
  const cols = planet.palette.map(hexToRgb);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const lat = (0.5 - v) * Math.PI;
    const sinLat = Math.sin(lat);
    for (let x = 0; x < width; x++) {
      const u = x / width;
      let color = cols[0];
      const n1 = fbm(u * 3.8 + 10, v * 3.8 + 20, 6);
      const n2 = fbm(u * 10.2 + 30, v * 8.6 + 40, 4);
      const idx = (y * width + x) * 4;

      if (planet.type === 'rock') {
        const k = clamp(0.25 + n1 * 0.9 + n2 * 0.3, 0, 1);
        color = mixColor(cols[1], cols[2], k);
        const crater = Math.sin(u * 60 + n2 * 8) * Math.sin(v * 80 + n1 * 8);
        if (crater > 0.95) color = mulColor(color, 0.65);
      } else if (planet.type === 'venus') {
        const bands = 0.5 + 0.5 * Math.sin(v * 34 + n1 * 12 + Math.sin(u * 9));
        color = mixColor(cols[1], cols[2], bands * 0.75 + n1 * 0.25);
      } else if (planet.type === 'earth') {
        const landShape = fbm(u * 2.1 + 4, v * 2.5 + 8, 5) + 0.55 * fbm(u * 8 + 40, v * 6 + 20, 4);
        const wave = 0.12 * Math.sin((u + v) * 15) + 0.08 * Math.sin(u * 40 - v * 20);
        const continentMask = landShape + wave;
        const ocean = mixColor(hexToRgb('#0b2a6f'), cols[0], clamp(0.35 + n2 * 0.8, 0, 1));
        const vegetation = mixColor(hexToRgb('#256d3f'), cols[1], clamp(n2 * 0.8, 0, 1));
        const desert = mixColor(hexToRgb('#b5935a'), cols[2], clamp(n1 * 0.5 + 0.3, 0, 1));
        const ice = hexToRgb('#f2fbff');
        if (Math.abs(sinLat) > 0.84) {
          color = mixColor(desert, ice, clamp((Math.abs(sinLat) - 0.84) / 0.16, 0, 1));
        } else if (continentMask > 0.78 || (Math.abs(lat) < 0.4 && continentMask > 0.7)) {
          const dryness = clamp((continentMask - 0.72) * 2.3 + 0.2 * n2, 0, 1);
          color = mixColor(vegetation, desert, dryness);
        } else {
          color = ocean;
        }
      } else if (planet.type === 'mars') {
        const dark = fbm(u * 5 + 13, v * 5 + 14, 5);
        color = mixColor(cols[0], cols[2], 0.18 + n1 * 0.2);
        if (dark > 0.72) color = mixColor(cols[1], color, 0.45);
        if (Math.abs(sinLat) > 0.86) color = mixColor(color, hexToRgb('#fff4ea'), 0.75);
        const canyon = Math.exp(-Math.abs((v - 0.55) * 18 + Math.sin(u * 10) * 2));
        if (canyon > 0.3) color = mixColor(cols[1], color, 0.15);
      } else if (planet.type === 'jupiter' || planet.type === 'saturn') {
        const stripes = 0.5 + 0.5 * Math.sin(v * (planet.type === 'jupiter' ? 42 : 32) + n1 * 8);
        color = mixColor(cols[0], cols[1], stripes);
        color = mixColor(color, cols[2], clamp(n2 * 0.25, 0, 1));
        if (planet.type === 'jupiter') {
          const spot = Math.exp(-(((u - 0.31) ** 2) / 0.003 + ((v - 0.62) ** 2) / 0.009));
          if (spot > 0.02) color = mixColor(hexToRgb('#a34d2b'), color, clamp(1 - spot * 1.2, 0, 1));
        }
      } else if (planet.type === 'uranus') {
        const subtle = 0.55 + 0.18 * Math.sin(v * 22 + n1 * 6);
        color = mixColor(cols[1], cols[2], subtle);
      } else if (planet.type === 'neptune') {
        const subtle = 0.5 + 0.22 * Math.sin(v * 28 + n1 * 8);
        color = mixColor(cols[1], cols[2], subtle);
        const storm = Math.exp(-(((u - 0.58) ** 2) / 0.006 + ((v - 0.62) ** 2) / 0.02));
        if (storm > 0.04) color = mixColor(hexToRgb('#14276d'), color, clamp(1 - storm, 0, 1));
      }

      data[idx] = color.r;
      data[idx + 1] = color.g;
      data[idx + 2] = color.b;
      data[idx + 3] = 255;
    }
  }

  g.putImageData(img, 0, 0);
  if (planet.type === 'earth') {
    g.globalAlpha = 0.28;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const w = 40 + Math.random() * 150;
      const h = 8 + Math.random() * 30;
      g.beginPath();
      g.ellipse(x, y, w, h, Math.random() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  return c;
}

function buildOverviewFrames(planet, texture) {
  const frames = [];
  const count = 24;
  for (let i = 0; i < count; i++) {
    const c = document.createElement('canvas');
    c.width = 224;
    c.height = 224;
    const g = c.getContext('2d');
    const phase = (i / count) * Math.PI * 2;
    renderSphereMapped(g, texture, 112, 112, 86, phase, { x: -0.82, y: -0.28, z: 0.48 }, planet, true);
    frames.push(c);
  }
  return frames;
}

function renderSphereMapped(g, texture, cx, cy, radius, rotation, lightDir, planet, lowRes = false, pitch = 0) {
  const quality = lowRes ? 1.35 : Math.min(2.35, Math.max(1.75, radius / 170));
  const size = Math.max(2, Math.round(radius * 2 * quality));
  const renderRadius = size * 0.5;
  const img = g.createImageData(size, size);
  const data = img.data;
  const sample = textureSamples.get(planet.id);
  const texData = sample.data;
  const texW = sample.width;
  const texH = sample.height;
  const invR = 1 / renderRadius;
  const lx = lightDir.x, ly = lightDir.y, lz = lightDir.z;
  const specPower = planet.type === 'earth' ? 22 : 14;
  const specStrength = planet.type === 'earth' ? 0.35 : (planet.type.includes('upiter') || planet.type === 'saturn' ? 0.18 : 0.1);
  for (let py = 0; py < size; py++) {
    const sy = (py - renderRadius + 0.5) * invR;
    for (let px = 0; px < size; px++) {
      const sx = (px - renderRadius + 0.5) * invR;
      const rr = sx * sx + sy * sy;
      const idx = (py * size + px) * 4;
      if (rr > 1) {
        data[idx + 3] = 0;
        continue;
      }
      const sz = Math.sqrt(1 - rr);
      const nx = sx;
      const ny = -sy;
      const nz = sz;

      const rotated = rotateObjectPoint(nx, ny, nz, rotation, pitch);
      const lon = Math.atan2(rotated.x, rotated.z);
      const lat = Math.asin(clamp(rotated.y, -1, 1));
      const u = ((lon / (Math.PI * 2)) + 0.5 + 1000) % 1;
      const v = 0.5 - lat / Math.PI;
      const tx = ((Math.floor(u * texW) % texW) + texW) % texW;
      const ty = clamp(Math.floor(v * texH), 0, texH - 1);
      const tidx = (ty * texW + tx) * 4;
      let r = texData[tidx], gr = texData[tidx + 1], b = texData[tidx + 2];

      let diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
      diffuse = lowRes ? Math.pow(diffuse, 0.9) : Math.pow(diffuse, 1.02);
      const fresnel = Math.pow(1 - nz, 3);
      const ambient = planet.type === 'earth' ? 0.18 : 0.15;
      let shade = ambient + diffuse * 0.92;
      if (planet.type === 'earth' && diffuse < 0.25) {
        const night = 1 - clamp(diffuse / 0.25, 0, 1);
        const city = fbm(u * 22 + 17, v * 18 + 23, 4);
        if (city > 0.72) {
          r = lerp(r, 255, night * 0.42);
          gr = lerp(gr, 197, night * 0.22);
          b = lerp(b, 96, night * 0.1);
        }
      }
      if (planet.type === 'venus') shade += 0.14 * fresnel;
      if (planet.type === 'earth') shade += 0.18 * fresnel;
      if (planet.type === 'neptune' || planet.type === 'uranus') shade += 0.08 * fresnel;

      const hx = lx, hy = ly, hz = lz + 1;
      const hnorm = Math.hypot(hx, hy, hz) || 1;
      const hxN = hx / hnorm, hyN = hy / hnorm, hzN = hz / hnorm;
      const spec = Math.pow(Math.max(0, nx * hxN + ny * hyN + nz * hzN), specPower) * specStrength;
      const rim = fresnel * (planet.type === 'earth' ? 0.7 : 0.35);
      let finalR = clamp(r * shade + 255 * spec + 160 * rim * 0.08, 0, 255);
      let finalG = clamp(gr * shade + 255 * spec + 190 * rim * 0.12, 0, 255);
      let finalB = clamp(b * shade + 255 * spec + 255 * rim * 0.25, 0, 255);
      if (planet.type === 'earth' && fresnel > 0.25) finalB = clamp(finalB + 28 * fresnel, 0, 255);

      data[idx] = finalR;
      data[idx + 1] = finalG;
      data[idx + 2] = finalB;
      data[idx + 3] = 255;
    }
  }
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  out.getContext('2d').putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(out, cx - radius, cy - radius, radius * 2, radius * 2);
}

function orbitalWorldPoint(planet, eccentricAnomaly) {
  const xPrime = planet.aAU * (Math.cos(eccentricAnomaly) - planet.e);
  const yPrime = planet.aAU * Math.sqrt(1 - planet.e * planet.e) * Math.sin(eccentricAnomaly);
  const omega = degToRad(planet.perihelionLongitudeDeg - planet.ascendingNodeDeg);
  const inc = degToRad(planet.inclinationDeg);
  const node = degToRad(planet.ascendingNodeDeg);

  const x1 = xPrime * Math.cos(omega) - yPrime * Math.sin(omega);
  const y1 = xPrime * Math.sin(omega) + yPrime * Math.cos(omega);
  const z1 = 0;

  const x2 = x1;
  const y2 = y1 * Math.cos(inc) - z1 * Math.sin(inc);
  const z2 = y1 * Math.sin(inc) + z1 * Math.cos(inc);

  const x3 = x2 * Math.cos(node) - y2 * Math.sin(node);
  const y3 = x2 * Math.sin(node) + y2 * Math.cos(node);
  const z3 = z2;

  const scale = planet.displayOrbit / planet.aAU;
  return { x: x3 * scale, y: z3 * scale, z: y3 * scale };
}

function worldPos(planet, jd = simulationJD) {
  const meanMotion = (Math.PI * 2) / planet.siderealDays;
  const meanLongitude = degToRad(planet.meanLongitudeDeg) + meanMotion * (jd - J2000_JD);
  const meanAnomaly = normalizeRad(meanLongitude - degToRad(planet.perihelionLongitudeDeg));
  const E = solveKepler(meanAnomaly, planet.e);
  return orbitalWorldPoint(planet, E);
}

function spinAngle(planet, jd = simulationJD) {
  if (!planet.rotationDays || !Number.isFinite(planet.rotationDays)) return 0;
  return normalizeRad(((jd - J2000_JD) / planet.rotationDays) * Math.PI * 2);
}

function updateInfo(planet, mode) {
  if (!planet) {
    planetNameEl.textContent = 'Sun';
    planetSubtitleEl.textContent = 'Real-time anchor of our solar system';
    planetDescriptionEl.textContent = 'Planet positions now start from the current system time and follow approximate real heliocentric orbital elements. Distances remain visually compressed so outer planets stay on screen.';
    detailBadgeEl.textContent = 'Overview Focus';
    factsGridEl.innerHTML = '';
    return;
  }
  planetNameEl.textContent = planet.name;
  planetSubtitleEl.textContent = planet.subtitle;
  planetDescriptionEl.textContent = planet.description;
  detailBadgeEl.textContent = mode === 'detail' ? 'Cinematic Detail Mode' : 'Overview Focus';
  factsGridEl.innerHTML = '';
  const extraFacts = {
    'Orbital Tilt': `${planet.inclinationDeg.toFixed(2)}°`,
    'Axial Tilt': `${planet.axialTiltDeg.toFixed(2)}°`,
  };
  Object.entries({ ...planet.facts, ...extraFacts }).forEach(([k, v]) => {
    const card = document.createElement('div');
    card.className = 'fact-card';
    card.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
    factsGridEl.appendChild(card);
  });
}

function setFocus(planet, quiet = false) {
  focusedPlanet = planet;
  if (!planet) {
    targetCamera = { x: 0, y: 0, zoom: 1.0 };
    statusTextEl.textContent = 'Tip: drag to rotate the system, click a planet, then double click to enter detail mode.';
    updateInfo(null, 'overview');
    return;
  }
  const projected = projectOverviewWorld(worldPos(planet));
  targetCamera.x = projected.x;
  targetCamera.y = projected.y;
  targetCamera.zoom = clamp(config.focusZoom * (16 / Math.max(planet.radius, 14)), 1.2, 2.5);
  updateInfo(planet, detailMode ? 'detail' : 'overview');
  if (!quiet) statusTextEl.textContent = `${planet.name} selected. Orbital position is now tied to the simulated astronomical clock.`;
}

function enterDetail(planet) {
  if (!planet) return;
  detailMode = true;
  focusedPlanet = planet;
  targetDetailZoom = 1.0;
  detailZoom = 1.0;
  targetDetailYaw = 0;
  detailYaw = 0;
  targetDetailTilt = degToRad(planet.axialTiltDeg) * 0.18;
  detailTilt = targetDetailTilt;
  updateInfo(planet, 'detail');
  statusTextEl.textContent = `${planet.name} detail mode. Drag to rotate the viewing angle, wheel to zoom, Esc to go back.`;
}

function leaveDetail() {
  detailMode = false;
  targetDetailZoom = 1.0;
  targetDetailYaw = 0;
  targetDetailTilt = 0.08;
  if (focusedPlanet) {
    updateInfo(focusedPlanet, 'overview');
    statusTextEl.textContent = `${focusedPlanet.name} overview. Double click again for detail mode.`;
  } else {
    updateInfo(null, 'overview');
  }
}

function drawBackground() {
  ctx.clearRect(0, 0, W, H);

  const bg1 = ctx.createRadialGradient(W * 0.22, H * 0.18, 0, W * 0.22, H * 0.18, W * 0.65);
  bg1.addColorStop(0, 'rgba(40,70,180,0.14)');
  bg1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg1;
  ctx.fillRect(0, 0, W, H);

  const bg2 = ctx.createRadialGradient(W * 0.8, H * 0.1, 0, W * 0.8, H * 0.1, W * 0.35);
  bg2.addColorStop(0, 'rgba(255,150,80,0.10)');
  bg2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg2;
  ctx.fillRect(0, 0, W, H);

  for (const s of stars) {
    const x = s.x * W;
    const y = s.y * H;
    const pulse = 0.65 + 0.35 * Math.sin(appTime * 0.08 + s.pulse);
    const a = s.alpha * pulse;
    ctx.fillStyle = `hsla(${s.hue}, 90%, 88%, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, s.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSunAt(pos) {
  const sunR = 58 * camera.zoom;
  const glow = ctx.createRadialGradient(pos.x, pos.y, sunR * 0.2, pos.x, pos.y, sunR * 3.2);
  glow.addColorStop(0, 'rgba(255,252,220,0.95)');
  glow.addColorStop(0.12, 'rgba(255,202,103,0.90)');
  glow.addColorStop(0.33, 'rgba(255,135,44,0.45)');
  glow.addColorStop(1, 'rgba(255,90,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, sunR * 3.2, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(pos.x - sunR * 0.25, pos.y - sunR * 0.25, sunR * 0.12, pos.x, pos.y, sunR);
  core.addColorStop(0, '#fff8d3');
  core.addColorStop(0.42, '#ffc85f');
  core.addColorStop(0.78, '#ff8f2f');
  core.addColorStop(1, '#dc4d16');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, sunR, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlanetOverview(item) {
  const p = item.p;
  const pos = item.screen;
  const r = Math.max(5, p.radius * camera.zoom);
  if (p.ring) drawOverviewRing(p, pos, r);
  const frames = frameCache.get(p.id);
  const phase = spinAngle(p);
  const frameIndex = Math.floor((phase / (Math.PI * 2)) * frames.length) % frames.length;
  const frame = frames[(frameIndex + frames.length) % frames.length];
  ctx.drawImage(frame, pos.x - r * 1.02, pos.y - r * 1.02, r * 2.04, r * 2.04);

  if (focusedPlanet?.id === p.id) {
    ctx.strokeStyle = 'rgba(120, 210, 255, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  const mouse = currentMouse();
  if (mouse && Math.hypot(mouse.x - pos.x, mouse.y - pos.y) < r + 8) hoveredPlanet = p;
  if (camera.zoom > 1.1 || focusedPlanet?.id === p.id) {
    drawTextShadow(p.name, pos.x, pos.y + r + 18, '#edf4ff', '600 13px Inter', 'center');
  }
}

function drawOverview() {
  drawBackground();
  modeLabel.textContent = 'Overview';
  zoomLabel.textContent = `${camera.zoom.toFixed(2)}×`;
  timeLabel.textContent = formatSimRate(timeScale);
  realTimeLabel.textContent = formatLocalTime(new Date());
  simTimeLabel.textContent = formatSimUTC(simulationDate);

  hoveredPlanet = null;

  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${config.orbitOpacity})`;
  ctx.lineWidth = 1;
  for (const p of PLANETS) drawOrbitPath(p);
  ctx.restore();

  const sunProjected = projectOverviewWorld({ x: 0, y: 0, z: 0 });
  const sunScreen = screenFromProjected(sunProjected);
  const sunDepth = sunProjected.depth;

  const positioned = PLANETS.map((p) => {
    const world = worldPos(p);
    const projected = projectOverviewWorld(world);
    const screen = screenFromProjected(projected);
    return { p, world, projected, screen };
  }).sort((a, b) => a.projected.depth - b.projected.depth);

  for (const item of positioned) if (item.projected.depth < sunDepth) drawPlanetOverview(item);
  drawSunAt(sunScreen);
  for (const item of positioned) if (item.projected.depth >= sunDepth) drawPlanetOverview(item);

  if (hoveredPlanet && !focusedPlanet) {
    statusTextEl.textContent = `Hovering ${hoveredPlanet.name}. Click to focus.`;
  }
}

function drawOrbitPath(planet) {
  const steps = 300;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const E = (i / steps) * Math.PI * 2;
    const projected = projectOverviewWorld(orbitalWorldPoint(planet, E));
    const pos = screenFromProjected(projected);
    if (i === 0) ctx.moveTo(pos.x, pos.y);
    else ctx.lineTo(pos.x, pos.y);
  }
  ctx.stroke();
}

function drawOverviewRing(planet, pos, r) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(-0.22);
  const inner = r * planet.ring.inner;
  const outer = r * planet.ring.outer;
  const grad = ctx.createLinearGradient(-outer, 0, outer, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.2, planet.ring.subtle ? 'rgba(175,225,255,0.16)' : 'rgba(255,245,220,0.20)');
  grad.addColorStop(0.5, planet.ring.subtle ? 'rgba(190,245,255,0.28)' : 'rgba(255,240,200,0.36)');
  grad.addColorStop(0.8, planet.ring.subtle ? 'rgba(175,225,255,0.16)' : 'rgba(255,245,220,0.20)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, outer, outer * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.ellipse(0, 0, inner, inner * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDetail() {
  drawBackground();
  modeLabel.textContent = 'Detail';
  zoomLabel.textContent = `${detailZoom.toFixed(2)}×`;
  timeLabel.textContent = formatSimRate(timeScale);
  realTimeLabel.textContent = formatLocalTime(new Date());
  simTimeLabel.textContent = formatSimUTC(simulationDate);
  const p = focusedPlanet || PLANETS[2];
  const texture = textures.get(p.id);
  const cx = W * 0.5;
  const cy = H * 0.55;
  const R = config.detailRadius * detailZoom;

  ctx.save();
  const vignette = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, Math.max(W, H) * 0.6);
  vignette.addColorStop(0, 'rgba(60,80,130,0.10)');
  vignette.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  if (p.ring) drawDetailRing(p, cx, cy, R);
  const rotation = spinAngle(p) + detailYaw;
  renderSphereMapped(ctx, texture, cx, cy, R, rotation, { x: -0.88, y: -0.3, z: 0.45 }, p, false, detailTilt);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  drawDetailLabels(p, cx, cy, R, rotation, detailTilt);
}

function drawDetailRing(planet, cx, cy, R) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.25);
  const inner = R * planet.ring.inner;
  const outer = R * planet.ring.outer;
  const base = ctx.createLinearGradient(-outer, 0, outer, 0);
  base.addColorStop(0, 'rgba(255,255,255,0)');
  base.addColorStop(0.12, planet.ring.subtle ? 'rgba(175,235,255,0.18)' : 'rgba(255,235,200,0.24)');
  base.addColorStop(0.32, planet.ring.subtle ? 'rgba(210,255,255,0.28)' : 'rgba(255,246,220,0.52)');
  base.addColorStop(0.5, planet.ring.subtle ? 'rgba(230,255,255,0.34)' : 'rgba(255,255,235,0.64)');
  base.addColorStop(0.68, planet.ring.subtle ? 'rgba(210,255,255,0.28)' : 'rgba(255,246,220,0.52)');
  base.addColorStop(0.88, planet.ring.subtle ? 'rgba(175,235,255,0.18)' : 'rgba(255,235,200,0.24)');
  base.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.ellipse(0, 0, outer, outer * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.ellipse(0, 0, inner, inner * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  for (const dot of ringDots) {
    const x = Math.cos(dot.a) * dot.r * R;
    const y = Math.sin(dot.a) * dot.r * R * 0.34;
    ctx.fillStyle = planet.ring.subtle ? `rgba(210,255,255,${dot.alpha * 0.45})` : `rgba(255,250,230,${dot.alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, dot.s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDetailLabels(planet, cx, cy, R, rotation, pitch) {
  if (!planet.labels) return;
  ctx.save();
  ctx.font = '600 13px Inter';
  ctx.lineWidth = 1.2;
  for (const label of planet.labels) {
    const lat = label.lat * Math.PI / 180;
    const lon = label.lon * Math.PI / 180;
    const baseX = Math.sin(lon) * Math.cos(lat);
    const baseY = Math.sin(lat);
    const baseZ = Math.cos(lon) * Math.cos(lat);
    const p3 = rotateObjectPoint(baseX, baseY, baseZ, rotation, pitch);
    if (p3.z <= 0) continue;
    const sx = cx + p3.x * R;
    const sy = cy - p3.y * R;
    const ex = sx + (p3.x >= 0 ? 56 : -56);
    const ey = sy + (p3.y > 0 ? -24 : 24);
    ctx.strokeStyle = 'rgba(160,220,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,220,255,0.9)';
    ctx.beginPath();
    ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
    ctx.fill();
    drawTextShadow(label.title, ex + (p3.x >= 0 ? 8 : -8), ey - 4, '#f0f6ff', '600 13px Inter', p3.x >= 0 ? 'left' : 'right');
  }
  ctx.restore();
}

function update(dt) {
  if (running) {
    const simSeconds = dt * SIM_SECONDS_PER_REAL_SECOND * timeScale;
    simulationDate = new Date(simulationDate.getTime() + simSeconds * 1000);
    simulationJD = dateToJulian(simulationDate);
    appTime += dt * timeScale;
  }
  overviewYaw = lerp(overviewYaw, targetOverviewYaw, 0.08);
  overviewTilt = lerp(overviewTilt, targetOverviewTilt, 0.08);
  detailYaw = lerp(detailYaw, targetDetailYaw, 0.12);
  detailTilt = lerp(detailTilt, targetDetailTilt, 0.12);
  if (focusedPlanet && !detailMode) {
    const projected = projectOverviewWorld(worldPos(focusedPlanet));
    targetCamera.x = projected.x;
    targetCamera.y = projected.y;
  }
  camera.x = lerp(camera.x, targetCamera.x, 0.08);
  camera.y = lerp(camera.y, targetCamera.y, 0.08);
  camera.zoom = lerp(camera.zoom, targetCamera.zoom, 0.08);
  detailZoom = lerp(detailZoom, targetDetailZoom, 0.12);
}

let pointer = { x: 0, y: 0, active: false };
function currentMouse() { return pointer.active ? pointer : null; }

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  pointer = { x, y, active: true };
  if (drag) {
    canvas.classList.add('dragging');
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    if (Math.hypot(dx, dy) > 1.5) drag.moved = true;
    if (drag.mode === 'detail') {
      targetDetailYaw += dx * 0.008;
      targetDetailTilt = clamp(targetDetailTilt - dy * 0.006, -1.1, 1.1);
    } else {
      targetOverviewYaw += dx * 0.0045;
      targetOverviewTilt = clamp(targetOverviewTilt + dy * 0.0035, 0.18, 1.25);
    }
    drag.lastX = x;
    drag.lastY = y;
  } else {
    canvas.classList.remove('dragging');
  }
});
canvas.addEventListener('mouseleave', () => { pointer.active = false; });
canvas.addEventListener('mousedown', (e) => {
  drag = { lastX: e.offsetX, lastY: e.offsetY, moved: false, mode: detailMode ? 'detail' : 'overview' };
});
window.addEventListener('mouseup', () => {
  if (drag && drag.moved) {
    lastClickTime = 0;
    suppressClick = true;
  }
  drag = null;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (detailMode) {
    targetDetailZoom = clamp(targetDetailZoom * (e.deltaY > 0 ? 0.92 : 1.08), 0.65, config.maxDetailZoom);
  } else {
    targetCamera.zoom = clamp(targetCamera.zoom * (e.deltaY > 0 ? 0.92 : 1.08), config.minOverviewZoom, config.maxOverviewZoom);
  }
}, { passive: false });

canvas.addEventListener('click', () => {
  if (detailMode) return;
  if (suppressClick) { suppressClick = false; return; }
  const now = performance.now();
  if (hoveredPlanet) {
    if (now - lastClickTime < 280 && focusedPlanet?.id === hoveredPlanet.id) {
      enterDetail(hoveredPlanet);
    } else {
      setFocus(hoveredPlanet);
    }
    lastClickTime = now;
  } else if (focusedPlanet) {
    setFocus(null);
  }
});

homeBtn.addEventListener('click', () => {
  leaveDetail();
  targetOverviewYaw = -0.42;
  targetOverviewTilt = 0.58;
  setFocus(null);
});
pauseBtn.addEventListener('click', () => {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
});

speedButtons.forEach((btn, index) => {
  btn.addEventListener('click', () => setTimeScale(Number(btn.dataset.speed)));
  btn.title = `Preset ${index + 1}: ${SPEED_LABELS[index]}`;
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    running = !running;
    pauseBtn.textContent = running ? 'Pause' : 'Resume';
  } else if (e.code === 'Enter') {
    if (focusedPlanet && !detailMode) enterDetail(focusedPlanet);
  } else if (e.code === 'Escape') {
    if (detailMode) leaveDetail();
    else setFocus(null);
  } else if (e.key === '[' || e.key === '-') {
    stepTimePreset(-1);
  } else if (e.key === ']' || e.key === '=') {
    stepTimePreset(1);
  } else if (/^[1-6]$/.test(e.key)) {
    setTimeScale(SPEED_PRESETS[Number(e.key) - 1]);
  } else if (e.key.toLowerCase() === 'r') {
    leaveDetail();
    simulationDate = new Date();
    simulationJD = dateToJulian(simulationDate);
    targetOverviewYaw = -0.42;
    targetOverviewTilt = 0.58;
    setTimeScale(1);
    setFocus(null);
  }
});

function animate(t) {
  if (!animate.last) animate.last = t;
  const dt = Math.min((t - animate.last) / 1000, 0.033);
  animate.last = t;
  update(dt);
  if (detailMode) drawDetail();
  else drawOverview();
  requestAnimationFrame(animate);
}

resize();
initStars();
initRingDots();
buildTextures();
updateInfo(null, 'overview');
updateSpeedButtons();
statusTextEl.textContent = 'Now using approximate real orbital elements from the current system time. Distances stay visually compressed so the full system remains viewable.';
requestAnimationFrame(animate);
window.addEventListener('resize', resize);
