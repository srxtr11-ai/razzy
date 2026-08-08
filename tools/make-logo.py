"""Turn the supplied banner PNG into web assets.

The source is RGB on a black card with a lot of padding, so dropped onto the
app's ambient background it reads as a black rectangle. This trims it, turns
the black into alpha (keeping the glow as partial alpha), and emits:

  web/public/logo.png       full lockup, mark + wordmark
  web/public/mark.png       just the mark, for tight spots and the favicon

Run: python tools/make-logo.py <source.png>
"""
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1] if len(sys.argv) > 1 else "razzy banner logo with text next to it.png")
out = Path(__file__).resolve().parent.parent / "web" / "public"
out.mkdir(parents=True, exist_ok=True)

im = Image.open(src).convert("RGB")
px = im.load()
w, h = im.size

# Luminance becomes alpha: black card -> transparent, glow -> soft edge. Keep
# the original pixels; flattening everything to one sampled tone picks the
# brightest highlight and washes the whole mark out.
rgba = Image.new("RGBA", (w, h))
rp = rgba.load()

for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        lum = max(r, g, b)
        a = 0 if lum < 18 else min(255, int((lum - 18) * 255 / (255 - 18)))
        rp[x, y] = (r, g, b, a) if a else (0, 0, 0, 0)

# Dominant tone of the solid body (opaque, saturated pixels) = the brand colour.
from collections import Counter
body = Counter()
for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if max(r, g, b) > 140 and max(r, g, b) - min(r, g, b) > 40:
            body[(r // 8 * 8, g // 8 * 8, b // 8 * 8)] += 1
brightest = body.most_common(1)[0][0] if body else (255, 255, 255)

bbox = rgba.getbbox()
lockup = rgba.crop(bbox)

# The mark is the left square-ish glyph; split at the gap before the wordmark.
lw, lh = lockup.size
cols = []
lp = lockup.load()
for x in range(lw):
    cols.append(any(lp[x, y][3] > 24 for y in range(0, lh, 2)))
gap_start = None
split = lw
run = 0
for x in range(lw):
    if not cols[x]:
        run += 1
        if gap_start is None:
            gap_start = x
        if run > lw * 0.04 and gap_start > lw * 0.05:
            split = gap_start
            break
    else:
        run = 0
        gap_start = None
mark = lockup.crop((0, 0, split, lh))
mark = mark.crop(mark.getbbox())

# The header draws this at ~24px, where the artwork's soft glow reads as a
# blurry smudge. Cut the halo away and keep only the solid body, with a narrow
# ramp left for antialiasing.
mp = mark.load()
for y in range(mark.height):
    for x in range(mark.width):
        r, g, b, a = mp[x, y]
        a = 0 if a < 150 else (255 if a > 205 else round((a - 150) * 255 / 55))
        mp[x, y] = (r, g, b, a)
mark = mark.crop(mark.getbbox())

# Ship at 2x the largest place each is drawn, not at source resolution.
def shrink(img, target_w):
    if img.width <= target_w:
        return img
    return img.resize((target_w, round(img.height * target_w / img.width)), Image.LANCZOS)

lockup = shrink(lockup, 640)
mark = shrink(mark, 160)
lockup.save(out / "logo.png", optimize=True)
mark.save(out / "mark.png", optimize=True)

print(f"brand colour  #{brightest[0]:02x}{brightest[1]:02x}{brightest[2]:02x}")
print(f"logo.png      {lockup.size[0]}x{lockup.size[1]}  (aspect {lockup.size[0]/lockup.size[1]:.2f})")
print(f"mark.png      {mark.size[0]}x{mark.size[1]}  (aspect {mark.size[0]/mark.size[1]:.2f})")
