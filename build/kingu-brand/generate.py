# ---------------------------------------------------------------------------------------------
#  Kingu Intelligence
#  Licensed under the MIT License.
# ---------------------------------------------------------------------------------------------
"""
Writes every Kingu logo the product shows, from two sources: `brand-sheet.webp`,
the IDE mark on the left and the ADE (Agents window) mark on the right, and
`arkai-mark.webp`, the mark of Arkai, the chat agent (where Copilot was).

    python build/kingu-brand/generate.py

Needs `opencv-python`, `numpy`, `Pillow` and `fonttools`. It traces both marks
into outlines, then writes the SVGs, PNGs, ICO/ICNS/XPM app icons, installer
bitmaps, the badge on the file-type icons, and a small font that puts the
Arkai mark at the codicon font's Copilot codepoints and the IDE mark at its
VS Code ones (the codicon font
itself is copied from `@vscode/codicons` at build time, so it is overlaid with
`unicode-range` faces instead of being edited). The TypeScript paths it prints
last are pasted into `chatWorkingLogo.ts` and the aquarium's `logoPath.ts`.
"""

import io
import os
import struct
import sys

import cv2
import numpy as np
from PIL import Image
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.basePen import BasePen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))

# Where each mark is: its image, its columns and rows there, and whether it is drawn dark on light.
MARK_SOURCES = {
	'ide': ('brand-sheet.webp', (184, 647), (179, 784), False),
	'ade': ('brand-sheet.webp', (889, 1351), (179, 784), False),
	'arkai': ('arkai-mark.webp', (70, 1181), (65, 1166), True),
}
TRACE_SCALE = 4


def path(*parts):
	return os.path.join(ROOT, *parts)


# region Tracing

def trace(name):
	"""The mark's outlines in sheet pixels (origin at its padded corner), and the padded size."""
	source, (x0, x1), (top, bottom), dark = MARK_SOURCES[name]
	sheet = cv2.imread(os.path.join(HERE, source), cv2.IMREAD_GRAYSCALE)
	if dark:
		sheet = 255 - sheet
	pad = 8
	sheet = cv2.copyMakeBorder(sheet, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
	crop = sheet[top:bottom + 2 * pad + 1, x0:x1 + 2 * pad + 1]
	big = cv2.resize(crop, None, fx=TRACE_SCALE, fy=TRACE_SCALE, interpolation=cv2.INTER_CUBIC)
	big = cv2.GaussianBlur(big, (0, 0), TRACE_SCALE * 0.6)
	_, binary = cv2.threshold(big, 128, 255, cv2.THRESH_BINARY)
	contours, _ = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
	outlines = []
	for contour in contours:
		if cv2.contourArea(contour) < (TRACE_SCALE * 2) ** 2:
			continue
		outlines.append(cv2.approxPolyDP(contour, TRACE_SCALE * 0.35, True).reshape(-1, 2) / TRACE_SCALE)
	h, w = binary.shape
	return outlines, (w / TRACE_SCALE, h / TRACE_SCALE)


def fit(size, box, fraction):
	"""Scale and offset that fit a mark of `size` into a square `box`, its longer side at `fraction` of it."""
	w, h = size
	k = box * fraction / max(w, h)
	return k, (box - w * k) / 2, (box - h * k) / 2


def svg_path(outlines, k, dx, dy, digits=1):
	return ''.join('M' + ' L'.join(f'{x * k + dx:.{digits}f} {y * k + dy:.{digits}f}' for x, y in o) + 'Z' for o in outlines)


def raster(outlines, px, k, dx, dy, supersample=8):
	"""The outlines filled even-odd into a `px` square, anti-aliased."""
	big = px * supersample
	canvas = np.zeros((big, big), np.uint8)
	for o in outlines:
		layer = np.zeros_like(canvas)
		cv2.fillPoly(layer, [np.round((o * k + [dx, dy]) * supersample).astype(np.int32)], 255)
		canvas = cv2.bitwise_xor(canvas, layer)
	return cv2.resize(canvas, (px, px), interpolation=cv2.INTER_AREA)


def rounded_square(px, supersample=8):
	"""kingu-logo.png's plate: a 480/512 square with 96/512 corners, as an alpha mask."""
	big = px * supersample
	f = big / 512
	mask = np.zeros((big, big), np.uint8)
	r, a, b = int(96 * f), int(16 * f), int(496 * f)
	cv2.rectangle(mask, (a + r, a), (b - r, b), 255, -1)
	cv2.rectangle(mask, (a, a + r), (b, b - r), 255, -1)
	for cx, cy in ((a + r, a + r), (b - r, a + r), (a + r, b - r), (b - r, b - r)):
		cv2.circle(mask, (cx, cy), r, 255, -1)
	return cv2.resize(mask, (px, px), interpolation=cv2.INTER_AREA)


# endregion

# region The marks as images

ICON_FRACTION = 0.70  # the mark's height on the app-icon plate
MARK_FRACTION = 0.90  # the mark alone, in its own square


class Mark:
	def __init__(self, name):
		self.name = name
		self.outlines, self.size = trace(name)

	def icon_image(self, px):
		"""The app icon: the white mark on the black rounded plate."""
		k, dx, dy = fit(self.size, 512, ICON_FRACTION)
		glyph = raster(self.outlines, px, k * px / 512, dx * px / 512, dy * px / 512)
		rgba = np.zeros((px, px, 4), np.uint8)
		rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = glyph
		rgba[..., 3] = rounded_square(px)
		return Image.fromarray(rgba, 'RGBA')

	def mark_image(self, w, h):
		"""The white mark alone on transparency, fitted into a `w` x `h` box at 82% of its height."""
		side = max(w, h)
		k, dx, dy = fit(self.size, side, 0.82)
		glyph = raster(self.outlines, side, k, dx, dy)
		rgba = np.zeros((side, side, 4), np.uint8)
		rgba[..., :3] = 255
		rgba[..., 3] = glyph
		ox, oy = (side - w) // 2, (side - h) // 2
		return rgba[oy:oy + h, ox:ox + w]

	def icon_svg(self):
		k, dx, dy = fit(self.size, 512, ICON_FRACTION)
		return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
			'<rect x="16" y="16" width="480" height="480" rx="96" fill="#000"/>'
			f'<path fill="#fff" fill-rule="evenodd" d="{svg_path(self.outlines, k, dx, dy)}"/></svg>\n')

	def mark_svg(self, root='', fill='currentColor'):
		k, dx, dy = fit(self.size, 512, MARK_FRACTION)
		fill_attr = f' fill="{fill}"' if fill else ''
		return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"{root}>'
			f'<path{fill_attr} fill-rule="evenodd" d="{svg_path(self.outlines, k, dx, dy)}"/></svg>\n')

	def parts(self):
		"""The mark in its four pieces, top to bottom: crown, shades, smile, and the stone under it."""
		h = self.size[1]
		bands = {'crown': (0, 0.39), 'shades': (0.39, 0.63), 'smile': (0.63, 0.78), 'stone': (0.78, 1.01)}
		return {part: [o for o in self.outlines if lo * h <= (o[:, 1].min() + o[:, 1].max()) / 2 < hi * h] for part, (lo, hi) in bands.items()}


# endregion

# region Files

def write(rel, data):
	full = path(*rel.split('/'))
	os.makedirs(os.path.dirname(full), exist_ok=True)
	with open(full, 'wb') as f:
		f.write(data.encode('utf8') if isinstance(data, str) else data)
	print('wrote', rel)


def png(image):
	buffer = io.BytesIO()
	image.save(buffer, 'PNG', optimize=True)
	return buffer.getvalue()


def ico(images):
	"""PNG-compressed ICO entries, which Windows reads from Vista on."""
	header = struct.pack('<HHH', 0, 1, len(images))
	entries, data = b'', b''
	offset = 6 + 16 * len(images)
	for image in images:
		blob = png(image)
		w, h = image.size
		entries += struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
		data += blob
		offset += len(blob)
	return header + entries + data


def icns(image):
	buffer = io.BytesIO()
	image.save(buffer, 'ICNS')
	return buffer.getvalue()


def xpm(image, name='code_xpm'):
	"""An XPM of the icon, greys quantised to 32 levels, fully transparent pixels as None."""
	a = np.array(image.convert('RGBA'))
	grey = (a[..., 0].astype(int) // 8) * 8
	alpha = a[..., 3]
	levels = sorted(set(np.unique(grey[alpha >= 128]).tolist()))
	chars = '.+@#$%&*=-;>,\')!~{]^/(_:<[}|1234567890abcdefghijklmnopqrstuvwxyz'
	key = {level: chars[i] for i, level in enumerate(levels)}
	h, w = grey.shape
	lines = ['/* XPM */', f'static char * {name}[] = {{', f'"{w} {h} {len(levels) + 1} 1",', '" \tc None",']
	lines += [f'"{key[level]}\tc #{level:02X}{level:02X}{level:02X}",' for level in levels]
	for y in range(h):
		row = ''.join(key[grey[y, x]] if alpha[y, x] >= 128 else ' ' for x in range(w))
		lines.append(f'"{row}"' + (',' if y < h - 1 else ''))
	lines.append('};')
	return '\n'.join(lines) + '\n'


# endregion

# region Fonts

UPM = 300  # codicon.ttf's em: 300 units, ascent 300, descent 0
FONT_RASTER = 4

COPILOT_GLYPHS = ['copilot', 'copilot-warning', 'copilot-large', 'copilot-warning-large', 'copilot-blocked',
	'copilot-not-connected', 'copilot-unavailable', 'copilot-in-progress', 'copilot-error', 'copilot-success',
	'copilot-snooze', 'copilot-compact', 'copilot-dot', 'copilot-dot-compact']
VSCODE_GLYPHS = ['vscode', 'vscode-insiders', 'vscode-insiders-outline']


class PolyPen(BasePen):
	"""A glyph's contours as polylines, curves flattened."""

	def __init__(self, glyph_set):
		super().__init__(glyph_set)
		self.contours = []
		self.current = []

	def _moveTo(self, p):
		self.current = [p]

	def _lineTo(self, p):
		self.current.append(p)

	def _curveToOne(self, p1, p2, p3):
		p0 = self.current[-1]
		for t in np.linspace(0, 1, 12)[1:]:
			self.current.append(tuple((1 - t) ** 3 * np.array(p0) + 3 * (1 - t) ** 2 * t * np.array(p1) + 3 * (1 - t) * t ** 2 * np.array(p2) + t ** 3 * np.array(p3)))

	def _qCurveToOne(self, p1, p2):
		p0 = self.current[-1]
		for t in np.linspace(0, 1, 10)[1:]:
			self.current.append(tuple((1 - t) ** 2 * np.array(p0) + 2 * (1 - t) * t * np.array(p1) + t ** 2 * np.array(p2)))

	def _closePath(self):
		if self.current:
			self.contours.append(self.current)
		self.current = []

	_endPath = _closePath


class Codicons:
	def __init__(self, ttf):
		self.font = TTFont(ttf)
		self.cmap = self.font.getBestCmap()
		self.by_name = {name: code for code, name in self.cmap.items()}
		self.glyph_set = self.font.getGlyphSet()
		self.n = UPM * FONT_RASTER

	def contours(self, code):
		pen = PolyPen(self.glyph_set)
		self.glyph_set[self.cmap[code]].draw(pen)
		return pen.contours

	def fill(self, contours):
		canvas = np.zeros((self.n, self.n), np.uint8)
		for c in contours:
			layer = np.zeros_like(canvas)
			cv2.fillPoly(layer, [np.array([[x * FONT_RASTER, (UPM - y) * FONT_RASTER] for x, y in c], np.int32)], 255)
			canvas = cv2.bitwise_xor(canvas, layer)
		return canvas

	def badge(self, code):
		"""What a status variant adds to the plain glyph — a round badge, a dot, the z's, a slash — or None."""
		contours = self.contours(code)
		boxes = [(np.array(c).min(0), np.array(c).max(0)) for c in contours]
		for c, (lo, hi) in zip(contours, boxes):
			w, h = hi - lo
			if 60 < w < 200 and abs(w - h) < 4 and hi[0] >= 270 and (lo[1] <= 10 or hi[1] >= 290):
				disk = np.zeros((self.n, self.n), np.uint8)
				centre = (int((lo[0] + hi[0]) / 2 * FONT_RASTER), int((UPM - (lo[1] + hi[1]) / 2) * FONT_RASTER))
				cv2.circle(disk, centre, int(w / 2 * FONT_RASTER), 255, -1)
				return cv2.bitwise_and(self.fill(contours), disk)
		name = self.cmap[code]
		if name == 'copilot-snooze':
			return self.fill([c for c, (lo, hi) in zip(contours, boxes) if lo[0] >= 125 and lo[1] >= 145])
		if name == 'copilot-unavailable':
			line = np.zeros((self.n, self.n), np.uint8)
			cv2.line(line, (22 * FONT_RASTER, 22 * FONT_RASTER), (278 * FONT_RASTER, 278 * FONT_RASTER), 255, 20 * FONT_RASTER)
			return line
		return None


def glyph_from_raster(image):
	"""A raster traced into TrueType contours: filled ones clockwise, holes counter-clockwise (y up)."""
	contours, hierarchy = cv2.findContours(image, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
	pen = TTGlyphPen(None)
	for i, contour in enumerate(contours):
		if cv2.contourArea(contour) < (FONT_RASTER * 3) ** 2:
			continue
		points = [(round(x / FONT_RASTER), round(UPM - y / FONT_RASTER)) for x, y in cv2.approxPolyDP(contour, FONT_RASTER * 0.5, True).reshape(-1, 2)]
		points = [p for j, p in enumerate(points) if p != points[j - 1]]
		if len(points) < 3:
			continue
		area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])) / 2
		if (area > 0) != (hierarchy[0][i][3] != -1):
			points.reverse()
		pen.moveTo(points[0])
		for p in points[1:]:
			pen.lineTo(p)
		pen.closePath()
	return pen.glyph()


def marks_font(family, codicons, glyph_marks):
	"""A font with each named codicon glyph drawn as its mark: `glyph_marks` maps a mark to the glyph names it takes."""
	n = codicons.n
	gap = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (32 * FONT_RASTER + 1, 32 * FONT_RASTER + 1))
	order, glyphs, char_map = ['.notdef'], {'.notdef': TTGlyphPen(None).glyph()}, {}
	for mark, name in [(mark, name) for mark, names in glyph_marks for name in names]:
		k, dx, dy = fit(mark.size, n, 0.96)
		plain = raster(mark.outlines, n, k, dx, dy, supersample=1)
		_, plain = cv2.threshold(plain, 127, 255, cv2.THRESH_BINARY)
		code = codicons.by_name[name]
		badge = codicons.badge(code)
		image = plain if badge is None else cv2.bitwise_or(cv2.bitwise_and(plain, cv2.bitwise_not(cv2.dilate(badge, gap))), badge)
		glyph_name = f'uni{code:04X}'
		glyphs[glyph_name] = glyph_from_raster(image)
		order.append(glyph_name)
		char_map[code] = glyph_name
	builder = FontBuilder(UPM, isTTF=True)
	builder.setupGlyphOrder(order)
	builder.setupCharacterMap(char_map)
	builder.setupGlyf(glyphs)
	builder.setupHorizontalMetrics({g: (UPM, 0) for g in order})
	builder.setupHorizontalHeader(ascent=UPM, descent=0)
	builder.setupNameTable({'familyName': family, 'styleName': 'Regular'})
	builder.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
	builder.setupPost()
	buffer = io.BytesIO()
	builder.save(buffer)
	ranges = ', '.join(f'U+{code:04X}' for code in sorted(char_map))
	return buffer.getvalue(), ranges


# endregion

# region File-type icons

def rebadge(image, mark):
	"""Replaces the Code - OSS glyph in a file-type icon's corner badge with the Kingu mark, white on black inside the badge's white frame."""
	a = np.array(image.convert('RGBA'))
	h, w = a.shape[:2]
	r, g, b, alpha = (a[..., i].astype(int) for i in range(4))
	blue = (b > r + 60) & (b > 120) & (alpha > 128)
	blue[:, :int(w * 0.55)] = False
	blue[:int(h * 0.70), :] = False
	ys, xs = np.nonzero(blue)
	if len(xs) == 0:
		return image, False
	x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
	if min(x1 - x0, y1 - y0) < 10:
		# The small sizes have no badge; a few blue pixels there belong to the label.
		return image, False
	a[y0:y1, x0:x1] = (0, 0, 0, 255)
	a[y0:y1, x0:x1] = composite(a[y0:y1, x0:x1], mark.mark_image(x1 - x0, y1 - y0))
	return Image.fromarray(a, 'RGBA'), True


def composite(under, over):
	k = over[..., 3:4].astype(float) / 255
	out = under.astype(float)
	out[..., :3] = over[..., :3] * k + out[..., :3] * (1 - k)
	return out.astype(np.uint8)


def rebadge_ico(rel, mark):
	full = path(*rel.split('/'))
	source = Image.open(full)
	sizes = sorted(source.info.get('sizes', {source.size}))
	frames = []
	changed = False
	for size in sizes:
		source.size = size
		frame, did = rebadge(source.convert('RGBA'), mark)
		frames.append(frame)
		changed |= did
	if changed:
		write(rel, ico(frames))


def rebadge_icns(rel, mark):
	full = path(*rel.split('/'))
	source = Image.open(full)
	frame, did = rebadge(source.convert('RGBA'), mark)
	if did:
		write(rel, icns(frame))


# endregion


def main():
	ide, ade, arkai = Mark('ide'), Mark('ade'), Mark('arkai')

	# The source marks, for anything that needs them later.
	for mark, prefix in ((ide, 'kingu-ide'), (ade, 'kingu-ade'), (arkai, 'arkai')):
		write(f'resources/kingu/{prefix}-icon.svg', mark.icon_svg())
		write(f'resources/kingu/{prefix}-mark.svg', mark.mark_svg())
		write(f'resources/kingu/{prefix}-icon-1024.png', png(mark.icon_image(1024)))

	# App icons: the IDE everywhere but the Agents window's own icon.
	write('resources/win32/code.ico', ico([ide.icon_image(s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)]))
	write('resources/win32/sessions.ico', ico([ade.icon_image(s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)]))
	write('resources/win32/code_150x150.png', png(ide.icon_image(150)))
	write('resources/win32/code_70x70.png', png(ide.icon_image(70)))
	write('resources/darwin/code.icns', icns(ide.icon_image(1024)))
	write('resources/linux/code.png', png(ide.icon_image(512)))
	write('resources/linux/rpm/code.xpm', xpm(ide.icon_image(1024)))
	write('resources/server/favicon.ico', ico([ide.icon_image(s) for s in (16, 24, 32, 48, 64)]))
	write('resources/server/code-192.png', png(ide.icon_image(192)))
	write('resources/server/code-512.png', png(ide.icon_image(512)))
	for extension in ('github-authentication', 'microsoft-authentication'):
		write(f'extensions/{extension}/media/favicon.ico', ico([ide.icon_image(s) for s in (16, 24, 32, 48, 64)]))
	write('extensions/github-authentication/media/code-icon.svg', ide.icon_svg())
	# The chat agent's extension shows as Arkai.
	write('extensions/copilot/assets/copilot.png', png(arkai.icon_image(256)))

	# The installer's wizard images: the icon on white, the big one a little above centre.
	for scale in (100, 125, 150, 175, 200, 225, 250):
		for kind in ('big', 'small'):
			rel = f'resources/win32/inno-{kind}-{scale}.bmp'
			w, h = Image.open(path(*rel.split('/'))).size
			canvas = Image.new('RGBA', (w, h), (255, 255, 255, 255))
			side = int(min(w, h) * (0.62 if kind == 'big' else 0.86))
			canvas.alpha_composite(ide.icon_image(side), ((w - side) // 2, (h - side) // 2 if kind == 'small' else int(h * 0.30)))
			buffer = io.BytesIO()
			canvas.convert('RGB').save(buffer, 'BMP')
			write(rel, buffer.getvalue())

	# File-type icons: their corner badge becomes the Kingu icon.
	for name in sorted(os.listdir(path('resources', 'win32'))):
		if name.endswith('.ico') and name not in ('code.ico', 'sessions.ico'):
			rebadge_ico(f'resources/win32/{name}', ide)
	for name in sorted(os.listdir(path('resources', 'darwin'))):
		if name.endswith('.icns') and name != 'code.icns':
			rebadge_icns(f'resources/darwin/{name}', ide)

	# In the IDE: the app icon (title bar, banner, welcome, update), and the empty editor's letterpress.
	write('src/vs/workbench/browser/media/code-icon.svg', ide.icon_svg())
	for theme, root, fill in (('light', ' opacity="0.1"', None), ('dark', ' opacity="0.3"', None), ('hcLight', '', '#D9D9D9'), ('hcDark', '', '#3C3C3C')):
		write(f'src/vs/workbench/browser/parts/editor/media/letterpress-{theme}.svg', ide.mark_svg(root, fill))

	# In the Agents window: its own mark; "Open in VS Code" opens the IDE, so it shows the IDE's icon.
	write('src/vs/sessions/browser/media/vscode-icon.svg', ide.icon_svg())
	write('src/vs/sessions/browser/media/sessions-icon.svg', ade.icon_svg())
	write('src/vs/sessions/browser/media/sessions-logo-dark.svg', ade.mark_svg())
	write('src/vs/sessions/browser/media/sessions-logo-light.svg', ade.mark_svg('', '#D9D9D9'))
	for theme, fill in (('light', '#D9D9D9'), ('dark', '#3C3C3C')):
		write(f'src/vs/sessions/contrib/chat/browser/media/letterpress-sessions-{theme}.svg', ade.mark_svg('', fill))

	# The codicon overlay, in both windows: Arkai where Copilot was, the IDE where VS Code was.
	codicons = Codicons(path('node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf'))
	font, ranges = marks_font('kingu-marks', codicons, [(arkai, COPILOT_GLYPHS), (ide, VSCODE_GLYPHS)])
	write('src/vs/base/browser/ui/codicons/codicon/kingu-marks.ttf', font)
	print('\nunicode-range:', ranges)

	# Paths for the TypeScript that draws the mark itself.
	k, dx, dy = fit(ide.size, 84, 1.0)
	print('\nchatWorkingLogo faces (viewBox 6 6 84 84):')
	for part in ('crown', 'shades', 'smile'):
		print(f'  {part}:', svg_path(ide.parts()[part], k, dx + 6, dy + 6, 2))
	k, dx, dy = fit(ade.size, 84, 1.0)
	print('\naquarium logo (viewBox 0 0 96 96):', svg_path(ade.outlines, k, dx + 6, dy + 6, 2))


if __name__ == '__main__':
	sys.exit(main())
