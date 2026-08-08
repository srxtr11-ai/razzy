"""Generate the Android launcher icons from the same mark as the favicon.

Android wants three things and gets grumpy about all of them:

  · legacy square/round icons at five densities (mdpi..xxxhdpi),
  · adaptive icons, where a *separate* foreground layer is drawn on a background
    layer and the system masks the result to whatever shape the launcher likes
    (circle, squircle, teardrop). The mask can eat the outer ~28% of the canvas,
    so the mark has to sit well inside a safe zone or it gets clipped,
  · a Play Store icon at 512px.

Run: python tools/make-android-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "public" / "mark.png"          # already cut out, crisp
RES = ROOT / "android-app" / "android" / "app" / "src" / "main" / "res"
INK = (11, 13, 16, 255)

mark = Image.open(SRC).convert("RGBA")

# legacy icon: mark on the dark tile, rounded a little
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# adaptive foreground: 108dp canvas, only the middle 72dp is guaranteed visible
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def fit(img, box):
    s = min(box / img.width, box / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def legacy(size, round_full=False):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = Image.new("RGBA", (size, size), INK)
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    if round_full:
        d.ellipse([0, 0, size - 1, size - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    canvas.paste(bg, (0, 0), mask)
    m = fit(mark, int(size * 0.62))
    canvas.paste(m, ((size - m.width) // 2, (size - m.height) // 2), m)
    return canvas


def adaptive_fg(size):
    """Transparent canvas; the mark occupies only the safe centre."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    m = fit(mark, int(size * 0.40))  # 40% of 108dp sits comfortably inside the mask
    canvas.paste(m, ((size - m.width) // 2, (size - m.height) // 2), m)
    return canvas


for dens, px in LEGACY.items():
    out = RES / f"mipmap-{dens}"
    out.mkdir(parents=True, exist_ok=True)
    legacy(px).save(out / "ic_launcher.png", optimize=True)
    legacy(px, round_full=True).save(out / "ic_launcher_round.png", optimize=True)

for dens, px in ADAPTIVE.items():
    out = RES / f"mipmap-{dens}"
    out.mkdir(parents=True, exist_ok=True)
    adaptive_fg(px).save(out / "ic_launcher_foreground.png", optimize=True)

# Splash / Play listing
(RES / "drawable").mkdir(parents=True, exist_ok=True)
legacy(512).save(RES / "drawable" / "ic_splash.png", optimize=True)
legacy(512).save(ROOT / "android-app" / "play-store-icon.png", optimize=True)

# Colours the adaptive background and the theme refer to
(RES / "values").mkdir(parents=True, exist_ok=True)
(RES / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<resources>\n'
    '    <color name="ic_launcher_background">#08090B</color>\n'
    '</resources>\n',
    encoding="utf-8",
)

adaptive_xml = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/ic_launcher_background" />\n'
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
    '    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />\n'
    '</adaptive-icon>\n'
)
for d in ("mipmap-anydpi-v26", "mipmap-anydpi-v33"):
    (RES / d).mkdir(parents=True, exist_ok=True)
    (RES / d / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (RES / d / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")

print("launcher icons written to", RES)
for dens in LEGACY:
    p = RES / f"mipmap-{dens}" / "ic_launcher.png"
    print(f"  mipmap-{dens:<8} {Image.open(p).size}")
