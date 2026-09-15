#!/usr/bin/env python3
"""PDF metadata and per-page analysis. Always run this first to triage a PDF."""

import sys
import json
import pymupdf


def _is_maths_char(c: str) -> bool:
    """True for a character that only appears in mathematical notation."""
    return (
        ('\u2200' <= c <= '\u22FF')           # Mathematical Operators
        or ('\u2100' <= c <= '\u214F')         # Letterlike Symbols
        or ('\u2190' <= c <= '\u21FF')         # Arrows
        or ('\u27C0' <= c <= '\u27EF')         # Misc Mathematical Symbols-A
        or ('\u2980' <= c <= '\u29FF')         # Misc Mathematical Symbols-B
        or ('\u2A00' <= c <= '\u2AFF')         # Supplemental Mathematical Operators
        or ('\U0001D400' <= c <= '\U0001D7FF')  # Mathematical Alphanumeric Symbols
        or c in '\u222b\u2211\u220f\u221a\u2202\u2207\u221e\u2248\u2260\u2264\u2265\u00b1\u00d7\u00f7\u2208\u2209\u2282\u2283\u222a\u2229\u2227\u2228\u00ac\u2200\u2203\u2205'
    )


def _is_greek_char(c: str) -> bool:
    """True for the Greek and Coptic block, which maths and Greek prose share."""
    return '\u0370' <= c <= '\u03FF'


def analyze(path: str) -> dict:
    doc = pymupdf.open(path)
    meta = doc.metadata or {}

    pages = []
    for i, page in enumerate(doc):
        text = page.get_text()
        text_len = len(text)
        images = page.get_images(full=True)

        # Estimate maths density: ratio of unicode maths-range chars to total chars.
        # Greek is counted only on a page that also carries unambiguous maths, because
        # a page of ordinary Greek prose would otherwise score a density near 1.
        unambiguous = sum(1 for c in text if _is_maths_char(c))
        greek = sum(1 for c in text if _is_greek_char(c)) if unambiguous else 0
        math_chars = unambiguous + greek
        math_density = math_chars / max(text_len, 1)

        pages.append({
            "page": i + 1,
            "text_length": text_len,
            "image_count": len(images),
            "math_density": round(math_density, 4),
        })

    # Try to extract TOC
    toc = doc.get_toc()
    toc_entries = [
        {"level": level, "title": title, "page": page_num}
        for level, title, page_num in toc
    ]

    result = {
        "file": path,
        "page_count": len(doc),
        "title": meta.get("title", ""),
        "author": meta.get("author", ""),
        "subject": meta.get("subject", ""),
        "toc": toc_entries,
        "pages": pages,
    }

    doc.close()
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: pdf_info.py <path>", file=sys.stderr)
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
