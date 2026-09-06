from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids=[]; self.labels=[]; self.inputs=[]; self.scripts=[]; self.handlers=[]; self.stack=[]

    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if "id" in a: self.ids.append(a["id"])
        if tag == "label": self.labels.append(a.get("for"))
        if tag in {"input", "select"}: self.inputs.append(a.get("id"))
        if tag == "script": self.scripts.append(a.get("src"))
        if "onclick" in a: self.handlers.append(a["onclick"].split("(")[0])
        if tag not in VOID: self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID: return
        if not self.stack or self.stack.pop() != tag: raise ValueError("Unbalanced HTML: " + tag)


class HTMLTests(unittest.TestCase):
    def test_html_integrity_and_labels(self):
        p=Page();p.feed((ROOT/"index.html").read_text(encoding="utf-8"));p.close()
        self.assertEqual(p.stack,[])
        self.assertTrue(all(n == 1 for n in Counter(p.ids).values()))
        self.assertTrue(all(i in p.labels for i in p.inputs))
        self.assertEqual(p.scripts,["core.js?v=5.6","app.js?v=5.6-rate4"])
        source=(ROOT/"app.js").read_text(encoding="utf-8")
        for handler in p.handlers:
            self.assertRegex(source,r"function\s+"+re.escape(handler)+r"\(")
        self.assertIn("<title>GEL Cost</title>",(ROOT/"index.html").read_text(encoding="utf-8"))
