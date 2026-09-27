#!/usr/bin/env python3
"""Render quantum.jxs offscreen, outside Live, so the display can be checked
frame by frame.

    python3 tools/render_shader.py out.png [name=value ...]

Values are shader params: floats, or space-free vec lists with commas
(qa=0.2,0.8,0.5,0.6). `learn=60,0,62,...` and `gen=...` fill the step
textures, `loss=1,0.6,0.3,...` the loss curve; their lengths set nlearn/ngen/
nloss unless given. `--strip=progress:0.1,0.2,...` renders one frame per value
side by side. Needs PyOpenGL, glfw and pillow (pip install PyOpenGL glfw pillow)
and a legacy GL 2.1 context, which macOS gives by default.
"""

import os
import re
import sys

import glfw
from OpenGL.GL import *  # noqa: F401,F403
from OpenGL.GL import shaders
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 372, 160


def load_programs():
    src = open(os.path.join(ROOT, "quantum.jxs")).read()
    vp = re.search(r'<program name="vp"[^>]*>\s*<!\[CDATA\[(.*?)\]\]>', src, re.S).group(1)
    fp = re.search(r'<program name="fp"[^>]*>\s*<!\[CDATA\[(.*?)\]\]>', src, re.S).group(1)
    defaults = {m.group(1): m.group(2) for m in re.finditer(r'<param name="(\w+)" type="\w+" default="([^"]*)"', src)}
    return vp, fp, defaults


def parse_args(argv):
    params, seqs, strip = {}, {}, None
    for a in argv:
        if a.startswith("--strip="):
            name, vals = a[8:].split(":")
            strip = (name, [float(v) for v in vals.split(",")])
            continue
        k, v = a.split("=", 1)
        if k in ("learn", "gen", "loss"):
            seqs[k] = [float(x) for x in v.split(",")] if v else []
        else:
            params[k] = [float(x) for x in v.split(",")]
    return params, seqs, strip


def rect_texture(unit, values, width):
    data = bytes(max(0, min(255, int(round(v)))) for v in (values + [0.0] * width)[:width])
    tex = glGenTextures(1)
    glActiveTexture(GL_TEXTURE0 + unit)
    glBindTexture(GL_TEXTURE_RECTANGLE, tex)
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_NEAREST)
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_NEAREST)
    glTexImage2D(GL_TEXTURE_RECTANGLE, 0, GL_LUMINANCE, width, 1, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, data)
    return tex


def set_uniform(prog, name, vals):
    loc = glGetUniformLocation(prog, name)
    if loc < 0:
        return
    f = {1: glUniform1f, 2: glUniform2f, 3: glUniform3f, 4: glUniform4f}[len(vals)]
    f(loc, *vals)


def render(prog, params):
    glUseProgram(prog)
    for k, v in params.items():
        set_uniform(prog, k, v)
    glClear(GL_COLOR_BUFFER_BIT)
    glBegin(GL_QUADS)
    for u, v, x, y in ((0, 0, -1, -1), (1, 0, 1, -1), (1, 1, 1, 1), (0, 1, -1, 1)):
        glMultiTexCoord2f(GL_TEXTURE0, u, v)
        glVertex2f(x, y)
    glEnd()
    glFinish()
    px = glReadPixels(0, 0, W, H, GL_RGB, GL_UNSIGNED_BYTE)
    return Image.frombytes("RGB", (W, H), px).transpose(Image.FLIP_TOP_BOTTOM)


def main():
    out = sys.argv[1]
    params, seqs, strip = parse_args(sys.argv[2:])
    vp, fp, defaults = load_programs()

    if not glfw.init():
        raise SystemExit("glfw init failed")
    glfw.window_hint(glfw.VISIBLE, glfw.FALSE)
    win = glfw.create_window(W, H, "quantum", None, None)
    glfw.make_context_current(win)
    glViewport(0, 0, W, H)

    prog = shaders.compileProgram(shaders.compileShader(vp, GL_VERTEX_SHADER),
                                  shaders.compileShader(fp, GL_FRAGMENT_SHADER))

    # defaults from the jxs, then overrides
    values = {k: [float(x) for x in v.split()] for k, v in defaults.items() if k not in ("tex0", "tex1", "tex2")}
    values["aspect"] = [W / H]
    values.update(params)

    rect_texture(0, seqs.get("learn", []), 256)
    rect_texture(1, seqs.get("gen", []), 256)
    loss = seqs.get("loss", [])
    top = max(loss[0], 1e-6) if loss else 1.0
    rect_texture(2, [255 * v / top for v in loss], 64)
    for k, name in (("learn", "nlearn"), ("gen", "ngen"), ("loss", "nloss")):
        if k in seqs and name not in params:
            values[name] = [float(len(seqs[k]))]

    glUseProgram(prog)
    for unit, name in enumerate(("tex0", "tex1", "tex2")):
        glUniform1i(glGetUniformLocation(prog, name), unit)

    if strip:
        name, vals = strip
        frames = []
        for v in vals:
            values[name] = [v]
            frames.append(render(prog, values))
        sheet = Image.new("RGB", (W * len(frames) + 4 * (len(frames) - 1), H), (40, 40, 40))
        for i, f in enumerate(frames):
            sheet.paste(f, (i * (W + 4), 0))
        sheet.save(out)
    else:
        render(prog, values).save(out)
    glfw.terminate()
    print("wrote", out)


if __name__ == "__main__":
    main()
