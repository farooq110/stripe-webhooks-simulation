#!/usr/bin/env python3
"""Generate the StripePulse favicon (ICO) in src/app.

Draws the brand mark: a Stripe-indigo rounded square with a white lightning
bolt. Pillow renders it at 16/32/48 px so browsers can pick a crisp size.
The SVG twin lives at src/app/icon.svg for modern browsers.
"""

from PIL import Image, ImageDraw

OUT = "/home/z/my-project/src/app/favicon.ico"
INDIGO = (99, 91, 255, 255)  # #635bff


def bolt(draw: ImageDraw.ImageDraw, s: float, ox: float = 0.0, oy: float = 0.0) -> None:
    """A chunky lightning bolt scaled to an s x s box."""
    pts = [
        (0.58, 0.06), (0.22, 0.55), (0.46, 0.55),
        (0.38, 0.94), (0.78, 0.42), (0.52, 0.42),
    ]
    draw.polygon([(x * s + ox, y * s + oy) for x, y in pts], fill=(255, 255, 255, 255))


def render(size: int) -> Image.Image:
    # Draw 4x oversized, then downscale for smooth edges.
    big = size * 4
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big // 5, fill=INDIGO)
    pad = big * 0.16
    bolt(d, big - 2 * pad, pad, pad)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    sizes = [16, 32, 48]
    frames = [render(s) for s in sizes]
    frames[0].save(OUT, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
    print("wrote", OUT)


if __name__ == "__main__":
    main()
