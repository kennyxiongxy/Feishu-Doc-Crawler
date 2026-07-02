"""飞书文档爬取 - HTTP 服务与路由。"""

import argparse
import json
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config
from . import folders
from . import images
from . import lark_client
from . import markdown
from . import wiki


class FeishuHandler(BaseHTTPRequestHandler):

    def _set_headers(self, status=200, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _send_json(self, data, status=200):
        self._set_headers(status)
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _read_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > 0:
            return json.loads(self.rfile.read(content_length))
        return {}

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        if self.path == '/health':
            lark_version = config.get_lark_cli_version()
            self._send_json({
                'status': 'ok',
                'service': 'feishu-crawler-server',
                'lark_cli': {
                    'path': config.LARK_CLI,
                    'version': '.'.join(str(x) for x in lark_version) if lark_version else None,
                    'version_ok': config.is_lark_cli_version_ok(lark_version),
                    'min_version': '.'.join(str(x) for x in config.LARK_CLI_MIN_VERSION),
                }
            })
        elif self.path.startswith('/ping'):
            try:
                import subprocess
                result = subprocess.run([config.LARK_CLI, '--version'], capture_output=True, text=True, timeout=5)
                self._send_json({'status': 'ok', 'lark_cli': result.stdout.strip()})
            except Exception as e:
                self._send_json({'status': 'error', 'error': str(e)}, 500)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        try:
            data = self._read_body()
        except json.JSONDecodeError:
            self._send_json({'error': 'Invalid JSON'}, 400)
            return

        if self.path == '/discover':
            self.handle_discover(data)
        elif self.path == '/extract':
            self.handle_extract(data)
        elif self.path == '/download-image':
            self.handle_download_image(data)
        elif self.path == '/open-folder':
            self.handle_open_folder(data)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def handle_discover(self, data):
        url = data.get('url', '')
        token = data.get('token', '')

        target = url or token
        if not target:
            self._send_json({'error': 'No URL or token provided'}, 400)
            return

        print(f'[Server] Discovering sub-docs from: {target}')
        result = wiki.discover_sub_documents(
            config.LARK_CLI,
            lark_client.run_lark_cli,
            lark_client.run_lark_cli_raw,
            markdown,
            target,
            auto_find_root=True
        )

        if 'error' in result:
            self._send_json(result, 500)
        else:
            self._send_json(result)

    def handle_extract(self, data):
        url = data.get('url', '')
        token = data.get('token', '')

        if not token and url:
            token = wiki.extract_token_from_url(url)

        if not token:
            self._send_json({'error': 'Cannot extract token from URL'}, 400)
            return

        print(f'[Server] Extracting doc: {token}')
        result = lark_client.fetch_doc_content(config.LARK_CLI, token, markdown)

        if 'error' in result:
            self._send_json(result, 500)
        else:
            result['token'] = token
            self._send_json(result)

    def handle_download_image(self, data):
        file_token = data.get('file_token', '')
        if not file_token:
            self._send_json({'error': 'No file_token'}, 400)
            return
        tmp_dir = tempfile.mkdtemp(prefix='feishu_img_')
        tmp_name = file_token[:16] + '.png'
        try:
            result = lark_client.run_lark_cli_limited(
                images._download_image_impl, config.LARK_CLI, file_token, tmp_dir, tmp_name
            )
            if 'error' in result:
                self._send_json({'error': result['error']}, 500)
            else:
                self._send_json(result)
        except Exception as e:
            self._send_json({'error': str(e)[:200]}, 500)

    def handle_open_folder(self, data):
        valid, result = folders.validate_open_folder_path(data.get('path') if isinstance(data, dict) else None)
        if not valid:
            self._send_json({'error': result}, 400)
            return
        success, system, err = folders.open_folder_in_os(result)
        if success:
            self._send_json({'ok': True, 'path': result, 'system': system})
        else:
            self._send_json({'error': err, 'system': system}, 500)

    def log_message(self, format, *args):
        print(f'[Server] {args[0]}')


def main():
    parser = argparse.ArgumentParser(description='飞书文档爬取本地 API 服务')
    parser.add_argument('--port', type=int, default=config.PORT, help=f'监听端口 (默认: {config.PORT})')
    args = parser.parse_args()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), FeishuHandler)
    print('🚀 飞书文档爬取 API 服务已启动')
    print(f'   地址: http://127.0.0.1:{args.port}')
    print(f'   lark-cli: {config.LARK_CLI}')
    print('   /discover - 发现子文档列表')
    print('   /extract  - 提取单个文档内容')
    print(f'   健康检查: http://127.0.0.1:{args.port}/health')
    print('   Ctrl+C 停止服务')
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
        server.shutdown()
