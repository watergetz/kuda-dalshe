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

async function overpass(part) {
  const q = '[out:json][timeout:600];' + AREA + '(' + part + ');out tags center;';
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'kuda-dalshe-places/1.0 (github.com/watergetz/kuda-dalshe)' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(700000)
        });
        if (!res.ok) { console.log('  ' + new URL(url).host + ': ' + res.status); continue; }
        const j = await res.json();
        if (j.remark && !j.elements.length) { console.log('  ' + new URL(url).host + ': ' + j.remark); continue; }
        return j.elements;
      } catch (e) { console.log('  ' + new URL(url).host + ': ' + e.message); }
    }
    await sleep(30000);
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

async function main() {
  const places = [], metro = [], seen = new Map();
  for (const [name, part] of Object.entries(PARTS)) {
    console.log('Скачиваю: ' + name);
    const els = await overpass(part);
    console.log('  получено ' + els.length);
    for (const e of els) {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null) continue;
      const t = e.tags || {};
      const ll = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
      if (name === 'metro') {
        if (!metro.some((m) => m.n === t.name && hav(m.a, ll) < 1000)) metro.push({ n: t.name, a: ll });
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
    await sleep(10000); // бережём бесплатный сервер
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
