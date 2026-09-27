#!/usr/bin/env python3
"""Compile-check the GLSL inside quantum.jxs with glslangValidator (brew install glslang).

Max compiles the shader silently inside Live, so a typo only shows as a blank
view. This catches it first. The vertex program uses the legacy built-ins
(gl_Vertex etc.), which the validator accepts for #version 120.
"""
import os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "quantum.jxs")).read()
ok = True
for name, ext in (("vp", "vert"), ("fp", "frag")):
    code = re.search(r'<program name="%s"[^>]*>\s*<!\[CDATA\[(.*?)\]\]>' % name, src, re.S).group(1)
    if "#version" not in code:
        code = "#version 120\n" + code
    with tempfile.NamedTemporaryFile("w", suffix="." + ext, delete=False) as f:
        f.write(code); path = f.name
    r = subprocess.run(["glslangValidator", path], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    print("%s: %s" % (name, "ok" if r.returncode == 0 else "FAILED"))
    if r.returncode != 0:
        ok = False
        print(out)
    os.unlink(path)
sys.exit(0 if ok else 1)
