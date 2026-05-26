#!/usr/bin/env python3
"""
Servidor local para el Dashboard de Arrivata.
Sirve index.html y hace de proxy para la API de Anthropic (evita CORS).

Uso: python server.py
Luego abrir: http://localhost:8080
"""

import json
import os
import sys
import http.server
import urllib.request
import urllib.error

PORT = int(os.environ.get('PORT', 8080))
ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'


class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} — {fmt % args}')

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/report':
            self._proxy_report()
        else:
            self.send_error(404, 'Not found')

    def _proxy_report(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))

            api_key = body.get('apiKey', '').strip()
            payload = body.get('payload', {})

            if not api_key:
                self._json(400, {'error': {'message': 'API key requerida'}})
                return

            req = urllib.request.Request(
                ANTHROPIC_URL,
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'x-api-key': api_key,
                    'anthropic-version': '2023-06-01',
                },
                method='POST'
            )

            with urllib.request.urlopen(req, timeout=90) as resp:
                result = json.loads(resp.read())
            self._json(200, result)

        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode('utf-8'))
            except Exception:
                err_body = {'error': {'message': str(e)}}
            self._json(e.code, err_body)

        except Exception as e:
            self._json(500, {'error': {'message': str(e)}})

    def _json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def end_headers(self):
        # Add CORS on all responses
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()


if __name__ == '__main__':
    # Serve files from the directory where this script lives
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    server = http.server.HTTPServer(('', PORT), Handler)

    print()
    print('  +--------------------------------------+')
    print('  |  Arrivata Dashboard - Servidor OK    |')
    print(f'  |  http://localhost:{PORT}               |')
    print('  |  Ctrl+C para detener                 |')
    print('  +--------------------------------------+')
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Servidor detenido.')
        sys.exit(0)
