"""Test helper: receives files PUT from the browser test and stores them under testout/browser/."""
import http.server, os
BASE = os.path.join(os.path.dirname(__file__), '..', 'testout', 'browser')
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Methods', 'PUT, OPTIONS'); self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self): self.send_response(204); self.cors(); self.end_headers()
    def do_PUT(self):
        p = os.path.normpath(os.path.join(BASE, self.path.lstrip('/')))
        if not p.startswith(os.path.normpath(BASE)): self.send_response(403); self.end_headers(); return
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f: f.write(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(201); self.cors(); self.end_headers()
http.server.HTTPServer(('127.0.0.1', 8766), H).serve_forever()
