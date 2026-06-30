"""飞书文档爬取 - Markdown 清洗与文本处理。"""

import ast
import re
from urllib.parse import urlparse


def cell_to_text(cell):
    """将单元格值转为纯文本，处理飞书富文本段格式"""
    if cell is None:
        return ''
    if isinstance(cell, str):
        s = cell.strip()
        if s.startswith('[{') and s.endswith('}]'):
            try:
                segments = ast.literal_eval(s)
                if isinstance(segments, list):
                    return ''.join(seg.get('text', '') for seg in segments if isinstance(seg, dict))
            except (ValueError, SyntaxError):
                pass
        return cell
    if isinstance(cell, list):
        return ''.join(seg.get('text', '') if isinstance(seg, dict) else str(seg) for seg in cell)
    return str(cell)


def clean_rich_text_in_markdown(content):
    """将 Markdown 表格中嵌入的飞书富文本段（Python 对象字符串）转为纯文本"""
    def find_rich_text_segments(line):
        """Find all [{...}] patterns in a line, handling nested brackets"""
        results = []
        i = 0
        while i < len(line):
            if line[i:i+2] == '[{':
                depth = 1
                j = i + 2
                while j < len(line) and depth > 0:
                    if line[j] == '[':
                        depth += 1
                    elif line[j] == ']':
                        depth -= 1
                    j += 1
                if depth == 0:
                    results.append((i, j, line[i:j]))
                i = j
            else:
                i += 1
        return results

    lines = content.split('\n')
    result_lines = []
    for line in lines:
        if line.strip().startswith('|') and '[{' in line:
            segments = find_rich_text_segments(line)
            if segments:
                for start, end, seg_text in reversed(segments):
                    try:
                        parsed = ast.literal_eval(seg_text)
                        if isinstance(parsed, list):
                            plain_text = ''.join(seg.get('text', '') for seg in parsed if isinstance(seg, dict))
                            line = line[:start] + plain_text + line[end:]
                    except (ValueError, SyntaxError):
                        pass
        result_lines.append(line)
    return '\n'.join(result_lines)


def extract_title_from_markdown(content):
    """从 Markdown 内容中提取第一个 H1 标题"""
    match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return '未命名文档'


def extract_images(content):
    """从 Markdown 内容中提取图片 URL"""
    images = []
    pattern = r'!\[([^\]]*)\]\((https?://[^\)]+)\)'
    for match in re.finditer(pattern, content):
        alt = match.group(1)
        url = match.group(2)
        url_lower = url.lower()
        if any(skip in url_lower for skip in ['avatar', 'profile', '/icon', 'logo', 'emoj', 'badge', 'sticker', 'sprite', 'favicon']):
            continue
        ext = 'png'
        url_path = urlparse(url).path
        if '.' in url_path:
            possible_ext = url_path.rsplit('.', 1)[1].split('?')[0]
            if possible_ext in ('png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'):
                ext = possible_ext

        images.append({
            'url': url,
            'file_token': urlparse(url).path.rsplit('/', 1)[-1].split('?')[0],
            'alt': alt,
            'ext': ext
        })
    return images


def parse_cite_elements(content):
    """
    从原始 Markdown 中解析 <cite> 元素，提取子文档列表。
    <cite doc-id="XXX" file-type="wiki" title="标题" type="doc"></cite>
    """
    articles = []
    seen_ids = set()

    pattern = r'<cite\s+([^>]*?)></cite>'
    attr_pattern = r'(\S+)="([^"]*)"'

    for match in re.finditer(pattern, content, flags=re.DOTALL):
        attrs_str = match.group(1)
        attrs = dict(re.findall(attr_pattern, attrs_str))

        title = attrs.get('title', '')
        doc_id = attrs.get('doc-id', '')

        if not title or not doc_id:
            continue
        if doc_id in seen_ids:
            continue
        seen_ids.add(doc_id)

        articles.append({
            'title': title,
            'doc_token': doc_id,
            'url': f'https://internal.feishu.cn/wiki/{doc_id}',
        })
    return articles


def _fetch_sheet_raw(lark_cli, spreadsheet_token, sheet_id):
    """Inner impl: call lark-cli sheets +read, return parsed dict or error."""
    import json
    import os
    import subprocess

    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    cmd = [
        lark_cli, 'sheets', '+read',
        '--spreadsheet-token', spreadsheet_token,
        '--sheet-id', sheet_id,
        '--as', 'user',
        '--value-render-option', 'FormattedValue'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=20, env=env)
    if result.returncode != 0:
        return {'error': f'lark-cli failed: {result.stderr}'}
    try:
        data = json.loads(result.stdout)
        if not data.get('ok'):
            return {'error': 'API returned not ok'}
        return data
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}


def fetch_sheet_content(lark_cli, run_lark_cli_limited, spreadsheet_token, sheet_id):
    """读取飞书电子表格内容并转为 Markdown 表格 (含重试)"""
    data = run_lark_cli_limited(_fetch_sheet_raw, lark_cli, spreadsheet_token, sheet_id)

    if 'error' in data:
        return f'*(表格读取失败: {data["error"][:50]})*'

    values = data.get('data', {}).get('valueRange', {}).get('values', [])
    if not values or len(values) < 2:
        return '*(空表格)*'

    try:
        # 转换为 Markdown 表格
        lines = []
        # Header row
        headers = [cell_to_text(cell) for cell in values[0]]
        lines.append('| ' + ' | '.join(headers) + ' |')
        # Separator
        lines.append('|' + '|'.join([' --- ' for _ in headers]) + '|')
        # Data rows
        for row in values[1:]:
            cells = []
            for cell in row:
                text = cell_to_text(cell)
                text = text.replace('\n', ' ').replace('|', '\\|')
                cells.append(text)
            # Pad to match header count
            while len(cells) < len(headers):
                cells.append('')
            lines.append('| ' + ' | '.join(cells[:len(headers)]) + ' |')

        return '\n\n' + '\n'.join(lines) + '\n\n'
    except Exception as e:
        return f'*(表格读取异常: {str(e)[:50]})*'


def replace_sheets_with_content(content, lark_cli, run_lark_cli_limited):
    """将 <sheet> 标签替换为实际表格内容"""
    def replace_sheet(match):
        attrs_str = match.group(1)
        attrs = dict(re.findall(r'(\S+)="([^"]*)"', attrs_str))
        sheet_id = attrs.get('sheet-id', '')
        token = attrs.get('token', '')

        if not sheet_id or not token:
            return '\n\n*(内嵌电子表格 - 无法识别)*\n\n'

        print(f'[Server] Fetching sheet: {sheet_id} from {token[:20]}...')
        table_md = fetch_sheet_content(lark_cli, run_lark_cli_limited, token, sheet_id)
        return table_md

    content = re.sub(
        r'<sheet\s+([^>]*?)></sheet>',
        replace_sheet,
        content,
        flags=re.DOTALL
    )
    return content


def clean_markdown(content, lark_cli, run_lark_cli_limited):
    """清理飞书 API 返回的 Markdown 中的特殊标签"""
    # 0. 先处理表格单元格中的富文本段（Python 对象字符串 -> 纯文本）
    content = clean_rich_text_in_markdown(content)

    # 1. <callout emoji="X">...</callout> -> > **X** ...
    def replace_callout(match):
        emoji = match.group(1)
        inner = match.group(2)
        lines = inner.strip().split('\n')
        result = f'> **{emoji}**\n'
        for line in lines:
            result += f'> {line.strip()}\n'
        return result

    content = re.sub(
        r'<callout\s+emoji="([^"]*)">(.*?)</callout>',
        replace_callout,
        content,
        flags=re.DOTALL
    )

    # 2. 移除 <cite> 标签
    content = re.sub(r'<cite\s+[^>]*?></cite>', '', content)

    # 3. <sheet> -> 标记
    # 用实际表格内容替换 sheet 占位符
    content = replace_sheets_with_content(content, lark_cli, run_lark_cli_limited)

    # 4. 清理多余空行
    content = re.sub(r'\n{4,}', '\n\n\n', content)

    # 5. 清理目录下空行
    content = re.sub(r'## 目录\n\n(?:-\s*\n)*', '## 目录\n\n', content)

    return content.strip()
