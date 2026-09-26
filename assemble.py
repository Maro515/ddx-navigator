#!/usr/bin/env python3
"""build/00_base.html に build/*.js を順に埋め込み、単一ファイル index.html を生成する。"""
import glob, os, re
BASE = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(BASE, 'build', '00_base.html'), encoding='utf-8').read()
parts = []
for p in sorted(glob.glob(os.path.join(BASE, 'build', '*.js'))):
    src = open(p, encoding='utf-8').read().replace('</script>', '<\\/script>')
    parts.append(f'<script>/* {os.path.basename(p)} */\n{src}\n</script>')
out = html.replace('<!--SCRIPTS-->', '\n'.join(parts))
with open(os.path.join(BASE, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(out)
print('index.html written:', len(out) // 1024, 'KB')
# Artifact 用（<!doctype>/<html>/<head>/<body> を持たない本文のみ。公開側で骨組みが付与される）
title = re.search(r'<title>(.*?)</title>', out, re.S).group(1)
style = re.search(r'<style>.*?</style>', out, re.S).group(0)
body = re.search(r'<body>(.*)</body>', out, re.S).group(1)
os.makedirs(os.path.join(BASE, 'dist'), exist_ok=True)
art = f'<title>{title}</title>\n{style}\n{body}'
with open(os.path.join(BASE, 'dist', 'artifact.html'), 'w', encoding='utf-8') as f:
    f.write(art)
print('dist/artifact.html written:', len(art) // 1024, 'KB')
