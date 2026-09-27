#!/usr/bin/env python3
"""Render PDF pages to PNG images for visual inspection."""

import sys
import os
import argparse
from pathlib import Path
import tempfile
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_extract import parse_pages  # noqa: E402

MAX_RENDER_DIRECTORIES = 64
MIN_DPI = 1
MAX_DPI = 1200


def private_output_directory() -> str:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") if os.name == "nt" else Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    cache = base / "pi-pdf-reader"
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache.is_symlink() or getattr(cache, "is_junction", lambda: False)():
        raise ValueError("PDF cache must be an ordinary user-owned directory.")
    if os.name != "nt":
        if cache.stat().st_uid != os.getuid():
            raise ValueError("PDF cache belongs to another user.")
        cache.chmod(0o700)
    if sum(1 for _ in cache.glob("render-*")) >= MAX_RENDER_DIRECTORIES:
        raise ValueError("PDF render cache is full. Remove completed render directories before rendering again.")
    # Unique private children avoid reusing pre-existing output files.
    return tempfile.mkdtemp(prefix="render-", dir=cache)


def render(path: str, page_spec: str = "all", dpi: int = 150) -> list[str]:
    # The bitmap grows with the square of the DPI, so an unchecked value can exhaust
    # memory before anything is written. Zero or less produces an empty bitmap.
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise ValueError(f"DPI must be between {MIN_DPI} and {MAX_DPI}.")
    with pymupdf.open(path) as doc:
        pages = parse_pages(page_spec, len(doc))
        out_dir = private_output_directory()
        zoom = dpi / 72.0
        mat = pymupdf.Matrix(zoom, zoom)
        output_paths = []
        for i in pages:
            page = doc[i]
            pix = page.get_pixmap(matrix=mat)
            out_path = os.path.join(out_dir, f"page_{i + 1:04d}.png")
            pix.save(out_path)
            output_paths.append(out_path)
            print(f"Page {i + 1} -> {out_path}")
    return output_paths


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Render PDF pages to PNG")
    parser.add_argument("path", help="Path to PDF file")
    parser.add_argument("--pages", default="all", help="Page range: 'all', '1-5', '1,3,7', '3'")
    parser.add_argument("--dpi", type=int, default=150, help="Render resolution (default: 150)")
    args = parser.parse_args()

    render(args.path, args.pages, args.dpi)
