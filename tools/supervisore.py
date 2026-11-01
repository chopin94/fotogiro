"""Modalità supervisione (solo sviluppo, non viene pubblicata su GitHub Pages).

Serve il progetto in HTTPS sulla rete locale, così il telefono può usare la
fotocamera con la versione in sviluppo, e riceve dal telefono i dati di debug
di ogni scansione (fotogrammi chiave, sagome, pose, log, STL) in
.supervisore/<data-ora>/ per analizzarli mentre si scansiona.

Uso:  python tools/supervisore.py [porta]
Poi sul telefono (stessa rete): https://<ip-del-pc>:<porta>/web/?debug&supervisore
Il certificato è autofirmato: Chrome avvisa, "Avanzate" -> "Procedi".
"""

import base64
import http.server
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, '.supervisore')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
OPENSSL = [r'C:\Program Files\Git\usr\bin\openssl.exe', 'openssl']


def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith('127.'))


def ensure_cert(ips):
    cert, key = os.path.join(BASE, 'cert.pem'), os.path.join(BASE, 'key.pem')
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    os.makedirs(BASE, exist_ok=True)
    san = ','.join(['DNS:localhost'] + [f'IP:{ip}' for ip in ips])
    for exe in OPENSSL:
        try:
            subprocess.run([exe, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '60',
                            '-keyout', key, '-out', cert, '-subj', '/CN=fotogiro-sviluppo',
                            '-addext', f'subjectAltName={san}'], check=True, capture_output=True)
            return cert, key
        except (OSError, subprocess.CalledProcessError):
            continue
    sys.exit('openssl non trovato: installa Git for Windows o OpenSSL')


SESSION = os.path.join(BASE, time.strftime('%Y%m%d-%H%M%S'))
os.makedirs(SESSION, exist_ok=True)
counter = {'n': 0}


def save_data_url(data_url, name):
    head, b64 = data_url.split(',', 1)
    with open(os.path.join(SESSION, name), 'wb') as f:
        f.write(base64.b64decode(b64))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # niente rumore: stampiamo solo gli eventi utili

    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n)
        path = self.path.split('?')[0]
        if path == '/supervisore/stl':
            name = time.strftime('modello-%H%M%S.stl')
            with open(os.path.join(SESSION, name), 'wb') as f:
                f.write(body)
            print(f'[stl] {name} ({len(body) // 1024} KB)', flush=True)
        elif path == '/supervisore/evento':
            ev = json.loads(body)
            kind = ev.get('type')
            if kind == 'keyframe':
                counter['n'] += 1
                k = counter['n']
                if ev.get('jpeg'):
                    save_data_url(ev.pop('jpeg'), f'{k:03d}.jpg')
                if ev.get('mask'):
                    save_data_url(ev.pop('mask'), f'{k:03d}-sagoma.png')
                ev['file'] = f'{k:03d}'
                r = ev.get('res', {})
                print(f"[chiave {k:03d}] az {r.get('azimuth', 0):.0f} el {r.get('elevation', 0):.0f} "
                      f"marker {r.get('markerCount')} rms {r.get('rms', 0):.2f} sfondo {r.get('background')}", flush=True)
            elif kind == 'log':
                print(f"[log] {ev.get('line')}", flush=True)
            elif kind == 'start':
                print(f"[inizio] {ev.get('mode')} {ev.get('userAgent', '')[:80]}", flush=True)
            with open(os.path.join(SESSION, 'eventi.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps(ev, ensure_ascii=False) + '\n')
            if kind == 'frame':
                with open(os.path.join(SESSION, 'ultimo.json'), 'w', encoding='utf-8') as f:
                    json.dump(ev, f, ensure_ascii=False, indent=1)
        else:
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    ips = local_ips()
    cert, key = ensure_cert(ips)
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f'Supervisione attiva. Dati in {SESSION}', flush=True)
    for ip in ips:
        if not ipaddress.ip_address(ip).is_loopback:
            print(f'  sul telefono: https://{ip}:{PORT}/web/?debug&supervisore', flush=True)
    httpd.serve_forever()
