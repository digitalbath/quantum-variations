#!/usr/bin/env python3
"""Generate QuantumVariations.amxd from code.

The device's patcher is small enough to describe in a script, and doing it this
way keeps the panel layout, the wiring and the object attributes reviewable in
a diff instead of a 40KB JSON blob. Run it to bootstrap the device; after that
Max re-saves the .amxd itself when you edit it in the patcher.

    python3 tools/build_device.py            # writes ../QuantumVariations.amxd
    python3 tools/build_device.py --maxpat   # also writes QuantumVariations.maxpat

The .amxd container is a tiny IFF-style wrapper: "ampf", a version, a "meta"
chunk, and a "ptch" chunk holding the patcher JSON. Chunk lengths are little-
endian uint32.

Panel (640 x 168), two pages switched with thispatcher scripting:
  main:      Learn column with status | shader, full height | Generate column
  settings:  API key field, Save, result line, Back — shown first when no key is stored
"""

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "QuantumVariations.amxd")

FONT = "Ableton Sans Medium Regular"
# `---` becomes a per-device-instance prefix in Live, so two copies of the
# device never share a rendering context, shader or matrix.
CTX = "---qctx"
SHADER = "---qsh"
LRN, GEN = "---lrn", "---gen"          # step matrices: 256 x 1 char, red = pitch
LRNT, GENT = "---lrnt", "---gent"      # ...and the textures made from them
LOSS, LOSST = "---loss", "---losst"    # training loss curve, 64 x 1 char, red = loss / first epoch

WIDTH, HEIGHT = 640, 168
COL = 122                              # both side columns
VIEW = [6 + COL + 6, 4, WIDTH - 2 * (COL + 12), 160]   # the jit.pwindow, full height
RX = WIDTH - 6 - COL                   # right column x

MAIN, SETTINGS = [], []                # varnames on each page

boxes = []
lines = []
_ids = {}


def box(key, maxclass, rect, text=None, pres=None, page=None, **attrs):
    bid = "obj-%d" % (len(boxes) + 1)
    _ids[key] = bid
    b = {"id": bid, "maxclass": maxclass, "patching_rect": list(map(float, rect))}
    if page is not None:                # every panel object belongs to a page
        b["varname"] = key
        page.append(key)
        if page is SETTINGS:
            b["hidden"] = 1
    if text is not None:
        b["text"] = text
    if pres is not None:
        b["presentation"] = 1
        b["presentation_rect"] = list(map(float, pres))
    b.update(attrs)
    boxes.append({"box": b})
    return key


def line(src, dst, outlet=0, inlet=0):
    # resolved to box ids when the patcher is assembled, so wiring may name boxes defined later
    lines.append((src, outlet, dst, inlet))


def patchlines():
    return [{"patchline": {"source": [_ids[s], o], "destination": [_ids[d], i]}} for s, o, d, i in lines]


def newobj(key, text, rect, numinlets, numoutlets, outlettype=None, **attrs):
    return box(key, "newobj", rect, text, numinlets=numinlets, numoutlets=numoutlets,
               outlettype=outlettype or [""] * numoutlets, **attrs)


def msg(key, text, rect):
    return box(key, "message", rect, text, numinlets=2, numoutlets=1, outlettype=[""])


def comment(key, text, pres, page=None, justify=0, fontsize=10.0, **attrs):
    return box(key, "live.comment", [pres[0] + 700, pres[1], pres[2], pres[3]], pres=pres, page=page,
               text=text, fontname=FONT, fontsize=fontsize, numinlets=1, numoutlets=0,
               textjustification=justify, **attrs)


def param(longname, ptype, mmin, mmax, initial, unitstyle, invisible=0, enum=None):
    v = {
        "parameter_longname": longname,
        "parameter_shortname": longname,
        "parameter_type": ptype,          # 0 float, 1 int, 2 enum
        "parameter_mmin": mmin,
        "parameter_mmax": mmax,
        "parameter_initial_enable": 1,
        "parameter_initial": [initial],
        "parameter_unitstyle": unitstyle,  # 0 int, 1 float
        "parameter_invisible": invisible,  # 0 automated+stored, 1 stored only, 2 hidden
        "parameter_linknames": 0,
        "parameter_modmode": 0,
        "parameter_speedlim": 1.0,
        "parameter_exponent": 1.0,
        "parameter_steps": 0,
        "parameter_units": "",
        "parameter_info": "",
        "parameter_annotation_name": "",
    }
    if enum:
        v["parameter_enum"] = enum
    return {"valueof": v}


def button(key, label, pres, page=None, **attrs):
    # Not a Live parameter: a parameter button echoed its value change back
    # into the patcher and fired twice per click.
    return box(key, "live.text", [pres[0] + 700, pres[1], pres[2], pres[3]], pres=pres, page=page,
               numinlets=1, numoutlets=2, outlettype=["", ""], mode=0,
               text=label, texton=label, parameter_enable=0, **attrs)


# ---------------------------------------------------------------- page: main

# Live's Info View text for the device as a whole comes from a background
# panel's annotation (the patcher `description` is not what Live reads). The
# panel is transparent and first in the box list so it sits behind everything.
box("backdrop", "panel", [0, 0, WIDTH, HEIGHT], pres=[0, 0, WIDTH, HEIGHT],
    numinlets=1, numoutlets=0, border=0, rounded=0,
    bgcolor=[0.0, 0.0, 0.0, 0.0],
    bgfillcolor={"type": "color", "color": [0.0, 0.0, 0.0, 0.0], "color1": [0.0, 0.0, 0.0, 0.0],
                 "color2": [0.0, 0.0, 0.0, 0.0], "angle": 270.0, "proportion": 0.39, "autogradient": 0},
    annotation_name="Quantum Variations",
    annotation=("Learns the phrase in a MIDI clip, trains a quantum reservoir on it through the Moth Quantum "
                "API, and writes new variations back as clips on the same track. Select a MIDI clip and press "
                "Learn Clip. Choose how many bars you want and how far to stray with Variation, then press Generate. "
                "Each new clip lands in the next free slot, named after the source. Add your Moth "
                "Quantum API key under Settings."))

# Info View text (Live shows `annotation` when the cursor is over a control)
INFO = {
    "learn": ("Learn Clip", "Reads the selected MIDI clip and trains a quantum reservoir on it "
                       "through the Moth Quantum API. Takes about a minute; a clip you have learned before is instant."),
    "generate": ("Generate", "Writes a new phrase into the next free clip slot on this track, in the style of "
                             "the learned clip. Takes a few seconds."),
    "bars": ("Bars", "Length of the phrase to generate. Set to the learned clip's length when you press Learn."),
    "variation": ("Variation", "How far the new phrase strays from the learned clip. Low stays close to the "
                               "original, high is loose and surprising."),
    "settings": ("Settings", "Enter or replace your Moth Quantum API key. It is stored in your user folder, "
                             "never in the Live set or the device."),
    "pwindow": ("Reservoir", "The reservoir, drawn as a sphere. Variation distorts it; its edges sharpen when "
                             "training fits your clip well. The ring is the "
                             "phrase being generated, one point per step, lit where there is a note. Top ruler: "
                             "the learned loop. Bottom ruler: the last phrase. Points pulse with Live's beat and "
                             "light up under the playhead."),
    "status": ("Status", "What the device is doing. Learning takes about a minute; generating a few seconds."),
    "mode": ("Source mode", "How the clip is read. Notes follows one line — a melody or a bassline — taking the lowest note on each step. Chords and "
                            "Drums treat each step's stack of notes as one shape, so a progression or a beat "
                            "keeps its voicings and hit combinations. Set automatically when you press Learn "
                            "Clip — Drums if the track has a Drum Rack — until you choose one yourself."),
    "align": ("Align phrases to the bar", "The engine keeps the rhythm of the source but hands each phrase "
                                          "back shifted by a few steps. On, the phrase is rotated so its notes "
                                          "fall where the source's do within the bar. Off, it is written exactly "
                                          "as generated."),
    "key": ("API key", "Paste the API key from your Moth Quantum account and press Save key. The key is "
                       "checked with Moth before it is stored."),
}


def info(key):
    name, text = INFO[key]
    return {"annotation_name": name, "annotation": text}


button("settings", "Settings", [6, 8, 60, 18], MAIN, **info("settings"))

# What is learned: a small caption, the clip name as the primary line, and a
# secondary line of facts. Plain `comment`s take an explicit colour so the
# caption and facts sit back from the name.
DIM = [0.62, 0.62, 0.62, 1.0]
box("learnlabel", "comment", [706, 38, 122, 14], pres=[6, 38, 122, 14], page=MAIN,
    text="SOURCE", fontname="Ableton Sans Small Bold", fontsize=8.0, textcolor=DIM, numinlets=1, numoutlets=0)
comment("clipname", "None yet", [6, 52, 122, 18], MAIN, fontsize=11.0)
# comments don't wrap on `set`, so the facts/hint area is two explicit lines
box("clipinfo", "comment", [706, 70, 122, 14], pres=[6, 70, 122, 14], page=MAIN,
    text="Select a MIDI clip", fontname=FONT, fontsize=9.0, textcolor=DIM, numinlets=1, numoutlets=0)
box("clipinfo2", "comment", [706, 84, 122, 14], pres=[6, 84, 122, 14], page=MAIN,
    text="and press Learn Clip", fontname=FONT, fontsize=9.0, textcolor=DIM, numinlets=1, numoutlets=0)

# What is happening now: a coloured dot (amber working, green done, red failed)
# and one short sentence. Separate from the facts above so state and events
# never read as the same kind of information.
box("dot", "panel", [706, 106, 7, 7], pres=[6, 106, 7, 7], page=MAIN,
    numinlets=1, numoutlets=0, border=0, rounded=7, bgcolor=[0.0, 0.0, 0.0, 0.0],
    bgfillcolor={"type": "color", "color": [0.0, 0.0, 0.0, 0.0], "color1": [0.0, 0.0, 0.0, 0.0],
                 "color2": [0.0, 0.0, 0.0, 0.0], "angle": 270.0, "proportion": 0.39, "autogradient": 0})
comment("status", "", [18, 101, 110, 34], MAIN, **info("status"))          # wraps to two lines
button("learn", "Learn Clip", [6, 138, 116, 22], MAIN, **info("learn"))      # same width as Generate

box("pwindow", "jit.pwindow", [700 + VIEW[0], VIEW[1], VIEW[2], VIEW[3]], pres=VIEW, page=MAIN,
    numinlets=1, numoutlets=2, outlettype=["", ""], name=CTX, **info("pwindow"))

box("phraselabel", "comment", [1206, 38, 60, 14], pres=[RX, 38, 60, 14], page=MAIN,
    text="PHRASE", fontname="Ableton Sans Small Bold", fontsize=8.0, textcolor=DIM, numinlets=1, numoutlets=0)
box("bars", "live.numbox", [1174, 56, 44, 20], pres=[RX, 56, 44, 20], page=MAIN, **info("bars"),
    numinlets=1, numoutlets=2, outlettype=["", "float"], parameter_enable=1,
    saved_attribute_attributes=param("Bars", 1, 1, 8, 1, 0, invisible=1))
box("barslabel", "comment", [1254, 58, 26, 16], pres=[RX + 46, 58, 26, 16], page=MAIN,
    text="bars", fontname=FONT, fontsize=9.0, textcolor=DIM, numinlets=1, numoutlets=0)
box("variation", "live.dial", [1288, 40, 44, 48], pres=[RX + 78, 40, 44, 48], page=MAIN, **info("variation"),
    numinlets=1, numoutlets=2, outlettype=["", "float"], parameter_enable=1,
    showname=1, saved_attribute_attributes=param("Variation", 0, 0.1, 3.0, 1.0, 1, invisible=1))
box("modelabel", "comment", [1206, 92, 60, 14], pres=[RX, 92, 60, 14], page=MAIN,
    text="SOURCE MODE", fontname="Ableton Sans Small Bold", fontsize=8.0, textcolor=DIM, numinlets=1, numoutlets=0)
box("modetab", "live.tab", [1206, 106, 122, 20], pres=[RX, 106, 122, 20], page=MAIN, **info("mode"),
    numinlets=1, numoutlets=3, outlettype=["", "", "float"], parameter_enable=1, mode=0,
    num_lines_patching=1, num_lines_presentation=1, fontsize=9.0,
    saved_attribute_attributes=param("Mode", 2, 0, 2, 0, 0, invisible=1, enum=["Notes", "Chords", "Drums"]))
button("generate", "Generate", [RX, 138, 116, 22], MAIN, **info("generate"))

# ---------------------------------------------------------------- page: settings

comment("s_title", "Settings", [6, 8, 200, 18], SETTINGS)
comment("s_keylabel", "Moth Quantum API key", [6, 36, 300, 18], SETTINGS)
box("key", "textedit", [706, 56, 420, 20], pres=[6, 56, 420, 20], page=SETTINGS, **info("key"),
    numinlets=1, numoutlets=4, outlettype=["", "int", "", ""], outputmode=1, keymode=0,
    fontsize=10.0, text="")
button("save", "Save key", [432, 55, 80, 22], SETTINGS)
comment("s_result", "", [6, 80, 600, 18], SETTINGS)             # verification result / warning
box("s_note", "comment", [706, 98, 600, 14], pres=[6, 98, 600, 14], page=SETTINGS,
    text="Stored in your user folder, never in the Live set or the device.",
    fontname=FONT, fontsize=9.0, textcolor=DIM, numinlets=1, numoutlets=0)

# Phase alignment toggle: on by default; a stored Live parameter
box("align", "live.text", [706, 120, 150, 18], pres=[6, 120, 150, 18], page=SETTINGS, **info("align"),
    numinlets=1, numoutlets=2, outlettype=["", ""], mode=1,
    text="Align phrases to the bar", texton="Align phrases to the bar", parameter_enable=1,
    saved_attribute_attributes=param("Align to bar", 2, 0, 1, 1, 0, invisible=1, enum=["off", "on"]))
box("s_alignnote", "comment", [866, 122, 460, 14], pres=[166, 122, 460, 14], page=SETTINGS,
    text="The engine returns each phrase a few steps off the beat; this rotates it back onto the source's grid.",
    fontname=FONT, fontsize=9.0, textcolor=DIM, numinlets=1, numoutlets=0)
button("back", "Back", [6, 142, 60, 18], SETTINGS)

# ---------------------------------------------------------------- scripts

newobj("node", "node.script quantum.js", [30, 330, 140, 22], 1, 2,
       saved_object_attributes={"autostart": 1, "defer": 0, "node_bin_path": "", "npm_bin_path": "", "watch": 1})
newobj("js", "js live.js", [400, 330, 60, 22], 1, 2)


# panel -> node. One click on a live.text reached the script twice (two
# generation jobs nine seconds apart, the second queued behind the first), so
# every button is debounced: `onebang` passes the first bang and stays shut
# until `delay` reopens it 400ms later. The onebangs are opened at load.
DEBOUNCED = []


def debounced(key, x):
    """Returns the name of a box whose outlet 0 bangs once per click of `key`."""
    newobj(key + "_t", "t b", [x, 180, 30, 22], 1, 1, ["bang"])
    newobj(key + "_ob", "onebang", [x, 205, 55, 22], 2, 1, ["bang"])
    newobj(key + "_tt", "t b b", [x, 230, 40, 22], 1, 2, ["bang", "bang"])
    newobj(key + "_d", "delay 400", [x + 50, 255, 60, 22], 2, 1, ["bang"])
    line(key, key + "_t"); line(key + "_t", key + "_ob"); line(key + "_ob", key + "_tt")
    line(key + "_tt", key + "_d", 1); line(key + "_d", key + "_ob", 0, 1)
    DEBOUNCED.append(key + "_ob")
    return key + "_tt"


for key, x in (("learn", 30), ("generate", 150)):
    msg(key + "_m", key, [x, 280, 55, 22])
    line(debounced(key, x), key + "_m", 0); line(key + "_m", "node")

for i, key in enumerate(("bars", "variation", "key", "align")):
    newobj(key + "_p", "prepend " + key, [270 + 110 * i, 230, 100, 22], 1, 1)
    line(key, key + "_p"); line(key + "_p", "node")

# mode tab -> live.js directly; live.js pushes detected modes back with `setmode`
newobj("mode_p", "prepend mode", [700, 230, 90, 22], 1, 1)
line("modetab", "mode_p"); line("mode_p", "js")

# Save: bang the field so it outputs its text (return in the field does the same)
line(debounced("save", 600), "key", 0)

# node -> panel / shader / live.js
ROUTE = ["status", "clearkey", "viz", "setbars", "ready", "enable", "needkey", "keymask", "seqlearn", "seqgen", "keystate", "keysaved", "seqloss", "state", "label", "clipname", "clipinfo", "clipinfo2"]
newobj("route_n", "route " + " ".join(ROUTE), [30, 380, 520, 22], 1, len(ROUTE) + 1)
line("node", "route_n")
R = ROUTE.index

newobj("status_s", "prepend set", [30, 420, 70, 22], 1, 1)
line("route_n", "status_s", R("status")); line("status_s", "status")

msg("key_clear", "clear", [190, 420, 40, 22])
line("route_n", "key_clear", R("clearkey")); line("key_clear", "key")

newobj("viz_p", "prepend param", [240, 420, 85, 22], 1, 1)
line("route_n", "viz_p", R("viz"))

newobj("bars_s", "prepend set", [335, 420, 70, 22], 1, 1)
line("route_n", "bars_s", R("setbars")); line("bars_s", "bars")

# on ready, every stored control re-sends its value to the freshly started script
newobj("ready_t", "t b b b", [415, 420, 50, 22], 1, 3, ["bang", "bang", "bang"])
line("route_n", "ready_t", R("ready"))
line("ready_t", "bars", 0); line("ready_t", "variation", 1); line("ready_t", "align", 2)

# enable <learn> <generate> -> active on each button
newobj("enable_u", "unpack 0 0", [480, 420, 70, 22], 1, 2, ["int", "int"])
line("route_n", "enable_u", R("enable"))
newobj("enable_l", "prepend active", [480, 450, 85, 22], 1, 1)
newobj("enable_g", "prepend active", [570, 450, 85, 22], 1, 1)
line("enable_u", "enable_l", 0); line("enable_l", "learn")
line("enable_u", "enable_g", 1); line("enable_g", "generate")

newobj("keymask_s", "prepend set", [660, 420, 70, 22], 1, 1)
line("route_n", "keymask_s", R("keymask")); line("keymask_s", "key")

newobj("keystate_s", "prepend set", [740, 420, 70, 22], 1, 1)
line("route_n", "keystate_s", R("keystate")); line("keystate_s", "s_result")

newobj("label_s", "prepend set", [820, 420, 70, 22], 1, 1)
line("route_n", "label_s", R("label")); line("label_s", "learnlabel")
newobj("nclip_s", "prepend set", [900, 420, 70, 22], 1, 1)
line("route_n", "nclip_s", R("clipname")); line("nclip_s", "clipname")
newobj("nclipinfo_s", "prepend set", [980, 420, 70, 22], 1, 1)
line("route_n", "nclipinfo_s", R("clipinfo")); line("nclipinfo_s", "clipinfo")
newobj("nclipinfo2_s", "prepend set", [980, 450, 70, 22], 1, 1)
line("route_n", "nclipinfo2_s", R("clipinfo2")); line("nclipinfo2_s", "clipinfo2")

# state dot: 0 idle (hidden), 1 working, 2 done, 3 failed — from either script
newobj("state_sel", "sel 0 1 2 3", [1060, 420, 90, 22], 1, 5, ["bang", "bang", "bang", "bang", ""])
line("route_n", "state_sel", R("state"))
for i, (key, rgba) in enumerate((("idle", "0. 0. 0. 0."), ("busy", "0.95 0.66 0.2 1."),
                                  ("ok", "0.45 0.78 0.45 1."), ("err", "0.9 0.36 0.3 1."))):
    msg("dot_" + key, "bgcolor " + rgba, [1060 + i * 130, 450, 120, 22])
    line("state_sel", "dot_" + key, i); line("dot_" + key, "dot")

line("route_n", "js", len(ROUTE))     # everything else: read, write …

# step sequences -> matrices -> textures the shader samples
for key, mat, tex, x, w in (("seqlearn", LRN, LRNT, 740, 256), ("seqgen", GEN, GENT, 900, 256), ("seqloss", LOSS, LOSST, 1060, 64)):
    newobj(key + "_t", "t b l", [x, 420, 40, 22], 1, 2, ["bang", ""])
    newobj(key + "_fill", "jit.fill " + mat, [x + 50, 450, 90, 22], 1, 1)
    newobj(key + "_mat", "jit.matrix %s 1 char %d 1" % (mat, w), [x, 480, 150, 22], 1, 2, ["jit_matrix", ""])
    newobj(key + "_tex", "jit.gl.texture %s @name %s" % (CTX, tex), [x, 510, 150, 22], 1, 2, ["jit_gl_texture", ""])
    line("route_n", key + "_t", R(key))
    line(key + "_t", key + "_fill", 1)
    line(key + "_t", key + "_mat", 0)
    line(key + "_mat", key + "_tex")

# pages: one message per page hides the other page's objects and shows its own
newobj("thispatcher", "thispatcher", [30, 560, 70, 22], 1, 2, ["", ""])
msg("page_settings", ", ".join(["script hide " + v for v in MAIN] + ["script show " + v for v in SETTINGS]), [30, 520, 600, 22])
msg("page_main", ", ".join(["script hide " + v for v in SETTINGS] + ["script show " + v for v in MAIN]), [30, 545, 600, 22])
line("page_settings", "thispatcher"); line("page_main", "thispatcher")
line(debounced("settings", 700), "page_settings", 0)
line(debounced("back", 800), "page_main", 0)
line("route_n", "page_settings", R("needkey"))    # boot without a key
line("route_n", "page_main", R("keysaved"))       # verified: straight back to work

# live.js -> panel / shader / node
JROUTE = ["status", "clipname", "clipinfo", "play", "seqgen", "viz", "state", "clipinfo2", "setmode"]
newobj("route_j", "route " + " ".join(JROUTE), [400, 380, 260, 22], 1, len(JROUTE) + 1)
line("js", "route_j")
J = JROUTE.index
newobj("jstatus_s", "prepend set", [400, 600, 70, 22], 1, 1)
line("route_j", "jstatus_s", J("status")); line("jstatus_s", "status")
newobj("clip_s", "prepend set", [480, 600, 70, 22], 1, 1)
line("route_j", "clip_s", J("clipname")); line("clip_s", "clipname")
newobj("clipinfo_s", "prepend set", [560, 600, 70, 22], 1, 1)
line("route_j", "clipinfo_s", J("clipinfo")); line("clipinfo_s", "clipinfo")
newobj("play_p", "prepend param play", [640, 600, 110, 22], 1, 1)      # what's playing, and where
line("route_j", "play_p", J("play")); line("play_p", "shader")
line("route_j", "seqgen_t", J("seqgen"))      # a generated clip other than the last started
line("route_j", "viz_p", J("viz"))
line("route_j", "state_sel", J("state"))
line("route_j", "nclipinfo2_s", J("clipinfo2"))
newobj("setmode_s", "prepend set", [1140, 600, 70, 22], 1, 1)
line("route_j", "setmode_s", J("setmode")); line("setmode_s", "modetab")
line("route_j", "node", len(JROUTE))          # tokens, clip

# ---------------------------------------------------------------- jitter

newobj("thisdevice", "live.thisdevice", [620, 200, 90, 22], 1, 3, ["bang", "int", "int"])
newobj("load_t", "t b b 1", [620, 230, 50, 22], 1, 3, ["bang", "bang", "int"])
line("thisdevice", "load_t")
for ob in DEBOUNCED:                                    # open the debouncers
    line("load_t", ob, 1, 1)

newobj("qmetro", "qmetro 33", [660, 260, 65, 22], 2, 1, ["bang"])
line("load_t", "qmetro", 2)

newobj("frame_t", "t b b", [660, 290, 40, 22], 1, 2, ["bang", "bang"])
line("qmetro", "frame_t")

newobj("clock", "cpuclock", [720, 320, 55, 22], 1, 1, ["float"])
newobj("ms", "/ 1000.", [720, 350, 50, 22], 2, 1, ["float"])
msg("time_m", "param time $1", [720, 380, 85, 22])
line("frame_t", "clock", 1); line("clock", "ms"); line("ms", "time_m")

newobj("erase_t", "t b erase", [620, 320, 60, 22], 1, 2, ["bang", ""])
line("frame_t", "erase_t", 0)

# transport: plugsync~ polled per frame; playing flag and beat phase to the shader
newobj("sync", "plugsync~", [820, 320, 200, 22], 1, 10,
       ["int", "int", "int", "float", "list", "float", "float", "int", "", "signal"])
line("frame_t", "sync", 1)
msg("playing_m", "param playing $1", [820, 350, 100, 22])
msg("beat_m", "param beat $1", [930, 350, 90, 22])
line("sync", "playing_m", 0); line("sync", "beat_m", 3)
line("playing_m", "shader"); line("beat_m", "shader")

newobj("render", "jit.gl.render %s @erase_color 0.075 0.078 0.09 1." % CTX, [620, 660, 260, 22], 1, 2, ["", ""])
line("erase_t", "render", 0); line("erase_t", "render", 1)

newobj("shader", "jit.gl.shader %s @name %s @file quantum.jxs" % (CTX, SHADER), [820, 600, 250, 22], 1, 2, ["", ""])
line("time_m", "shader"); line("viz_p", "shader")

newobj("plane", "jit.gl.videoplane %s @transform_reset 2 @shader %s" % (CTX, SHADER), [820, 660, 260, 22], 1, 2, ["", ""])
# bind shader and textures after everything has instantiated
newobj("bind_d", "delay 300", [620, 260, 60, 22], 2, 1, ["bang"])
msg("bind_m", "shader %s, texture %s %s %s" % (SHADER, LRNT, GENT, LOSST), [620, 290, 260, 22])
line("load_t", "bind_d", 0); line("bind_d", "bind_m"); line("bind_m", "plane")

# ---------------------------------------------------------------- midi + dev

newobj("midiin", "midiin", [520, 30, 45, 22], 1, 1, ["int"])
newobj("midiout", "midiout", [520, 80, 50, 22], 1, 0, [])
line("midiin", "midiout")

box("devnote", "comment", [30, 700, 400, 40],
    text="dev: send these to node.script — chain 1/0 (each phrase continues the last) / reset / forget / models / seed 1234 / info (to js)",
    fontsize=10.0, numinlets=1, numoutlets=0)
for i, (t, w) in enumerate([("chain 1", 50), ("chain 0", 50), ("reset", 40), ("forget", 45), ("models", 48), ("seed 1234", 65), ("info", 35)]):
    key = "dev_%d" % i
    msg(key, t, [30 + i * 75, 740, w, 22])
    line(key, "js" if t == "info" else "node")

# ---------------------------------------------------------------- patcher

patcher = {
    "patcher": {
        "fileversion": 1,
        "appversion": {"major": 8, "minor": 5, "revision": 8, "architecture": "x64", "modernui": 1},
        "classnamespace": "box",
        "rect": [100.0, 100.0, 1200.0, 800.0],
        "openrect": [0.0, 0.0, 0.0, float(HEIGHT + 1)],
        "bglocked": 0,
        "openinpresentation": 1,
        "default_fontsize": 10.0,
        "default_fontface": 0,
        "default_fontname": "Arial",
        "gridonopen": 1,
        "gridsize": [8.0, 8.0],
        "gridsnaponopen": 1,
        "objectsnaponopen": 1,
        "statusbarvisible": 2,
        "toolbarvisible": 1,
        "lefttoolbarpinned": 0,
        "toptoolbarpinned": 0,
        "righttoolbarpinned": 0,
        "bottomtoolbarpinned": 0,
        "toolbars_unpinned_last_save": 0,
        "tallnewobj": 0,
        "boxanimatetime": 500,
        "enablehscroll": 1,
        "enablevscroll": 1,
        "devicewidth": float(WIDTH),
        # Live's Info View text when the device is selected
        "description": (
            "Quantum Variations learns the phrase in a MIDI clip, trains a quantum reservoir on it "
            "through the Moth Quantum API, and writes new variations back as clips on the same track.\n\n"
            "Select a MIDI clip and press Learn Clip. Choose how many bars you want and how far to stray "
            "with Variation, then press Generate. Each new clip lands in the next free slot, named after "
            "the source. Add your Moth Quantum API key under Settings."
        ),
        "digest": "",
        "tags": "",
        "style": "",
        "subpatcher_template": "",
        "assistshowspatchername": 0,
        "boxes": boxes,
        "lines": patchlines(),
        "dependency_cache": [
            {"name": n, "bootpath": "~/Documents/WIP/Moth/Ableton/Max", "type": t, "implicit": 1}
            for n, t in [("live.js", "TEXT"), ("quantum.js", "TEXT"), ("quantum.jxs", "TEXT")]
        ],
        "latency": 0,
        "is_mpe": 0,
        "minimum_live_version": "",
        "minimum_max_version": "",
        "platform_compatibility": 0,
        "project": {
            "version": 1,
            "creationdate": 3590052786,
            "modificationdate": 3590052786,
            "viewrect": [0.0, 0.0, 300.0, 500.0],
            "autoorganize": 1,
            "hideprojectwindow": 1,
            "showdependencies": 1,
            "autolocalize": 0,
            "contents": {"patchers": {}, "code": {}},
            "layout": {},
            "searchpath": {},
            "detailsvisible": 0,
            "amxdtype": 1835887981,
            "readonly": 0,
            "devpathtype": 0,
            "devpath": ".",
            "sortmode": 0,
            "viewmode": 0,
            "includepackages": 0,
        },
        "autosave": 0,
    }
}


def pack_amxd(patcher_json):
    ptch = patcher_json.encode("utf-8") + b"\r\n\x00"
    out = b"ampf" + struct.pack("<I", 4)
    out += b"mmmm"
    out += b"meta" + struct.pack("<I", 4) + struct.pack("<I", 1)
    out += b"ptch" + struct.pack("<I", len(ptch)) + ptch
    return out


def main():
    text = json.dumps(patcher, indent="\t", separators=(",", " : "))
    with open(OUT, "wb") as f:
        f.write(pack_amxd(text))
    print("wrote", OUT, len(boxes), "boxes,", len(lines), "lines")
    if "--maxpat" in sys.argv:
        p = os.path.join(ROOT, "QuantumVariations.maxpat")
        with open(p, "w") as f:
            f.write(text)
        print("wrote", p)


if __name__ == "__main__":
    main()
