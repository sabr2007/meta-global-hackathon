#!/usr/bin/env python3
"""Render the bundled, authoritative help/privacy content as publishable HTML."""
import argparse
import html
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--support-email')
parser.add_argument('--support-url')
args = parser.parse_args()
root = Path(__file__).resolve().parent
out = root / 'site'
out.mkdir(exist_ok=True)
for resource, filename in [('PrivacyPolicy', 'privacy.html'), ('Support', 'support.html')]:
    doc = json.loads((root.parent / 'HouseCapture' / f'{resource}.json').read_text())
    sections = ''.join(f'<section><h2>{html.escape(s["title"])}</h2><p>{html.escape(s["body"])}</p></section>' for s in doc['sections'])
    contact = ''
    if args.support_url:
        from urllib.parse import urlparse
        if urlparse(args.support_url).scheme != 'https':
            raise SystemExit('Support URL must use HTTPS')
        contact = f'<section><h2>Contact</h2><p><a href="{html.escape(args.support_url, quote=True)}">Get help or report a problem</a></p><p>Please do not attach private scans or photographs to public issues.</p></section>'
    elif args.support_email:
        email = html.escape(args.support_email, quote=True)
        contact = f'<section><h2>Contact</h2><p><a href="mailto:{email}">{email}</a></p></section>'
    else:
        contact = '<!-- Release blocker: add the public support contact before publishing. -->'
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>3D Model Anything — {html.escape(doc['title'])}</title>
<style>body{{margin:0;background:#f6f3eb;color:#20211f;font:18px/1.65 system-ui,sans-serif}}main{{max-width:720px;margin:auto;padding:40px 24px}}nav{{display:flex;gap:24px;flex-wrap:wrap}}a{{color:#a63914}}h1{{font-size:clamp(32px,6vw,48px);line-height:1.15;letter-spacing:-1px}}h2{{font-size:22px;margin-top:36px}}.meta{{font:13px monospace;letter-spacing:1px;color:#62635b}}section{{border-top:1px solid #d0cabc;margin-top:28px}}footer{{margin-top:44px;font-size:14px}}a:focus-visible{{outline:3px solid #c2471f;outline-offset:4px}}</style></head>
<body><main><nav aria-label="3D Model Anything"><a href="support.html">Help &amp; support</a><a href="privacy.html">Privacy policy</a></nav><h1>{html.escape(doc['title'])}</h1><p class="meta">3D MODEL ANYTHING · UPDATED {html.escape(doc['updated'].upper())}</p>{sections}{contact}<footer>3D Model Anything · Scan, save and share your rooms.</footer></main></body></html>'''
    (out / filename).write_text(page)
print(f'Prepared {out}; verify contact and publish on your chosen HTTPS host before submission.')
