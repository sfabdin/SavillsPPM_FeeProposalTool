#!/usr/bin/env python3
"""Regenerate the WOFF2 Gotham faces the app serves from the licensed .otf sources.

    pip install fonttools brotli
    python3 scripts/build-fonts.py

Only the faces referenced by design-system/colors_and_type.css are built;
add a face here AND declare it there if a new weight is ever needed."""
import os
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", "design-system", "fonts", "gotham")
FACES = ["Gotham-Book", "Gotham-BookItalic", "Gotham-Medium", "Gotham-Bold",
         "Gotham-BoldItalic", "Gotham-Black", "Gotham-BlackItalic"]

total = 0
for name in FACES:
    src = os.path.join(DIR, name + ".otf"); dst = os.path.join(DIR, name + ".woff2")
    font = TTFont(src); font.flavor = "woff2"; font.save(dst)
    size = os.path.getsize(dst); total += size
    print(f"{name:22s} {size/1024:6.1f} KB")
print(f"{'total':22s} {total/1024:6.1f} KB")
