#!/usr/bin/env node
// Runs live.js outside Max against a fake Live API: a track with a clip of
// chords (or drums), read() it in each mode, then write() a phrase back and
// check what notes would land. `node tools/test_live.js`.
const fs = require("fs");
const vm = require("vm");

function fakeLive(opts) {
  const notes = opts.notes;                       // [{pitch,start_time,duration,velocity}]
  const out = { outlets: [], posts: [], created: [], written: [], names: [], colors: [] };
  const clips = { 5: { name: opts.name || "keys", notes, color: 12 } };
  function LiveAPI(a, b) {
    let path = typeof a === "function" ? b : a;
    this.callback = typeof a === "function" ? a : null;
    // Live resolves view paths to canonical ones; the detail clip lives in slot 0 of track 0
    if (path === "live_set view detail_clip") path = "live_set tracks 0 clip_slots 0 clip";
    if (path === "live_set view selected_track") path = "live_set tracks 0";
    this.path = path; this.unquotedpath = path;
    this.id = "5";
    if (/devices \d+/.test(path)) this.id = "9";
    if (/^id (\d+)/.test(path)) this.id = RegExp.$1;
    if (/clip_slots (\d+)$/.test(path)) this.id = "20" + RegExp.$1;
    this.get = (prop) => {
      if (prop === "is_midi_clip") return [1];
      if (prop === "length") return [opts.beats];
      if (prop === "signature_numerator") return [4];
      if (prop === "signature_denominator") return [4];
      if (prop === "name") return [clips[this.id] ? clips[this.id].name : ""];
      if (prop === "color_index") return [12];
      if (prop === "color") {            // fake palette: row lightness 1 > 0 > 2 > 3 > 4
        const row = Math.floor(out.lastColorIndex / 14);
        const g = [200, 240, 160, 100, 60][row];
        return [(g << 16) | (g << 8) | g];
      }
      if (prop === "class_name") return [opts.drumRack ? "DrumGroupDevice" : "InstrumentGroupDevice"];
      if (prop === "has_clip") return [/clip_slots 0$/.test(path) ? 1 : 0];
      if (prop === "clip") return /clip_slots 0$/.test(path) ? ["id", 5] : ["id", 77];
      if (prop === "playing_slot_index") return [-1];
      return [0];
    };
    this.getcount = (what) => (what === "devices" ? 1 : 4);
    this.call = (fn, ...args) => {
      if (fn === "get_notes_extended") return JSON.stringify({ notes });
      if (fn === "create_clip") out.created.push(args[0]);
      if (fn === "note") out.written.push({ pitch: args[0], start: args[1], duration: args[2], velocity: args[3] });
      return null;
    };
    this.set = (prop, v) => {
      if (prop === "name") out.names.push(v);
      if (prop === "color_index") { out.colors.push(v); out.lastColorIndex = v; }
    };
  }
  const ctx = {
    LiveAPI, post: (s) => out.posts.push(s), outlet: (i, ...a) => out.outlets.push(a),
    arrayfromargs: (args) => Array.prototype.slice.call(args), autowatch: 0, inlets: 1, outlets: 2,
    JSON, Math, String, parseInt, parseFloat, RegExp, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + "/../live.js", "utf8"), ctx);
  return { ctx, out };
}

function note(p, t, d = 0.5, v = 100) { return { pitch: p, start_time: t, duration: d, velocity: v }; }
let failures = 0;
function check(label, cond, detail) { console.log((cond ? "ok   " : "FAIL ") + label + (cond ? "" : "  " + detail)); if (!cond) failures++; }

// --- a bar of chords: C, F, G, C on the beats, each held a beat
const chords = [];
[[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]].forEach((c, i) => c.forEach((p) => chords.push(note(p, i, 1.0, 90 + i))));
{
  const { ctx, out } = fakeLive({ notes: chords, beats: 4 });
  ctx.read();
  const tokens = out.outlets.find((o) => o[0] === "tokens")[1].split(",").map(Number);
  const setmode = out.outlets.find((o) => o[0] === "setmode");
  const map = out.outlets.find((o) => o[0] === "tokenmap")[1];
  check("chords detected", setmode && setmode[1] === 1, JSON.stringify(setmode));
  check("chord tokens are shape ids", tokens.join(",") === "1,0,0,0,2,0,0,0,3,0,0,0,1,0,0,0", tokens.join(","));
  check("token map gives lowest pitches", map === "0,60,65,67", map);
  check("info line", out.outlets.find((o) => o[0] === "clipinfo2")[1] === "3 chords", "");
  ctx.write(2, 0, 3, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 1, 0);
  const w = out.written;
  check("writes whole chords", w.length === 18, "wrote " + w.length + " notes");
  check("F chord voicing restored", w.slice(0, 3).map((n) => n.pitch).join(",") === "65,69,72", w.slice(0, 3).map((n) => n.pitch).join(","));
  check("velocity carried per occurrence", w[0].velocity === 91, String(w[0].velocity));
  check("versioned name", out.names[0] === "keys v1", out.names[0]);
  check("colour inherited at variation 1", out.colors[out.colors.length - 1] === 12, String(out.colors));
  out.colors.length = 0; out.written.length = 0; ctx.shade(3); ctx.write(1, 0, 2, 0, 3, 0, 1, 0, 1, 0, 2, 0, 3, 0, 1, 0);
  check("variation 3 -> lightest row of the same hue", out.colors[out.colors.length - 1] === 12 + 14, String(out.colors[out.colors.length - 1]));
  out.colors.length = 0; out.written.length = 0; ctx.shade(0.1); ctx.write(1, 0, 2, 0, 3, 0, 1, 0, 1, 0, 2, 0, 3, 0, 1, 0);
  check("variation 0.1 -> a darker row", out.colors[out.colors.length - 1] === 12 + 28, String(out.colors[out.colors.length - 1]));
}

// --- drums: kick+hat, hat, snare+hat, hat …, on a Drum Rack track
const drums = [];
for (let s = 0; s < 16; s++) {
  drums.push(note(42, s / 4, 0.1, 70));                 // hat every step
  if (s % 8 === 0) drums.push(note(36, s / 4, 0.1, 120));   // kick
  if (s % 8 === 4) drums.push(note(38, s / 4, 0.1, 110));   // snare
}
{
  const { ctx, out } = fakeLive({ notes: drums, beats: 4, drumRack: true, name: "beat" });
  ctx.read();
  const tokens = out.outlets.find((o) => o[0] === "tokens")[1].split(",").map(Number);
  check("drums detected via Drum Rack", out.outlets.find((o) => o[0] === "setmode")[1] === 2, "");
  check("three hit patterns", out.outlets.find((o) => o[0] === "clipinfo2")[1] === "3 hit patterns", "");
  check("drum tokens", tokens.join(",") === "1,2,2,2,3,2,2,2,1,2,2,2,3,2,2,2", tokens.join(","));
  ctx.write(1, 2, 2, 3, 2, 2, 1, 2);
  check("hit combinations restored", out.written.filter((n) => n.pitch === 36).length === 2 && out.written.filter((n) => n.pitch === 42).length === 8, JSON.stringify(out.written.map((n) => n.pitch)));
}

// --- a melody stays melody; user choice sticks
{
  const { ctx, out } = fakeLive({ notes: [note(60, 0), note(62, 0.5), note(64, 1), note(65, 1.5), note(67, 2), note(69, 2.5), note(71, 3), note(72, 3.5)], beats: 4, name: "lead" });
  ctx.read();
  check("melody: no mode change", !out.outlets.find((o) => o[0] === "setmode"), "");
  check("melody tokens are pitches", out.outlets.find((o) => o[0] === "tokens")[1].startsWith("60,0,62,0,64"), "");
  ctx.mode(1); ctx.mode(1);          // restore, then a real choice: chords
  out.outlets.length = 0;
  ctx.read();
  check("user's mode is kept", !out.outlets.find((o) => o[0] === "setmode") && out.outlets.find((o) => o[0] === "tokens")[1].startsWith("1,0,2,0,3"), out.outlets.find((o) => o[0] === "tokens")[1]);
}
console.log(failures ? failures + " FAILED" : "all passed");
process.exit(failures ? 1 : 0);
