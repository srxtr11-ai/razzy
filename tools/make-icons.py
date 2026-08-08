"""Build every icon the app needs from the square mark artwork.

The source sits on a grey gradient, so it can't be keyed out by brightness the
way the banner was. The grey is desaturated and the mark is a saturated lime,
so saturation is the key instead.

Emits into web/public:
  mark.png            transparent mark, used in the room header
  favicon.ico         16/32/48 multi-size, for browser tabs
  favicon-32.png      png fallback
  apple-touch-icon.png 180x180, iOS home screen
  icon-192.png / icon-512.png  Android / PWA install

Tab and home-screen icons get the dark brand tile behind them: a transparent
icon disappears against a light browser theme.

Run: python tools/make-icons.py <source.png>
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

src = Path(sys.argv[1])
out = Path(__file__).resolve().parent.parent / "web" / "public"
out.mkdir(parents=True, exist_ok=True)

INK = (11, 13, 16)

im = Image.open(src).convert("RGB")
w, h = im.size
px = im.load()

cut = Image.new("RGBA", (w, h))
cp = cut.load()
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        # "Green excess" — how far green sits above the red/blue average. Neutral
        # grey scores 0 by definition, so the tinted backdrop keys out cleanly
        # where a saturation test kept the whole canvas.
        excess = g - (r + b) / 2
        a = max(0.0, min(1.0, (excess - 34) / 34))  # favour the solid body; a soft halo turns to mush at 16px
        cp[x, y] = (r, g, b, int(a * 255)) if a > 0.02 else (0, 0, 0, 0)

# mark.png deliberately is NOT written here. This artwork carries a big soft
# glow that survives as partial alpha and reads as a blurry blob at 24px in the
# header. make-logo.py cuts a crisp mark from the banner instead.
mark = cut.crop(cut.getbbox())


def tile(size, pad=0.12, radius=0.22):
    """Mark centred on the dark brand tile, rounded like an app icon."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = Image.new("RGBA", (size, size), (*INK, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius), fill=255)
    canvas.paste(bg, (0, 0), mask)

    inner = int(size * (1 - pad * 2))
    scale = min(inner / mark.width, inner / mark.height)
    m = mark.resize((max(1, round(mark.width * scale)), max(1, round(mark.height * scale))), Image.LANCZOS)
    canvas.paste(m, ((size - m.width) // 2, (size - m.height) // 2), m)
    return canvas


tile(180).save(out / "apple-touch-icon.png", optimize=True)
tile(192).save(out / "icon-192.png", optimize=True)
tile(512).save(out / "icon-512.png", optimize=True)
tile(32, pad=0.10, radius=0.25).save(out / "favicon-32.png", optimize=True)
# .ico carries several sizes; the browser picks per context (tab, bookmark, taskbar)
tile(64, pad=0.10, radius=0.25).save(
    out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
)

print("mark.png            ", mark.size, "-> 160w")
for f in ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]:
    print(f"{f:<20}", (out / f).stat().st_size // 1024, "KB")
