# ---------------------------------------------------------------------------------------------
#  Kingu Intelligence
#  Licensed under the MIT License.
# ---------------------------------------------------------------------------------------------
"""
Writes Kingu's product icon theme: lucide, the ADE's icon set, in place of
VS Code's codicons wherever the two mean the same thing.

    python build/kingu-brand/generate-icons.py

Reads the ADE's own lucide (`kingu-orca/node_modules/lucide-react`), draws each
mapped icon the way lucide does (24 x 24, stroke 2, round caps and joins),
traces it into a glyph (the same pipeline as the Kingu marks in generate.py),
and writes `extensions/theme-kingu/producticons/`: the font and the theme that
maps each codicon id to its glyph. Codicons with no lucide counterpart here keep
their own drawing.
"""

import io
import json
import math
import os
import re
import sys

import cv2
import numpy as np
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate as brand  # noqa: E402  (glyph_from_raster, UPM, FONT_RASTER)

ROOT = brand.ROOT
LUCIDE = os.path.join(ROOT, 'kingu-orca', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')
OUT = os.path.join(ROOT, 'extensions', 'theme-kingu', 'producticons')

# codicon id -> lucide icon. Only where both draw the same idea.
ICONS = {
	# Activity bar and title bar
	'files': 'files', 'search': 'search', 'source-control': 'git-branch', 'debug-alt': 'bug', 'debug-alt-small': 'bug',
	'extensions': 'zap', 'extensions-large': 'zap', 'beaker': 'flask-conical', 'remote-explorer': 'monitor-cog',
	'account': 'circle-user', 'settings-gear': 'settings', 'gear': 'settings', 'settings': 'sliders-horizontal',
	'layout': 'panels-top-left', 'layout-sidebar-left': 'panel-left', 'layout-sidebar-left-off': 'panel-left-dashed',
	'layout-panel': 'panel-bottom', 'layout-panel-off': 'panel-bottom-dashed', 'layout-sidebar-right': 'panel-right',
	'layout-sidebar-right-off': 'panel-right-dashed',
	# Navigation
	'arrow-left': 'arrow-left', 'arrow-right': 'arrow-right', 'arrow-up': 'arrow-up', 'arrow-down': 'arrow-down',
	'chevron-down': 'chevron-down', 'chevron-right': 'chevron-right', 'chevron-left': 'chevron-left', 'chevron-up': 'chevron-up',
	'ellipsis': 'ellipsis', 'kebab-vertical': 'ellipsis-vertical', 'menu': 'menu', 'home': 'house',
	# Actions
	'close': 'x', 'add': 'plus', 'trash': 'trash-2', 'edit': 'pencil', 'check': 'check', 'refresh': 'refresh-cw', 'sync': 'refresh-cw',
	'new-file': 'file-plus', 'new-folder': 'folder-plus', 'collapse-all': 'list-collapse', 'expand-all': 'chevrons-up-down',
	'copy': 'copy', 'save': 'save', 'link': 'link', 'link-external': 'external-link', 'pin': 'pin', 'pinned': 'pin',
	'discard': 'undo-2', 'redo': 'redo-2', 'filter': 'funnel', 'cloud-upload': 'upload', 'cloud-download': 'download',
	'sign-in': 'log-in', 'sign-out': 'log-out', 'screen-full': 'maximize-2', 'screen-normal': 'minimize-2',
	'split-horizontal': 'columns-2', 'split-vertical': 'rows-2', 'go-to-file': 'file-search',
	'replace': 'replace', 'replace-all': 'replace-all', 'whole-word': 'whole-word', 'case-sensitive': 'case-sensitive', 'regex': 'regex',
	# Things
	'file': 'file', 'folder': 'folder', 'folder-opened': 'folder-open', 'list-tree': 'list-tree', 'list-flat': 'list',
	'terminal': 'square-terminal', 'history': 'history', 'clock': 'clock', 'globe': 'globe', 'cloud': 'cloud',
	'lock': 'lock', 'key': 'key-round', 'eye': 'eye', 'eye-closed': 'eye-off', 'star-empty': 'star', 'heart': 'heart',
	'comment': 'message-square', 'mail': 'mail', 'person': 'user', 'organization': 'users', 'tools': 'wrench',
	'wand': 'wand-sparkles', 'lightbulb': 'lightbulb', 'rocket': 'rocket', 'package': 'package', 'library': 'library',
	'book': 'book-open', 'bookmark': 'bookmark', 'tag': 'tag', 'sparkle': 'sparkles', 'robot': 'bot', 'keyboard': 'keyboard',
	'server': 'server', 'database': 'database', 'layers': 'layers', 'device-mobile': 'smartphone', 'code': 'code',
	'notebook': 'notebook', 'pulse': 'activity', 'graph-line': 'chart-line', 'checklist': 'list-checks',
	'git-commit': 'git-commit-horizontal', 'git-pull-request': 'git-pull-request', 'git-merge': 'git-merge',
	'repo-forked': 'git-fork', 'git-compare': 'git-compare',
	# Status
	'info': 'info', 'warning': 'triangle-alert', 'error': 'circle-x', 'pass': 'circle-check', 'question': 'circle-help',
	'bell': 'bell', 'bell-dot': 'bell-dot', 'bell-slash': 'bell-off',
	# Run and debug
	'play': 'play', 'debug-start': 'play', 'debug-stop': 'square', 'stop-circle': 'circle-stop', 'run-all': 'circle-play',
	'debug-restart': 'rotate-ccw', 'debug-pause': 'pause', 'play-circle': 'circle-play', 'primitive-square': 'square',
	# Chat and the Agents window
	'mic': 'mic', 'send': 'send', 'attach': 'paperclip', 'comment-discussion': 'messages-square', 'mention': 'at-sign',
	'tasklist': 'list-todo', 'circle-large-outline': 'circle', 'unlock': 'lock-open', 'vm': 'monitor', 'window': 'app-window',
	'inbox': 'inbox', 'archive': 'archive', 'calendar': 'calendar', 'dashboard': 'layout-dashboard', 'flame': 'flame',
	'gift': 'gift', 'gripper': 'grip-vertical', 'note': 'sticky-note', 'rss': 'rss', 'shield': 'shield',
	'thumbsup': 'thumbs-up', 'thumbsdown': 'thumbs-down', 'watch': 'watch', 'zoom-in': 'zoom-in', 'zoom-out': 'zoom-out',
}

STROKE = 2.0
VIEW = 24.0


# region lucide's icon nodes

def read_icon(name):
	"""The `__iconNode` of a lucide-react icon: its SVG elements and their attributes."""
	with open(os.path.join(LUCIDE, f'{name}.js'), encoding='utf8') as f:
		source = f.read()
	if 'const __iconNode = [' not in source:
		# An alias of another icon: follow its re-export.
		target = re.search(r"from '\./([\w-]+)\.js'", source)
		if not target:
			raise ValueError(f'{name}: no icon node and no alias')
		return read_icon(target.group(1))
	body = source[source.index('const __iconNode = ['):source.index('];', source.index('const __iconNode = ['))]
	elements = []
	for tag, attrs in re.findall(r'\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]', body):
		elements.append((tag, dict(re.findall(r'(\w+):\s*"([^"]*)"', attrs))))
	return elements


def arc_points(x1, y1, rx, ry, phi, large, sweep, x2, y2, steps=24):
	"""An SVG elliptical arc as points, from its endpoint form (SVG 1.1, F.6.5)."""
	if rx == 0 or ry == 0:
		return [(x2, y2)]
	rx, ry = abs(rx), abs(ry)
	cos, sin = math.cos(math.radians(phi)), math.sin(math.radians(phi))
	dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
	xp, yp = cos * dx + sin * dy, -sin * dx + cos * dy
	lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
	if lam > 1:
		rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
	num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
	den = rx * rx * yp * yp + ry * ry * xp * xp
	coef = math.sqrt(max(0, num / den)) * (-1 if large == sweep else 1)
	cxp, cyp = coef * rx * yp / ry, -coef * ry * xp / rx
	cx, cy = cos * cxp - sin * cyp + (x1 + x2) / 2, sin * cxp + cos * cyp + (y1 + y2) / 2

	def angle(ux, uy, vx, vy):
		a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
		return a

	t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
	dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
	if not sweep and dt > 0:
		dt -= 2 * math.pi
	elif sweep and dt < 0:
		dt += 2 * math.pi
	points = []
	for i in range(1, steps + 1):
		t = t1 + dt * i / steps
		points.append((cx + rx * math.cos(t) * cos - ry * math.sin(t) * sin, cy + rx * math.cos(t) * sin + ry * math.sin(t) * cos))
	return points


def path_subpaths(d):
	"""An SVG path's subpaths as point lists, each with whether it is closed."""
	tokens = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d)
	subpaths, current, closed = [], [], False
	x = y = sx = sy = 0.0
	last_control = None
	command = None
	i = 0

	def number():
		nonlocal i
		value = float(tokens[i])
		i += 1
		return value

	while i < len(tokens):
		if re.match(r'[A-Za-z]', tokens[i]):
			command = tokens[i]
			i += 1
			if command in 'Zz':
				closed = True
				x, y = sx, sy
				if current:
					subpaths.append((current, True))
				current, closed = [], False
				last_control = None
				continue
		rel = command.islower()
		c = command.upper()
		ox, oy = (x, y) if rel else (0, 0)
		if c == 'M':
			if current:
				subpaths.append((current, False))
			x, y = number() + ox, number() + oy
			sx, sy = x, y
			current = [(x, y)]
			command = 'l' if rel else 'L'
			last_control = None
		elif c == 'L':
			x, y = number() + ox, number() + oy
			current.append((x, y))
			last_control = None
		elif c == 'H':
			x = number() + (x if rel else 0)
			current.append((x, y))
			last_control = None
		elif c == 'V':
			y = number() + (y if rel else 0)
			current.append((x, y))
			last_control = None
		elif c in 'CS':
			if c == 'C':
				x1, y1 = number() + ox, number() + oy
			else:
				x1, y1 = (2 * x - last_control[0], 2 * y - last_control[1]) if last_control else (x, y)
			x2, y2 = number() + ox, number() + oy
			ex, ey = number() + ox, number() + oy
			for step in range(1, 17):
				t = step / 16
				current.append(((1 - t) ** 3 * x + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 * ex,
					(1 - t) ** 3 * y + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3 * ey))
			last_control = (x2, y2)
			x, y = ex, ey
		elif c in 'QT':
			if c == 'Q':
				x1, y1 = number() + ox, number() + oy
			else:
				x1, y1 = (2 * x - last_control[0], 2 * y - last_control[1]) if last_control else (x, y)
			ex, ey = number() + ox, number() + oy
			for step in range(1, 13):
				t = step / 12
				current.append(((1 - t) ** 2 * x + 2 * (1 - t) * t * x1 + t * t * ex, (1 - t) ** 2 * y + 2 * (1 - t) * t * y1 + t * t * ey))
			last_control = (x1, y1)
			x, y = ex, ey
		elif c == 'A':
			rx, ry, phi = number(), number(), number()
			large, sweep = int(number()), int(number())
			ex, ey = number() + ox, number() + oy
			current.extend(arc_points(x, y, rx, ry, phi, large, sweep, ex, ey))
			x, y = ex, ey
			last_control = None
	if current:
		subpaths.append((current, closed))
	return subpaths


def element_subpaths(tag, a):
	f = lambda key, default=0.0: float(a.get(key, default))  # noqa: E731
	if tag == 'path':
		return path_subpaths(a['d'])
	if tag == 'circle':
		cx, cy, r = f('cx'), f('cy'), f('r')
		return [([(cx + r * math.cos(t), cy + r * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)], True)]
	if tag == 'ellipse':
		cx, cy, rx, ry = f('cx'), f('cy'), f('rx'), f('ry')
		return [([(cx + rx * math.cos(t), cy + ry * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)], True)]
	if tag == 'line':
		return [([(f('x1'), f('y1')), (f('x2'), f('y2'))], False)]
	if tag in ('polyline', 'polygon'):
		values = [float(v) for v in re.findall(r'-?\d+\.?\d*', a['points'])]
		return [(list(zip(values[0::2], values[1::2])), tag == 'polygon')]
	if tag == 'rect':
		x, y, w, h = f('x'), f('y'), f('width'), f('height')
		r = min(f('rx', a.get('ry', 0)), w / 2, h / 2)
		if r <= 0:
			return [([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], True)]
		points = []
		for cx, cy, start in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
			for t in np.linspace(start, start + 90, 8):
				points.append((cx + r * math.cos(math.radians(t)), cy + r * math.sin(math.radians(t))))
		return [(points, True)]
	return []


def draw(elements, px):
	"""The icon stroked into a `px` square: stroke 2 of 24, round caps and joins."""
	k = px / VIEW
	canvas = np.zeros((px, px), np.uint8)
	thickness = max(1, int(round(STROKE * k)))
	for tag, attrs in elements:
		for points, closed in element_subpaths(tag, attrs):
			pts = [(int(round(x * k)), int(round(y * k))) for x, y in points]
			if closed and pts:
				pts.append(pts[0])
			for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
				cv2.line(canvas, (x1, y1), (x2, y2), 255, thickness)
			for x, y in pts:
				cv2.circle(canvas, (x, y), thickness // 2, 255, -1)
	return canvas


# endregion

def check_names():
	"""Every codicon id is one VS Code registers, and every lucide name is in the package."""
	with open(os.path.join(ROOT, 'src', 'vs', 'base', 'common', 'codiconsLibrary.ts'), encoding='utf8') as f:
		codicons = set(re.findall(r"register\('([\w-]+)'", f.read()))
	bad = [c for c in ICONS if c not in codicons] + [f'lucide:{l}' for l in set(ICONS.values()) if not os.path.exists(os.path.join(LUCIDE, f'{l}.js'))]
	if bad:
		raise SystemExit(f'unknown names: {", ".join(sorted(bad))}')


def main():
	check_names()
	n = brand.UPM * brand.FONT_RASTER
	codepoints = {}
	order, glyphs, char_map = ['.notdef'], {'.notdef': TTGlyphPen(None).glyph()}, {}
	lucide_names = sorted(set(ICONS.values()))
	for index, name in enumerate(lucide_names):
		code = 0xE000 + index
		raster = draw(read_icon(name), n)
		glyph_name = f'uni{code:04X}'
		glyphs[glyph_name] = brand.glyph_from_raster(raster)
		order.append(glyph_name)
		char_map[code] = glyph_name
		codepoints[name] = code
	builder = FontBuilder(brand.UPM, isTTF=True)
	builder.setupGlyphOrder(order)
	builder.setupCharacterMap(char_map)
	builder.setupGlyf(glyphs)
	builder.setupHorizontalMetrics({g: (brand.UPM, 0) for g in order})
	builder.setupHorizontalHeader(ascent=brand.UPM, descent=0)
	builder.setupNameTable({'familyName': 'kingu-lucide', 'styleName': 'Regular'})
	builder.setupOS2(sTypoAscender=brand.UPM, sTypoDescender=0, usWinAscent=brand.UPM, usWinDescent=0)
	builder.setupPost()
	builder.font['head'].created = builder.font['head'].modified = 3_786_000_000
	builder.font.recalcTimestamp = False
	os.makedirs(OUT, exist_ok=True)
	buffer = io.BytesIO()
	builder.save(buffer)
	with open(os.path.join(OUT, 'kingu-lucide.ttf'), 'wb') as f:
		f.write(buffer.getvalue())
	theme = {
		'fonts': [{'id': 'kingu-lucide', 'src': [{'path': './kingu-lucide.ttf', 'format': 'truetype'}], 'weight': 'normal', 'style': 'normal'}],
		'iconDefinitions': {codicon: {'fontCharacter': f'\\{codepoints[lucide]:x}'} for codicon, lucide in sorted(ICONS.items())},
	}
	with open(os.path.join(OUT, 'kingu-lucide-icon-theme.json'), 'w', encoding='utf8') as f:
		f.write(json.dumps(theme, indent='\t') + '\n')
	print(f'wrote {len(lucide_names)} lucide glyphs for {len(ICONS)} codicons -> extensions/theme-kingu/producticons/')


if __name__ == '__main__':
	main()
