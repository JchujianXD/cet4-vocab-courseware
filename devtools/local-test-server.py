"""仅供本机验收：独立端口、独立演示记录，并阻止云同步连接。"""
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
MODES = {
    'due': ('早间复习', '#/drill/due'),
    'today': ('晚间复习', '#/drill/today'),
    'more': ('额外到期复习', '#/drill/more'),
    'learn': ('学习新词', '#/drill/learn'),
    'meaning': ('词义回忆', '#/drill/all?practice=meaning'),
    'recognition': ('看词选义（四选一）', '#/drill/all?practice=recognition'),
    'reverse': ('看义选词', '#/drill/all?practice=reverse'),
    'listen': ('听音选义', '#/drill/all?practice=listen'),
    'spell': ('拼写', '#/drill/all?practice=spell'),
    'context': ('语境填空', '#/drill/all?practice=context'),
    'browse': ('浏览词卡', '#/list/all'),
    'home': ('测试首页', '#/'),
}

def entries():
    found = []
    for lid, words in [('u07-l01', ['specific']), ('u08-l01', ['dose']), ('u08-l02', ['coherent', 'integrate'])]:
        lesson = json.loads((SITE / 'data' / 'lessons' / (lid + '.json')).read_text(encoding='utf-8'))
        for group in lesson['groups']:
            for entry in group['entries']:
                if entry['word'] in words:
                    found.append({'lid': lid, 'group': group['no'], 'word': entry['word'], 'no': entry['no'], 'freq': entry['freq']})
    return found

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "connect-src 'self' http://127.0.0.1:8766 http://localhost:8766 https://cdn.jsdelivr.net")
        super().end_headers()

    def html(self, body):
        content = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/test':
            links = ''.join(f'<a href="/start?mode={k}">{v[0]}</a>' for k, v in MODES.items())
            self.html('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地验收入口</title><style>body{font:16px system-ui;background:#15171b;color:#eee;margin:0;padding:24px}main{max-width:760px;margin:auto}p{color:#b9c0cc;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}a{display:block;padding:16px;background:#282b32;border:1px solid #474d5b;border-radius:9px;color:#fff;text-decoration:none;text-align:center}a:hover{border-color:#f0a044}</style><main><h1>本地验收入口</h1><p>选择模式后进入演示课件。每次选择都会重新准备四个演示词，方便反复检查。测试成绩只存当前浏览器的独立本地地址，不能连接云同步。返回此页可切换模式。</p><div class="grid">''' + links + '''</div></main></html>''')
            return
        if url.path == '/start':
            mode = parse_qs(url.query).get('mode', [''])[0]
            if mode not in MODES:
                self.send_error(404)
                return
            seed = json.dumps(entries(), ensure_ascii=False).replace('<', '\\u003c')
            destination = json.dumps(MODES[mode][1])
            self.html('''<!doctype html><meta charset="utf-8"><title>准备测试数据</title><p>正在准备演示数据…</p><script src="/srs.js"></script><script>
            const items = ''' + seed + ''', mode = ''' + json.dumps(mode) + ''', day = SRS.today(), previous = SRS.add(day,-1), now = Date.now(), doc = {};
            for (const x of items) {
              const card = {...SRS.freshCard(previous, 'local-test-' + x.word), k:x.lid, g:x.group, o:x.no, f:x.freq};
              if (mode === 'more') Object.assign(card, {a:SRS.add(day,-10),s:2,n:2,v:2,t:previous,r:'g',h:'gg',d:day});
              doc['srs:'+x.word] = [card, now]; doc[`learn:${x.lid}:g${x.group}`] = [day, now];
            }
            for (const [k,v] of Object.entries({autoSay:false,autoEx:false,voice:'ava'})) doc['set:'+k]=[v,now];
            const previousDoc = localStorage.getItem('lx:sync:doc');
            let oldTest = false;
            try {
              const old = previousDoc && JSON.parse(previousDoc), cards = Object.entries(old || {}).filter(([k,v]) => k.startsWith('srs:') && v[0]);
              oldTest = cards.length > 0 && cards.every(([,v]) => String(v[0].life || '').startsWith('local-test-')) &&
                Object.keys(old).every(k => /^(srs:|learn:|drill:|log:|evening:|browse:|set:)/.test(k));
            } catch {}
            if (localStorage.getItem('lx:sync:cfg') || (previousDoc && !localStorage.getItem('lx:local-test:owned') && !oldTest)) {
              document.body.textContent = '此测试地址已有非本工具创建的数据或云同步配置，已停止以避免覆盖。请使用未使用过的浏览器配置运行测试。';
              throw new Error('测试地址存在已有数据');
            }
            localStorage.setItem('lx:local-test:owned', '1'); localStorage.setItem('lx:sync:doc', JSON.stringify(doc));
            location.replace('/' + ''' + destination + ''');</script>''')
            return
        super().do_GET()

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18775), Handler).serve_forever()
