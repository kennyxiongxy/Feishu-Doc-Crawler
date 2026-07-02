"""飞书文档爬取 - 图片下载。"""

import base64
import os
import subprocess


def _download_image_impl(lark_cli, file_token, tmp_dir, tmp_name):
    """Inner impl for handle_download_image — wrapped with retry + limiter."""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'
    cmd = [lark_cli, 'docs', '+media-preview', '--token', file_token, '--output', tmp_name, '--overwrite', '--as', 'user']
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env, cwd=tmp_dir)
    # Parse multi-line JSON from stdout
    output = result.stdout + result.stderr
    json_str = ''
    in_json = False
    depth = 0
    for ch in output:
        if ch == '{':
            in_json = True
            depth += 1
            json_str += ch
        elif ch == '}' and in_json:
            depth -= 1
            json_str += ch
            if depth == 0:
                break
        elif in_json:
            json_str += ch

    if not json_str:
        return {'error': 'No JSON in output'}
    try:
        import json
        j = json.loads(json_str)
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}

    if not j.get('ok'):
        return {'error': 'API returned not ok'}

    sp = j.get('data', {}).get('saved_path', '')
    if not sp or not os.path.exists(sp) or os.path.getsize(sp) <= 100:
        return {'error': 'Preview file missing or too small'}

    with open(sp, 'rb') as f:
        img_data = base64.b64encode(f.read()).decode('ascii')
    return {'ok': True, 'data': img_data, 'size': os.path.getsize(sp)}
