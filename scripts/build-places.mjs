// Собирает интересные места Москвы из OpenStreetMap и раскладывает их по маленьким файлам-квадратам.
// Запускается роботом GitHub Actions раз в неделю (.github/workflows/places.yml).
// Телефон потом берёт только квадраты вокруг человека — без запросов к чужим серверам.

import { mkdir, writeFile, rm } from 'node:fs/promises';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const AREA = 'area["name"="Москва"]["admin_level"="4"]["boundary"="administrative"]->.m;';
const PARTS = {
  parks: 'nwr["leisure"~"^(park|garden)$"]["name"](area.m);',
  water: 'nwr["natural"="water"]["name"](area.m);',
  tourism: 'nwr["tourism"~"^(viewpoint|attraction|artwork|museum|gallery)$"](area.m);',
  historic: 'nwr["historic"]["name"](area.m);',
  culture: 'nwr["amenity"~"^(place_of_worship|arts_centre|theatre)$"]["name"](area.m);',
  fountains: 'node["amenity"="fountain"](area.m);',
  pedestrian: 'way["highway"="pedestrian"]["name"](area.m);',
  towers: 'nwr["man_made"="water_tower"](area.m);',
  metro: 'node["railway"="station"]["station"="subway"]["name"](area.m);'
};
export const TILE_LAT = 0.02;  // ≈ 2,2 км
export const TILE_LON = 0.04;  // ≈ 2,5 км
const tileKey = (lat, lon) => Math.floor(lat / TILE_LAT) + '_' + Math.floor(lon / TILE_LON);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hav(a, b) {
  const rad = (d) => d * Math.PI / 180, R = 6371000;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function overpass(q) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'kuda-dalshe-places/1.0 (github.com/watergetz/kuda-dalshe)' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(200000)
        });
        if (!res.ok) { console.log('  ' + new URL(url).host + ': ' + res.status); continue; }
        const j = await res.json();
        if (j.remark && !j.elements.length) { console.log('  ' + new URL(url).host + ': ' + j.remark); continue; }
        return j.elements;
      } catch (e) { console.log('  ' + new URL(url).host + ': ' + e.message); }
    }
    await sleep(20000);
  }
  throw new Error('Overpass не ответил');
}

// Та же логика, что в приложении: что за место и как его подать
export function classify(t) {
  const n = t.name || '';
  if (t.access === 'private') return null;
  if (t.highway === 'pedestrian') return { g: 'street', l: 'Пешеходная улица', b: 1.5 };
  if (t.man_made === 'water_tower') return { g: 'history', l: 'Водонапорная башня', b: 2, f: 'Водонапорная башня' };
  if (t.leisure === 'park' || t.leisure === 'garden') return { g: 'park', l: /сквер/i.test(n) ? 'Сквер' : (t.leisure === 'garden' ? 'Сад' : 'Парк'), b: 2 };
  if (t.natural === 'water') return { g: 'water', l: /озер/i.test(n) || t.water === 'lake' ? 'Озеро' : 'Пруд', b: 2.5, e: 1, B: 1 };
  if (t.tourism === 'viewpoint') return { g: 'view', l: 'Смотровая точка', b: 3, e: 1 };
  if (t.tourism === 'artwork') {
    const at = { sculpture: 'Скульптура', statue: 'Скульптура', mural: 'Мурал', graffiti: 'Граффити', installation: 'Инсталляция' }[t.artwork_type] || 'Арт-объект';
    return { g: 'art', l: at, b: 2, f: at };
  }
  if (t.tourism === 'museum' || t.tourism === 'gallery' || t.amenity === 'arts_centre' || t.amenity === 'theatre') {
    return n ? { g: 'culture', l: t.tourism === 'museum' ? 'Музей' : t.amenity === 'theatre' ? 'Театр' : t.tourism === 'gallery' ? 'Галерея' : 'Культура', b: 2 } : null;
  }
  if (t.amenity === 'place_of_worship') return n ? { g: 'worship', l: t.religion === 'muslim' ? 'Мечеть' : 'Храм', b: 2 } : null;
  if (t.historic === 'memorial' || t.historic === 'monument') {
    if (['plaque', 'blue_plaque', 'stolperstein', 'stone', 'grave'].includes(t.memorial)) return null;
    return n ? { g: 'monument', l: 'Памятник', b: 1.5 } : null;
  }
  if (t.historic) return n ? { g: 'history', l: 'История', b: 2 } : null;
  if (t.amenity === 'fountain') return { g: 'fountain', l: 'Фонтан', b: 1, f: 'Фонтан' };
  if (t.tourism === 'attraction') return n ? { g: 'attraction', l: 'Достопримечательность', b: 2.5 } : null;
  return null;
}

// Москва вместе с Новой Москвой укладывается в этот прямоугольник; качаем его небольшими кусками
const BBOX = { s: 55.13, w: 36.80, n: 56.03, e: 37.97 };
const STEP_LAT = 0.15, STEP_LON = 0.2;
function chunkQuery(s, w, n, e) {
  const bb = '(' + [s, w, n, e].map((x) => x.toFixed(3)).join(',') + ')';
  return '[out:json][timeout:180];' + AREA + '(' +
    Object.values(PARTS).map((p) => p.replace('(area.m);', '(area.m)' + bb + ';')).join('') +
    ');out tags center;';
}

async function main() {
  const all = new Map();
  const chunks = [];
  for (let s = BBOX.s; s < BBOX.n; s += STEP_LAT) {
    for (let w = BBOX.w; w < BBOX.e; w += STEP_LON) chunks.push([s, w, Math.min(s + STEP_LAT, BBOX.n), Math.min(w + STEP_LON, BBOX.e)]);
  }
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const t0 = Date.now();
    try {
      const els = await overpass(chunkQuery(...chunks[i]));
      for (const e of els) all.set(e.type + e.id, e);
      console.log('Кусок ' + (i + 1) + '/' + chunks.length + ': ' + els.length + ' объектов за ' + Math.round((Date.now() - t0) / 1000) + ' с');
    } catch (e) {
      failed++;
      console.log('Кусок ' + (i + 1) + '/' + chunks.length + ': не получилось (' + e.message + ')');
    }
    await sleep(3000); // бережём бесплатный сервер
  }
  if (failed > chunks.length * 0.2) throw new Error('Не скачалось слишком много кусков: ' + failed + ' из ' + chunks.length);

  const places = [], metro = [], seen = new Map();
  for (const e of all.values()) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const t = e.tags || {};
    const ll = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
    if (t.railway === 'station') {
      if (t.name && !metro.some((m) => m.n === t.name && hav(m.a, ll) < 1000)) metro.push({ n: t.name, a: ll });
      continue;
    }
    const c = classify(t);
    if (!c) continue;
    const n = t.name || c.f || c.l;
    const key = n.toLowerCase();
    const prev = seen.get(key) || [];
    if (prev.some((p) => hav(p, ll) < 500)) continue;
    prev.push(ll); seen.set(key, prev);
    const p = { i: e.type[0] + e.id, n, a: ll, g: c.g, l: c.l, b: c.b };
    if (c.e) p.e = 1;
    if (c.B) p.B = 1;
    if (t.description && t.description.length > 20 && t.description.length < 400) p.d = t.description;
    if (t.opening_hours) p.h = t.opening_hours;
    if (t.wikipedia && t.wikipedia.startsWith('ru:')) p.w = t.wikipedia.slice(3);
    places.push(p);
  }
  if (places.length < Number(process.env.MIN_PLACES || 500)) throw new Error('Подозрительно мало мест: ' + places.length);

  const tiles = new Map();
  for (const p of places) {
    const k = tileKey(p.a[0], p.a[1]);
    if (!tiles.has(k)) tiles.set(k, []);
    tiles.get(k).push(p);
  }
  await rm('data/places', { recursive: true, force: true });
  await mkdir('data/places', { recursive: true });
  for (const [k, list] of tiles) await writeFile('data/places/' + k + '.json', JSON.stringify(list));
  await writeFile('data/metro.json', JSON.stringify(metro));
  await writeFile('data/info.json', JSON.stringify({ updated: new Date().toISOString(), places: places.length, metro: metro.length, tiles: tiles.size, tileLat: TILE_LAT, tileLon: TILE_LON }, null, 1));
  console.log('Готово: ' + places.length + ' мест, ' + metro.length + ' станций метро, ' + tiles.size + ' квадратов');
}

if (import.meta.url === 'file://' + process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
export { main };
