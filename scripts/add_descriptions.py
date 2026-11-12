"""Добавляет к местам описания из Википедии.

Запускается после build_places.py. Для каждого места, у которого в OpenStreetMap есть
ссылка на статью Википедии (или на Викиданные, через которые статью можно найти),
берёт первые предложения статьи и сохраняет их в поле d, а источник — в поле ds = 'w'.
"""
import glob
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = 'kuda-dalshe-places/1.0 (https://github.com/watergetz/kuda-dalshe)'
MAX_LEN = 420


def get_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 + i * 3)
        except Exception:
            time.sleep(2 + i * 3)
    return None


def wikidata_titles(qids):
    """Q-номера → названия статей русской Википедии."""
    found = {}
    qids = sorted(set(qids))
    for i in range(0, len(qids), 50):
        chunk = qids[i:i + 50]
        url = ('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks'
               '&sitefilter=ruwiki&ids=' + '|'.join(chunk))
        data = get_json(url) or {}
        for q, ent in (data.get('entities') or {}).items():
            title = ((ent.get('sitelinks') or {}).get('ruwiki') or {}).get('title')
            if title:
                found[q] = title
        time.sleep(0.3)
    return found


def clean(text):
    text = text.replace('́', '')                       # знаки ударения
    text = re.sub(r'\s*\((?:[^()]*?(?:англ|лат|нем|фр)\.[^()]*?)\)', '', text)  # переводы названия в скобках
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) <= MAX_LEN:
        return text
    # обрезаем по концу предложения
    cut = text[:MAX_LEN]
    end = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '))
    return cut[:end + 1] if end > 120 else cut.rsplit(' ', 1)[0] + '…'


def summary(title):
    t = title.split('#')[0].strip()
    if not t:
        return None
    url = 'https://ru.wikipedia.org/api/rest_v1/page/summary/' + urllib.parse.quote(t.replace(' ', '_'), safe='')
    data = get_json(url)
    if not data or data.get('type') == 'disambiguation':
        return None
    ext = (data.get('extract') or '').strip()
    if len(ext) < 40:
        return None
    return {'title': data.get('titles', {}).get('canonical', t).replace('_', ' '), 'text': clean(ext)}


STOP = {'храм', 'церковь', 'часовня', 'собор', 'парк', 'сквер', 'сад', 'пруд', 'пруды', 'озеро', 'памятник',
        'улица', 'бульвар', 'имени', 'им', 'в', 'на', 'и', 'у', 'при', 'с', 'со', 'по', 'москва', 'москве',
        'музей', 'театр', 'мемориал', 'монумент', 'скульптура', 'фонтан', 'усадьба', 'дом', 'в честь', 'святого', 'святой', 'святых'}


def tokens(s):
    s = s.lower().replace('ё', 'е')
    s = re.sub(r'[^\w\s-]', ' ', s)
    return [w for w in re.split(r'[\s-]+', s) if w and w not in STOP]


FAMILIES = [('храм', 'церк', 'собор', 'часовн'), ('парк', 'сквер', 'сад'), ('пруд', 'озер'),
            ('памятник', 'монумент', 'мемориал', 'скульптур', 'бюст'), ('музе',), ('театр',), ('усадьб',)]


def same_kind(name, title):
    """Если в названии места сказано, что это (храм, парк, пруд…), статья должна быть о том же."""
    n, t = name.lower(), title.lower()
    for fam in FAMILIES:
        if any(f in n for f in fam):
            return any(f in t for f in fam)
    return True


def same_name(name, title):
    """Все значимые слова названия места есть в названии статьи (с учётом падежей — по первым 5 буквам)."""
    if not same_kind(name, title):
        return False
    nt = [w for w in tokens(name) if len(w) >= 3]
    if not nt or sum(len(w) for w in nt) < 6:
        return False
    tt = [w[:5] for w in tokens(title.split('(')[0])]
    return all(w[:5] in tt for w in nt)


def geo_match(p):
    lat, lon = p['a']
    url = ('https://ru.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gsradius=600&gslimit=20'
           '&gscoord=%f%%7C%f' % (lat, lon))
    data = get_json(url) or {}
    for hit in (data.get('query') or {}).get('geosearch', []):
        if same_name(p['n'], hit['title']):
            return hit['title']
    return None


def main():
    files = sorted(glob.glob('data/places/*.json'))
    if not files:
        sys.exit('Нет файлов с местами — сначала запустите build_places.py')
    tiles = {f: json.load(open(f, encoding='utf-8')) for f in files}
    places = [p for lst in tiles.values() for p in lst]

    need_q = [p['q'] for p in places if p.get('q') and not p.get('w')]
    print('Ищу статьи через Викиданные:', len(need_q))
    q2t = wikidata_titles(need_q)
    for p in places:
        if not p.get('w') and p.get('q') in q2t:
            p['w'] = q2t[p['q']]
    # места без ссылки: ищем статьи Википедии рядом по координатам и берём только с совпадающим названием
    lookup = [p for p in places if not p.get('w') and p['n'] != p['l'] and p['g'] not in ('fountain',)]
    print('Ищу статьи рядом с местами без ссылки:', len(lookup))
    with ThreadPoolExecutor(max_workers=4) as pool:
        matches = list(pool.map(geo_match, lookup))
    geo_found = 0
    for p, title in zip(lookup, matches):
        if title:
            p['w'] = title
            geo_found += 1
    print('  нашлось по координатам и названию:', geo_found)

    titles = sorted({p['w'] for p in places if p.get('w')})
    print('Статей Википедии для загрузки:', len(titles))

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = dict(zip(titles, pool.map(summary, titles)))

    added = 0
    for p in places:
        s = results.get(p.get('w'))
        if s:
            p['d'] = s['text']
            p['ds'] = 'w'
            p['w'] = s['title']
            added += 1
        p.pop('q', None)
    for f, lst in tiles.items():
        with open(f, 'w', encoding='utf-8') as fh:
            json.dump(lst, fh, ensure_ascii=False, separators=(',', ':'))

    with_facts = sum(1 for p in places if p.get('f'))
    with_osm = sum(1 for p in places if p.get('d') and p.get('ds') != 'w')
    info = json.load(open('data/info.json', encoding='utf-8'))
    info['described'] = {'wikipedia': added, 'osm_description': with_osm, 'osm_facts': with_facts, 'total': len(places)}
    json.dump(info, open('data/info.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('Описания из Википедии:', added, '| свои описания из OSM:', with_osm, '| мест с фактами:', with_facts, '| всего:', len(places))


if __name__ == '__main__':
    main()
