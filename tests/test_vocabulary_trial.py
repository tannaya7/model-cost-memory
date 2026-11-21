"""One name for the feature: a person sees "trial", never "re-test".

The screens already have this guard (frontend/src/ui/vocabulary.test.ts). This is the same rule for the text the server sends: messages,
advice, notes and the descriptions in the API documentation. Internal names (routes, tables, code) keep `retest` and are not text a person
reads, so only the hyphenated word inside string literals is checked, not comments, docstrings or identifiers."""

import io
import re
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "agent_memory"
OLD = re.compile(r"\bre-test(ed|ing|s)?\b", re.I)  # the hyphenated word is the one people read; plain `retest` is an internal name


# Python 3.12 splits an f-string into pieces (FSTRING_MIDDLE is the text between the braces); 3.11, which this project also supports and CI runs,
# reads a whole f-string as one STRING token. Both are checked, so the guard works on either.
TEXT_TOKENS = tuple(t for t in (tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", None)) if t is not None)


def visible_strings(source: str):
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    for i, t in enumerate(tokens):
        if t.type not in TEXT_TOKENS:
            continue
        j = i - 1
        while j >= 0 and tokens[j].type in (tokenize.NL, tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT):
            j -= 1
        k = i + 1
        while k < len(tokens) and tokens[k].type in (tokenize.NL, tokenize.COMMENT):
            k += 1
        alone = (j < 0 or tokens[j].type in (tokenize.NEWLINE, tokenize.ENCODING)) and tokens[k].type in (tokenize.NEWLINE, tokenize.ENDMARKER)
        if not alone:  # a docstring or a lone string statement is documentation for developers, not text a person is shown
            yield t.start[0], t.string


def test_the_guard_finds_the_old_word_in_text_and_ignores_code():
    sample = 'x = "a re-test would settle it"\ny = f"Re-tests are off for {name}"\nz = "retests"\n\ndef f():\n    """A re-test runner."""\n# a re-test\n'
    found = [s for _, s in visible_strings(sample) if OLD.search(s)]
    assert len(found) == 2  # the plain string and the f-string; not the lone docstring, the comment or the plain `retests`
    assert "a re-test would settle it" in found[0] and "Re-tests are off for" in found[1]


def test_no_text_the_server_sends_says_re_test():
    offenders = []
    for path in sorted(ROOT.rglob("*.py")):
        for line, text in visible_strings(path.read_text(encoding="utf8")):
            if OLD.search(text):
                offenders.append(f"{path.relative_to(ROOT)}:{line}: {text[:80]}")
    assert offenders == [], "say 'trial' to a person, not 're-test'"
