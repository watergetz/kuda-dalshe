"""Собирает интересные места Москвы из готового файла карты OpenStreetMap (.osm.pbf)
и раскладывает их по маленьким файлам-квадратам в data/places/.

Запуск: python3 scripts/build_places.py moscow.osm.pbf
Запускается роботом GitHub Actions раз в неделю (.github/workflows/places.yml).
"""
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime, timezone

import osmium

BBOX = (55.13, 36.80, 56.03, 37.97)  # юг, запад, север, восток: Москва вместе с Новой Москвой
TILE_LAT, TILE_LON = 0.02, 0.04       # квадрат ≈ 2,2 × 2,5 км
MIN_PLACES = int(os.environ.get('MIN_PLACES', '500'))

ARTWORK = {'sculpture': 'Скульптура', 'statue': 'Скульптура', 'mural': 'Мурал', 'graffiti': 'Граффити', 'installation': 'Инсталляция'}
KIDS = re.compile(r'студи|детск|школ|кружок|развити|клуб|секци|курс', re.I)
SKIP_MEMORIAL = {'plaque', 'blue_plaque', 'stolperstein', 'stone', 'grave'}


def classify(t):
    """Та же логика, что в приложении: что за место и как его подать."""
    n = t.get('name', '')
    if t.get('access') == 'private':
        return None
    if t.get('highway') == 'pedestrian':
        return {'g': 'street', 'l': 'Пешеходная улица', 'b': 1.5}
    if t.get('man_made') == 'water_tower':
        return {'g': 'history', 'l': 'Водонапорная башня', 'b': 2, 'f': 'Водонапорная башня'}
    if t.get('leisure') in ('park', 'garden'):
        if not n:
            return None
        label = 'Сквер' if re.search('сквер', n, re.I) else ('Сад' if t.get('leisure') == 'garden' else 'Парк')
        return {'g': 'park', 'l': label, 'b': 2}
    if t.get('natural') == 'water':
        if not n:
            return None
        lake = re.search('озер', n, re.I) or t.get('water') == 'lake'
        return {'g': 'water', 'l': 'Озеро' if lake else 'Пруд', 'b': 2.5, 'e': 1, 'B': 1}
    if t.get('tourism') == 'viewpoint':
        return {'g': 'view', 'l': 'Смотровая точка', 'b': 3, 'e': 1}
    if t.get('tourism') == 'artwork':
        at = ARTWORK.get(t.get('artwork_type'), 'Арт-объект')
        return {'g': 'art', 'l': at, 'b': 2, 'f': at}
    if t.get('tourism') in ('museum', 'gallery') or t.get('amenity') in ('arts_centre', 'theatre'):
        if not n or KIDS.search(n):
            return None
        if t.get('tourism') == 'museum':
            label = 'Музей'
        elif t.get('amenity') == 'theatre':
            label = 'Театр'
        elif t.get('tourism') == 'gallery':
            label = 'Галерея'
        else:
            label = 'Культура'
        return {'g': 'culture', 'l': label, 'b': 2}
    if t.get('amenity') == 'place_of_worship':
        return {'g': 'worship', 'l': 'Мечеть' if t.get('religion') == 'muslim' else 'Храм', 'b': 2} if n else None
    if t.get('historic') in ('memorial', 'monument'):
        if t.get('memorial') in SKIP_MEMORIAL:
            return None
        return {'g': 'monument', 'l': 'Памятник', 'b': 1.5} if n else None
    if t.get('historic'):
        return {'g': 'history', 'l': 'История', 'b': 2} if n else None
    if t.get('amenity') == 'fountain':
        return {'g': 'fountain', 'l': 'Фонтан', 'b': 1, 'f': 'Фонтан'}
    if t.get('tourism') == 'attraction':
        return {'g': 'attraction', 'l': 'Достопримечательность', 'b': 2.5} if n else None
    return None


def is_metro(t):
    return t.get('railway') == 'station' and t.get('station') == 'subway' and t.get('name')


def hav(a, b):
    r = 6371000
    d_lat, d_lng = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(d_lng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def mean_location(node_refs):
    lats, lons = [], []
    for nr in node_refs:
        if nr.location.valid():
            lats.append(nr.location.lat)
            lons.append(nr.location.lon)
    if not lats:
        return None
    return sum(lats) / len(lats), sum(lons) / len(lons)


def collect(path):
    found = []  # (id, tags, lat, lon)
    keys = osmium.filter.KeyFilter('leisure', 'natural', 'tourism', 'historic', 'amenity', 'highway', 'man_made', 'railway')
    fp = osmium.FileProcessor(path).with_locations().with_areas().with_filter(keys)
    for obj in fp:
        if obj.is_relation():
            continue
        tags = dict(obj.tags)
        if not (classify(tags) or is_metro(tags)):
            continue
        if obj.is_node():
            if not obj.location.valid():
                continue
            found.append(('n' + str(obj.id), tags, obj.location.lat, obj.location.lon))
        elif obj.is_way():
            # замкнутые линии с парками и прудами придут ещё раз как площади; отдельно берём только улицы
            if obj.is_closed() and tags.get('highway') != 'pedestrian':
                continue
            c = mean_location(obj.nodes)
            if c:
                found.append(('w' + str(obj.id), tags, c[0], c[1]))
        elif obj.is_area():
            rings = list(obj.outer_rings())
            if not rings:
                continue
            c = mean_location(rings[0])
            if c:
                found.append((('w' if obj.from_way() else 'r') + str(obj.orig_id()), tags, c[0], c[1]))
    return found


def main():
    if len(sys.argv) < 2:
        sys.exit('Укажите файл карты: python3 scripts/build_places.py moscow.osm.pbf')
    found = collect(sys.argv[1])
    print('Найдено подходящих объектов:', len(found))

    places, metro, seen = [], [], {}
    for oid, t, lat, lon in found:
        if not in_bbox(lat, lon):
            continue
        ll = [round(lat, 5), round(lon, 5)]
        if is_metro(t):
            if not any(m['n'] == t['name'] and hav(m['a'], ll) < 1000 for m in metro):
                metro.append({'n': t['name'], 'a': ll})
            continue
        c = classify(t)
        if not c:
            continue
        name = t.get('name') or c.get('f') or c['l']
        prev = seen.setdefault(name.lower(), [])
        if any(hav(p, ll) < 500 for p in prev):
            continue
        prev.append(ll)
        p = {'i': oid, 'n': name, 'a': ll, 'g': c['g'], 'l': c['l'], 'b': c['b']}
        if c.get('e'):
            p['e'] = 1
        if c.get('B'):
            p['B'] = 1
        d = t.get('description', '')
        if 20 < len(d) < 400:
            p['d'] = d
        if t.get('opening_hours'):
            p['h'] = t['opening_hours']
        w = t.get('wikipedia', '')
        if w.startswith('ru:'):
            p['w'] = w[3:]
        places.append(p)

    if len(places) < MIN_PLACES:
        sys.exit('Подозрительно мало мест: %d' % len(places))

    tiles = {}
    for p in places:
        k = '%d_%d' % (math.floor(p['a'][0] / TILE_LAT), math.floor(p['a'][1] / TILE_LON))
        tiles.setdefault(k, []).append(p)

    shutil.rmtree('data/places', ignore_errors=True)
    os.makedirs('data/places', exist_ok=True)
    for k, lst in tiles.items():
        with open('data/places/%s.json' % k, 'w', encoding='utf-8') as f:
            json.dump(lst, f, ensure_ascii=False, separators=(',', ':'))
    with open('data/metro.json', 'w', encoding='utf-8') as f:
        json.dump(metro, f, ensure_ascii=False, separators=(',', ':'))
    groups = {}
    for p in places:
        groups[p['g']] = groups.get(p['g'], 0) + 1
    info = {'updated': datetime.now(timezone.utc).isoformat(), 'places': len(places), 'metro': len(metro),
            'tiles': len(tiles), 'tileLat': TILE_LAT, 'tileLon': TILE_LON, 'groups': groups}
    with open('data/info.json', 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    print('Готово: %d мест, %d станций метро, %d квадратов' % (len(places), len(metro), len(tiles)))
    print('По видам:', groups)


if __name__ == '__main__':
    main()
