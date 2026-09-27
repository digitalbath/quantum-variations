// live.js — Max `js` object (NOT node.script). ES5 only.
//
// The only script that touches the Live API. Reads the clip open in the
// detail view into tokens, and writes generated tokens back as a new clip in
// the next free slot on the same track.
//
// Tokens: one per sixteenth-note step, REST (0) where nothing starts.
//   Notes mode (a melody or a bassline): the token is the lowest pitch starting on the step. Any
//     notes stacked above it are remembered with that pitch and put back
//     when it is generated.
//   Chords / Drums mode: the token is the *set* of pitches starting on the
//     step — a chord shape or a hit combination — numbered from 1 in order
//     of first appearance. The reservoir then learns the sequence of shapes,
//     which is what matters for a progression or a beat. The two modes
//     tokenise identically; they differ in how they are detected and named.
// In every mode the notes behind each token (pitches, durations, velocities)
// are kept per occurrence and re-applied in turn on write, so articulation
// survives the round trip while the reservoir sees a small integer
// vocabulary.
//
// Messages in:  read, write <tokens…>, mode <0|1|2>, shade <variation>, info, bang
// Messages out (outlet 0, dispatched by a `route` in the patcher):
//   tokens <csv>, clip <stepsPerBar> <bars> <name…>   -> quantum.js
//   tokenmap <csv>                                     -> quantum.js: token id -> pitch to
//                                                         show for it (set modes only)
//   setmode <n>                                        -> the mode tab, when detected
//   status <text>, clipname <name>, clipinfo <text>    -> the panel
//   play <kind> <step>                                 -> the shader: what's playing on the
//                                                         track (0 other, 1 source, 2 generated)
//                                                         and where, in sixteenth steps
//   seqgen <256 ints>, viz ngen <n>                    -> the shader, when a generated clip
//                                                         other than the last one starts

autowatch = 1;
inlets = 1;
outlets = 2;          // 0: messages   1: bang when a clip has been written

var REST = 0;
var STEPS_PER_BEAT = 4;   // sixteenths

var MODE_NAMES = ["Notes", "Chords", "Drums"];
var tokenMode = 0;        // 0 notes (one line: melody or bass), 1 chords, 2 drums
var modeSource = "auto";  // "user" once the tab has been touched; auto-detect stops overriding
var modeMessages = 0;     // the first `mode` message is the tab restoring its saved value

var profile = {};         // token -> [ { notes: [ { pitch, duration, velocity } ] }, … ] per occurrence
var profileCursor = {};   // token -> next entry to use when writing
var tokenNotes = {};      // set modes: token id -> sorted pitches (for the display map)
var fallback = { duration: 0.25, velocity: 100 };
var sourceName = "";
var sourceTrackPath = null;
var sourceClipId = null;
var sourceColor = -1;     // color_index of the source clip; derived clips inherit its hue
var shadeVariation = 1;   // the Variation the phrase was generated at: 1 same shade, 3 lighter, 0 darker
var paletteLum = {};      // hue column -> [ { idx, lum } ] sorted dark to light, measured from Live
var writtenClips = {};    // clip id -> tokens, for every clip this device wrote
var slotWatch = null;     // observes the track's playing_slot_index
var posWatch = null;      // observes the playing clip's playing_position
var playingKind = 0;
var stepsPerBar = 16;
var written = 0;

function post_(msg) { post(msg + "\n"); }

// Status line plus its dot: 1 working, 2 done, 3 failed.
function status(msg, state) {
  post_(msg);
  outlet(0, "status", msg);
  if (state !== undefined) outlet(0, "state", state);
}

// ---------------------------------------------------------------- reading

function detailClip() {
  var api = new LiveAPI("live_set view detail_clip");
  if (!api.id || api.id === "0") return null;
  return api;
}

// "live_set tracks 3 clip_slots 1 clip" -> "live_set tracks 3"
function trackPathOf(clip) {
  var m = /^(live_set tracks \d+)/.exec(clip.unquotedpath || clip.path.replace(/"/g, ""));
  return m ? m[1] : null;
}

function read() {
  try {
    var clip = detailClip();
    if (!clip) return status("Select a MIDI clip first", 3);
    if (parseInt(clip.get("is_midi_clip"), 10) !== 1) return status("That's an audio clip — pick a MIDI clip", 3);

    var length = parseFloat(clip.get("length"));      // beats
    var steps = Math.round(length * STEPS_PER_BEAT);
    if (!steps) return status("Clip has no length", 3);

    var num = parseInt(clip.get("signature_numerator"), 10) || 4;
    var den = parseInt(clip.get("signature_denominator"), 10) || 4;
    stepsPerBar = Math.max(1, Math.round(num * (16 / den)));
    var bars = Math.max(1, Math.round(steps / stepsPerBar));

    var data = JSON.parse(clip.call("get_notes_extended", 0, 128, 0, length));
    var notes = data.notes || [];
    if (!notes.length) return status("Clip is empty", 3);

    // group note starts by step
    var byStep = {};
    var durTotal = 0, velTotal = 0;
    for (var n = 0; n < notes.length; n++) {
      var note = notes[n];
      var step = Math.round(note.start_time * STEPS_PER_BEAT);
      if (step < 0 || step >= steps) continue;
      (byStep[step] = byStep[step] || []).push(note);
      durTotal += note.duration;
      velTotal += note.velocity;
    }
    fallback.duration = durTotal / notes.length;
    fallback.velocity = Math.round(velTotal / notes.length);

    // mode: auto-detected unless the user has chosen; a new track resets that
    var trackPath = trackPathOf(clip);
    if (trackPath !== sourceTrackPath) modeSource = "auto";
    var detected = detectMode(trackPath, byStep);
    if (modeSource !== "user" && detected !== tokenMode) {
      tokenMode = detected;
      outlet(0, "setmode", tokenMode);
    }

    profile = {};
    profileCursor = {};
    tokenNotes = {};
    var grid = [];
    var distinct = 0;
    var ids = {};                                  // set modes: "36+42" -> id
    for (var s = 0; s < steps; s++) {
      var group = byStep[s];
      if (!group) { grid.push(REST); continue; }
      group.sort(function (a, b) { return a.pitch - b.pitch; });
      var entry = { notes: [] };
      var pitchesHere = [];
      for (var g = 0; g < group.length; g++) {
        var p = Math.round(group[g].pitch);
        pitchesHere.push(p);
        entry.notes.push({ pitch: p, duration: group[g].duration, velocity: Math.round(group[g].velocity) });
      }
      var token;
      if (tokenMode === 0) {
        token = pitchesHere[0];                    // lowest pitch
      } else {
        var key = pitchesHere.join("+");
        if (!ids[key]) { ids[key] = ++distinct; tokenNotes[ids[key]] = pitchesHere; }
        token = ids[key];
      }
      (profile[token] = profile[token] || []).push(entry);
      grid.push(token);
    }
    if (tokenMode === 0) {
      for (var t in profile) if (profile.hasOwnProperty(t)) distinct++;
    }

    sourceName = String(clip.get("name")).replace(/^"|"$/g, "");
    sourceTrackPath = trackPathOf(clip);
    sourceClipId = String(clip.id);
    sourceColor = parseInt(clip.get("color_index"), 10);
    watchTrack();

    post_("read " + notes.length + " notes over " + steps + " steps as " + MODE_NAMES[tokenMode].toLowerCase());
    outlet(0, "clipname", sourceName || "untitled");
    outlet(0, "clipinfo", bars + (bars === 1 ? " bar · " : " bars · ") + notes.length + " notes");
    outlet(0, "clipinfo2", distinct + [" pitches", " chords", " hit patterns"][tokenMode]);
    // in set modes, tell the display which pitch stands for each token id
    var map = [0];
    for (var id = 1; id <= distinct; id++) map.push(tokenMode === 0 ? id : tokenNotes[id][0]);
    outlet(0, "tokenmap", tokenMode === 0 ? "" : map.join(","));
    outlet(0, "tokens", grid.join(","));           // one symbol, so node gets it whole
    outlet(0, "clip", stepsPerBar, bars, sourceName || "untitled");
  } catch (e) {
    post_("read error: " + e.message);
    status("Couldn't read that clip", 3);
  }
}

// ---------------------------------------------------------------- writing

function nextEntry(token) {
  var list = profile[token];
  if (!list || !list.length) {
    // unknown token: in notes mode it is a pitch, so play it plainly; in set
    // modes there is nothing sensible to play
    if (tokenMode !== 0 || token < 1 || token > 127) return null;
    return { notes: [{ pitch: token, duration: fallback.duration, velocity: fallback.velocity }] };
  }
  var i = profileCursor[token] || 0;
  profileCursor[token] = (i + 1) % list.length;
  return list[i];
}

// ---------------------------------------------------------------- mode

// mode <n> — from the panel's tab. The first message after load is the tab
// restoring its saved value, not a choice, so detection may still override.
function mode(n) {
  tokenMode = Math.max(0, Math.min(2, parseInt(n, 10) || 0));
  modeMessages += 1;
  modeSource = modeMessages === 1 ? "auto" : "user";
}

// Drums if the track has a Drum Rack; chords if most note steps stack two or
// more notes; otherwise notes.
function detectMode(trackPath, byStep) {
  if (trackPath) {
    var track = new LiveAPI(trackPath);
    var count = track.id && track.id !== "0" ? track.getcount("devices") : 0;
    for (var i = 0; i < count; i++) {
      var dev = new LiveAPI(trackPath + " devices " + i);
      if (String(dev.get("class_name")) === "DrumGroupDevice") return 2;
    }
  }
  var poly = 0, mono = 0;
  for (var step in byStep) {
    if (!byStep.hasOwnProperty(step)) continue;
    if (byStep[step].length >= 2) poly++; else mono++;
  }
  return poly > 0 && poly >= mono ? 1 : 0;
}

// first empty clip slot on the source clip's track (or the selected track)
function nextFreeSlot() {
  var track = sourceTrackPath ? new LiveAPI(sourceTrackPath) : null;
  if (!track || !track.id || track.id === "0") track = new LiveAPI("live_set view selected_track");
  if (!track.id || track.id === "0") return null;
  var base = track.unquotedpath || track.path.replace(/"/g, "");
  var count = track.getcount("clip_slots");
  for (var i = 0; i < count; i++) {
    var slot = new LiveAPI(base + " clip_slots " + i);
    if (parseInt(slot.get("has_clip"), 10) === 0) return slot;
  }
  return null;
}

// write <token> <token> … -> a new clip in the next free slot
function write() {
  try {
    var tokens = arrayfromargs(arguments);
    if (!tokens.length) return post_("write: no tokens");

    var slot = nextFreeSlot();
    if (!slot) return status("No free clip slot on this track", 3);

    var beats = tokens.length / STEPS_PER_BEAT;
    slot.call("create_clip", beats);

    // Resolve the new clip by id. Never fall back to the detail clip: that is
    // the user's source, and writing into it would destroy their work.
    var ref = slot.get("clip");                     // ["id", N]
    var clipId = (ref && ref.length > 1) ? ref[1] : 0;
    if (!clipId || clipId === "0") return status("Couldn't create the clip", 3);
    var clip = new LiveAPI("id " + clipId);

    var notes = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = Math.round(tokens[i]);
      if (token === REST) continue;
      var start = i / STEPS_PER_BEAT;
      var entry = nextEntry(token);
      if (!entry) continue;
      for (var c = 0; c < entry.notes.length; c++) {
        var np = entry.notes[c].pitch;
        if (np < 1 || np > 127) continue;
        notes.push({ pitch: np, start: start,
                     duration: clampDur(entry.notes[c].duration, start, beats),
                     velocity: entry.notes[c].velocity });
      }
    }
    if (!notes.length) return status("Only rests came back — try again", 3);

    // The classic set_notes sequence. add_new_notes wants a real dictionary,
    // which the js object can't hand over cleanly. Deprecated in Live 11 but
    // still works; apply_note_modifications is the next thing to try if not.
    clip.call("set_notes");
    clip.call("notes", notes.length);
    for (var k = 0; k < notes.length; k++) {
      clip.call("note", notes[k].pitch, notes[k].start, notes[k].duration, notes[k].velocity, 0);
    }
    clip.call("done");

    // Name shows lineage as a version chain: "bass v1", "bass v2"…; learn
    // "bass v1" and its phrases are "bass v1.1", "bass v1.2"; and so on down.
    // Numbered by what is already on the track, so it survives sessions;
    // same colour as the source.
    var name = derivedName();
    clip.set("name", name);
    if (sourceColor >= 0) clip.set("color_index", shadedColor(clip));
    written += 1;
    writtenClips[String(clipId)] = tokens.slice();

    post_("wrote " + notes.length + " notes, " + beats + " beats");
    status("Added " + name + " to the track", 2);
    outlet(1, "bang");
  } catch (e) {
    post_("write error: " + e.message);
    status("Couldn't write the clip", 3);
  }
}

// shade <variation> — sent by quantum.js before each write
function shade(v) {
  shadeVariation = parseFloat(v);
  if (isNaN(shadeVariation)) shadeVariation = 1;
}

// Live's clip palette is 5 rows of 14 hues. Keep the source's hue and move
// up or down the rows by lightness with the Variation: 1 keeps the source's
// shade, towards 3 goes lighter, towards 0 darker. Row lightness is measured
// from Live itself (set an index, read the colour back) once per hue, since
// the rows are not in lightness order.
function shadedColor(clip) {
  var hue = sourceColor % 14;
  if (!paletteLum[hue]) {
    var rows = [];
    for (var r = 0; r < 5; r++) {
      var idx = r * 14 + hue;
      clip.set("color_index", idx);
      var rgb = parseInt(clip.get("color")[0], 10) || 0;
      var lum = 0.299 * ((rgb >> 16) & 255) + 0.587 * ((rgb >> 8) & 255) + 0.114 * (rgb & 255);
      rows.push({ idx: idx, lum: lum });
    }
    rows.sort(function (a, b) { return a.lum - b.lum; });
    paletteLum[hue] = rows;
  }
  var ranked = paletteLum[hue];
  var pos = 0;
  for (var i = 0; i < ranked.length; i++) if (ranked[i].idx === sourceColor) pos = i;
  var delta = Math.max(-2, Math.min(2, Math.round((shadeVariation - 1) * 1.5)));
  var target = Math.max(0, Math.min(ranked.length - 1, pos + delta));
  return ranked[target].idx;
}

function derivedName() {
  var src = sourceName || "quantum";
  // "bass v1.2" -> children are "bass v1.2.N"; anything else -> "name vN"
  var base = /\sv\d+(\.\d+)*$/.test(src) ? src + "." : src + " v";
  var pattern = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)$");
  var highest = 0;
  var trackPath = sourceTrackPath || "live_set view selected_track";
  var track = new LiveAPI(trackPath);
  if (track.id && track.id !== "0") {
    var tp = track.unquotedpath || track.path.replace(/"/g, "");
    var count = track.getcount("clip_slots");
    for (var i = 0; i < count; i++) {
      var slot = new LiveAPI(tp + " clip_slots " + i);
      if (parseInt(slot.get("has_clip"), 10) !== 1) continue;
      var nm = String(new LiveAPI(tp + " clip_slots " + i + " clip").get("name")).replace(/^"|"$/g, "");
      var m = pattern.exec(nm);
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    }
  }
  return base + (highest + 1);
}

function clampDur(d, start, beats) {
  d = d > 0 ? d : fallback.duration || 0.25;
  return Math.max(1 / 16, Math.min(d, beats - start));
}

// ---------------------------------------------------------------- playback

// Follow what the source track is playing so the display can light the step
// under the playhead. playing_slot_index tells us which clip; if it is the
// source or one of ours, its playing_position (beats) becomes a step count.
function watchTrack() {
  if (!sourceTrackPath) return;
  if (!slotWatch) {
    slotWatch = new LiveAPI(onSlotChange, sourceTrackPath);
    slotWatch.property = "playing_slot_index";
  } else {
    slotWatch.path = sourceTrackPath;
  }
  var cur = slotWatch.get("playing_slot_index");
  onSlotChange(["playing_slot_index", cur && cur.length ? cur[0] : -1]);
}

function onSlotChange(args) {
  if (args[0] !== "playing_slot_index") return;
  var idx = parseInt(args[1], 10);
  var id = null;
  if (idx >= 0) {
    var ref = new LiveAPI(sourceTrackPath + " clip_slots " + idx).get("clip");
    if (ref && ref.length > 1 && String(ref[1]) !== "0") id = String(ref[1]);
  }
  playingKind = 0;
  if (id === sourceClipId) playingKind = 1;
  else if (id && writtenClips[id]) {
    playingKind = 2;
    outlet(0, "seqgen", padded(writtenClips[id]));   // the ring shows the clip that's playing
    outlet(0, "viz", "ngen", writtenClips[id].length);
  }
  if (!id || !playingKind) {
    outlet(0, "play", 0, 0);
    return;
  }
  if (!posWatch) {
    posWatch = new LiveAPI(onPosition, "id " + id);
    posWatch.property = "playing_position";
  } else {
    posWatch.id = parseInt(id, 10);
  }
}

function onPosition(args) {
  if (args[0] !== "playing_position") return;
  outlet(0, "play", playingKind, parseFloat(args[1]) * STEPS_PER_BEAT);
}

function padded(tokens) {
  var row = [];
  for (var i = 0; i < 256; i++) row.push(i < tokens.length ? Math.max(0, Math.min(255, Math.round(tokens[i]))) : 0);
  return row;
}

// ---------------------------------------------------------------- misc

function bang() { read(); }

function info() {
  var clip = detailClip();
  if (!clip) return post_("no clip selected");
  post_("clip: " + clip.get("name") + " | " + clip.get("length") + " beats | " + trackPathOf(clip));
}

// ---------------------------------------------------------------- no-ops
// Messages node.script sends that the patcher may still deliver here.

function model() {}
function token() {}
function ready() {}
function credits() {}
function clearkey() {}
function viz() {}
function setbars() {}
function keymask() {}
function seqlearn() {}
function seqgen() {}
function seqloss() {}
function state() {}
function label() {}
function clipinfo() {}
function clipinfo2() {}
function tokenmap() {}
function setmode() {}
function align() {}
function enable() {}
function needkey() {}
function keystate() {}
function keysaved() {}
