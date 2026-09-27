// quantum.js — Node for Max
//
// Everything that talks to the Moth Quantum API, plus the device's state
// machine. live.js (a Max `js` object) is the only thing that touches the Live
// API; the two scripts exchange plain Max messages through the patcher.
//
// No dependencies: node's own https module, because the Node bundled with
// Max 8 (v16) predates a global fetch.
//
// Messages in (from the panel or a message box):
//   learn                  read the detail clip via live.js, then train on it
//   generate               write BARS bars of new material at VARIATION
//   bars <n>               phrase length in bars (defaults to the source clip)
//   variation <f>          sampling temperature; low = literal, high = loose
//   align <0|1>            rotate each phrase onto the source's onset grid (default on)
//   key <apikey>           store an API key in the user's config file
//   train [csv]            train on the last clip (or an explicit sequence)
//   phrase [steps] [var]   generate an explicit number of sixteenth-steps
//   chain <0|1>            continue from the last generation instead of the model
//   reset                  drop the chained state
//   seed <n>               fix the sampling seed (0 = random each time)
//   forget                 clear the local model cache
//   models                 list cached models
//   job | describe <id> | coin [shots] | probe   dev inspection
//
// Messages out (left outlet, dispatched by a `route` in the patcher):
//   status <text>          for the panel's status line
//   state <0-3>            status dot: idle, working, done, failed
//   label/clipname/clipinfo <text>   the "what is learned" block
//   credits <text>         credits used; logged only, the panel no longer shows it
//   setbars <n>            push the source clip's bar count into the numbox
//   clearkey               wipe and hide the key field after a key is stored
//   needkey                no key anywhere: show the key field
//   viz <param> <values…>  shader parameters for the qubit display
//   ready                  script is up; panel controls re-send their values
//   enable <learn> <gen>   0/1 per button: greyed while busy, Generate until a clip is learned
//   keymask <text>         what the key field shows: x's when a key is present
//   keystate <text>        settings page result line (verifying, rejected, saved)
//   keysaved               key verified: patcher switches back to the main page
//   seqlearn <256 ints>    learned loop, one pitch per step, for the display
//   seqgen <256 ints>      last generated phrase, likewise
//   seqloss <64 ints>      training loss curve, scaled to the first epoch
//   read                   ask live.js for the detail clip
//   shade <variation>      tell live.js how to shade the new clip's colour
//   write <tokens…>        ask live.js to write a clip

const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Max = require("max-api");

const HOST = "api.mothquantum.com";
const BASE = "/api/v1";
const TRAIN_ENGINE = "qrc-train-v2";
const GEN_ENGINE = "qrc-gen-v2";

// Reservoir hyper-parameters. Kept in one place so a cached model is keyed on
// exactly what produced it.
const RESERVOIR = {
  num_qubits: 5,
  num_random_gates: 10,
  epochs: 50,
  mixing: 0.7,
  mode: "order",
  periodic: true,
  sample_fraction: 1,
  shots: 3000,
};

// ---------------------------------------------------------------- state

let API_KEY = "";
let KEY_SOURCE = "";      // "env" | "config" | ""
let TOKENS = null;        // sixteenth-step tokens of the last clip read
let TOKEN_MAP = null;     // set modes: token id -> pitch to display for it
let CLIP = { name: "", stepsPerBar: 16, bars: 1 };
let MODEL = null;         // { asset, job, vocab, loss, internal }
let BARS = 1;
let VARIATION = 1.0;
let SEED = 0;             // 0 = fresh random seed per phrase
let ALIGN = true;         // rotate phrases onto the source's bar grid (Settings toggle)
let CHAIN = false;
let GEN_STATE = null;     // asset id of the last generation's reservoir state
let LAST_JOB = null;
let BUSY = false;
let PENDING_LEARN = false;
let SESSION_CREDITS = 0;
let ENGINE_COST = { [TRAIN_ENGINE]: 5, [GEN_ENGINE]: 1 };   // refreshed from /engines
// Expected job durations in seconds, updated from each job that completes so
// the progress arc paces itself to this account's real turnaround.
let EXPECTED = { [TRAIN_ENGINE]: 60, [GEN_ENGINE]: 10 };

// ---------------------------------------------------------------- config

// Per-user config lives outside the device folder so the key never travels
// with the .amxd or a Live set. QUANTUM_MIDI_CONFIG overrides the path (tests).
function configPath() {
  if (process.env.QUANTUM_MIDI_CONFIG) return process.env.QUANTUM_MIDI_CONFIG;
  const home = os.homedir();
  // Still named after the device's first name, Quantum MIDI: renaming it would
  // strand every stored key and model cache.
  const dir =
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "QuantumMIDI") :
    process.platform === "win32" ? path.join(process.env.APPDATA || home, "QuantumMIDI") :
    path.join(home, ".config", "quantummidi");
  return path.join(dir, "config.json");
}

let CONFIG = { apiKey: "", creditsUsed: 0, models: {} };

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    CONFIG = Object.assign(CONFIG, parsed);
    if (!CONFIG.models) CONFIG.models = {};
  } catch (e) { /* first run */ }
}

function saveConfig() {
  try {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(CONFIG, null, 2));
  } catch (e) { Max.post("could not save config: " + e.message); }
}

// Key precedence: .env beside the script (developer override) > stored config.
function loadKey() {
  try {
    const line = fs.readFileSync(path.join(__dirname, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().indexOf("MOTH_API_KEY=") === 0);
    if (line) {
      API_KEY = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      KEY_SOURCE = "env";
      Max.post(`api key loaded from .env (${API_KEY.length} chars)`);
      return;
    }
  } catch (e) { /* no .env — normal for end users */ }
  if (CONFIG.apiKey) {
    API_KEY = CONFIG.apiKey;
    KEY_SOURCE = "config";
    Max.post(`api key loaded from ${configPath()}`);
  } else {
    Max.post("no api key — paste one into the device's key field");
  }
}

// ---------------------------------------------------------------- ui

// Status line plus its dot: 0 idle, 1 working, 2 done, 3 failed.
function status(text, state) {
  Max.post(text);
  Max.outlet("status", text);
  if (state !== undefined) Max.outlet("state", state);
}

function creditsChanged(cost) {
  SESSION_CREDITS += cost;
  CONFIG.creditsUsed = (CONFIG.creditsUsed || 0) + cost;
  saveConfig();
  Max.outlet("credits", `${CONFIG.creditsUsed} used · ${SESSION_CREDITS} session`);
}

function viz(param, ...values) {
  Max.outlet("viz", param, ...values);
}

// enable <learn> <generate>: Learn needs the script idle, Generate a clip too.
function pushEnable() {
  Max.outlet("enable", BUSY ? 0 : 1, BUSY || !TOKENS ? 0 : 1);
}

function pushKeyMask() {
  Max.outlet("keymask", API_KEY ? "xxxxxxxxxxxx" : "");
}

// Errors as the panel should show them: the full text goes to the console.
function friendly(message) {
  if (/^no api key/.test(message)) return "Add your API key in Settings";
  if (/^401/.test(message)) return "Moth rejected the API key — check Settings";
  if (/^402|credit/i.test(message)) return "Out of Moth credits";
  if (/Learn a clip first|no model/.test(message)) return "Select a clip and press Learn Clip";
  if (/too short/.test(message)) return "Clip too short — use a longer one";
  if (/timed out/.test(message)) return "Moth is taking too long — try again";
  if (/ENOTFOUND|ECONN|EAI_AGAIN/.test(message)) return "Can't reach Moth — check the connection";
  return "Something went wrong — see the Max console";
}

// the settings page's result line
function keystate(text) {
  Max.post(text);
  Max.outlet("keystate", text);
}

// A step sequence for the display, padded to the 256-wide matrix so stale
// steps from a longer earlier sequence are wiped.
// What the display should show for a token: the pitch itself in melody
// mode, the set's lowest pitch in chord/drum modes.
function displayPitch(t) {
  if (TOKEN_MAP && t > 0 && t < TOKEN_MAP.length) return TOKEN_MAP[t];
  return t;
}

function pushSequence(name, tokens, width = 256) {
  const row = new Array(width).fill(0);
  tokens.slice(0, width).forEach((t, i) => { row[i] = Math.max(0, Math.min(255, Math.round(displayPitch(t)))); });
  Max.outlet(name, ...row);
}

// The loss curve as 0..255 relative to its first epoch, so the display shows
// the shape of the descent whatever the absolute scale.
function pushLossCurve(curve) {
  if (!Array.isArray(curve) || !curve.length) return;
  const top = Math.max(curve[0], 1e-6);
  pushSequence("seqloss", curve.map((v) => 255 * Math.max(0, Math.min(1, v / top))), 64);
  viz("nloss", Math.min(curve.length, 64));
}

// Stage: 0 idle, 1 training, 2 generating, 3 done (brief flash), 4 error.
let DONE_TIMER = null;
function stage(s) {
  if (s === 1 || s === 2) viz("progress", 0);   // a new job starts its arc from empty
  viz("stage", s);
  if (DONE_TIMER) { clearTimeout(DONE_TIMER); DONE_TIMER = null; }
  if (s === 3 || s === 4) DONE_TIMER = setTimeout(() => viz("stage", 0), 2500);
}

// Map the reservoir's five memory values onto 0..1 around their mean so the
// display shows the *shape* of the state rather than its absolute scale.
function vizState(internal) {
  if (!Array.isArray(internal) || internal.length < 5) return;
  const mean = internal.reduce((a, b) => a + b, 0) / internal.length;
  const q = internal.slice(0, 5).map((v) => 0.5 + 0.5 * Math.tanh((v - mean) * 2));
  viz("qa", q[0], q[1], q[2], q[3]);
  viz("qb", q[4]);
}

// ---------------------------------------------------------------- http

function req(opts, payload) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          return reject(new Error(res.statusCode + " " + buf.toString().slice(0, 400)));
        }
        resolve({ buf, headers: res.headers, statusCode: res.statusCode });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function api(method, p, body) {
  if (!API_KEY) throw new Error("no api key");
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: "Bearer " + API_KEY };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  const { buf } = await req({ host: HOST, path: BASE + p, method, headers }, payload);
  const text = buf.toString();
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Presigned storage URLs: absolute, and fetched with no auth header.
async function rawUrl(method, urlStr, headers, payload) {
  const u = new URL(urlStr);
  const { buf } = await req({
    host: u.hostname,
    path: u.pathname + u.search,
    method,
    headers: headers || {},
  }, payload);
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- jobs

// Submit, poll, and return { status, result } where `result` is the file
// listing from /result and `status` is the final status body. The status body
// is the interesting one: it carries the engine's inline result — the training
// loss curve for train, the generated token sequence for gen. The /result
// endpoint and the job record don't, which is why this device once had to
// chain single-token calls.
async function runEngine(engineId, params, inputFiles, onProgress, expectedScale) {
  const body = { params: params || {} };
  if (inputFiles) body.input_files = inputFiles;

  const job = await api("POST", `/engines/${engineId}/process`, body);
  if (!job || !job.job_id) throw new Error("no job id in response: " + JSON.stringify(job).slice(0, 200));
  const id = job.job_id;
  LAST_JOB = id;
  creditsChanged(ENGINE_COST[engineId] || 1);
  Max.post(`${engineId}: job ${id}`);

  // Progress is paced by wall clock against the expected duration, ticking
  // every 100ms so the arc fills smoothly between the 1.5s status polls. It
  // holds at 95% if the job runs long, and completes when the job does.
  const started = Date.now();
  const expected = (EXPECTED[engineId] || 30) * (expectedScale || 1);
  const ticker = setInterval(() => {
    viz("progress", Math.min(0.95, (Date.now() - started) / 1000 / expected));
  }, 100);
  try {
    for (let i = 0; i < 160; i++) {
      await sleep(1500);
      const s = await api("GET", `/jobs/${id}/status`);
      if (onProgress) onProgress(s, (Date.now() - started) / 1000);
      if (s.status === "completed") {
        const took = (Date.now() - started) / 1000;
        EXPECTED[engineId] = 0.5 * (EXPECTED[engineId] || took) + 0.5 * took / (expectedScale || 1);
        const result = await api("GET", `/jobs/${id}/result`);
        return { status: s, result };
      }
      if (s.status === "failed" || s.status === "cancelled") {
        throw new Error(`job ${s.status}: ${JSON.stringify(s.error || s).slice(0, 300)}`);
      }
    }
    throw new Error("timed out waiting for job " + id);
  } finally {
    clearInterval(ticker);
  }
}

function outputSlot(result, slot) {
  const outs = (result && result.outputs) || [];
  return outs.find((o) => o.slot === slot) || outs[0] || null;
}

async function fetchOutput(out) {
  const buf = await rawUrl("GET", out.url, {});
  const text = buf.toString();
  try { return JSON.parse(text); } catch (e) { return text; }
}

async function downloadAsset(assetId) {
  const dl = await api("GET", `/assets/${assetId}/download`);
  const buf = await rawUrl("GET", dl.download_url, {});
  try { return JSON.parse(buf.toString()); } catch (e) { return null; }
}

async function assetExists(assetId) {
  try { await api("GET", `/assets/${assetId}`); return true; }
  catch (e) { return false; }
}

// Real per-run costs, so the counter reflects what Moth actually charges.
async function refreshCosts() {
  for (const id of [TRAIN_ENGINE, GEN_ENGINE]) {
    try {
      const e = await api("GET", `/engines/${id}`);
      if (typeof e.credits_per_run === "number") ENGINE_COST[id] = e.credits_per_run;
    } catch (e) { /* keep the defaults */ }
  }
}

function dump(label, obj) {
  const text = JSON.stringify(obj, null, 2);
  Max.post(`--- ${label} ---`);
  Max.post(text.length > 1200 ? text.slice(0, 1200) + " …(truncated, see file)" : text);
  try { fs.writeFileSync(path.join(__dirname, `last_${label}.json`), text); }
  catch (e) { Max.post("could not write dump: " + e.message); }
}

// ---------------------------------------------------------------- training

// The window slides over the sequence, so it has to be comfortably shorter
// than the sequence, and washout has to fit inside the window.
function trainParams(sequence) {
  const sampleLength = Math.max(4, Math.min(15, Math.floor(sequence.length / 2)));
  const washout = Math.max(2, Math.min(5, Math.floor(sampleLength / 3)));
  return Object.assign({ sequence, sample_length: sampleLength, washout }, RESERVOIR);
}

function modelKey(params) {
  return crypto.createHash("sha1").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

function useModel(m) {
  MODEL = m;
  GEN_STATE = null;   // a different model invalidates any chained state
  if (m.loss !== undefined) viz("coherence", Math.max(0, Math.min(1, 1 - m.loss)));
  vizState(m.internal);
  pushLossCurve(m.curve);
  Max.outlet("model", m.asset);
}

// Train on `sequence`, or pull the model from the cache if this exact clip
// has been trained with these exact parameters before. A cache hit costs
// nothing; a miss costs the train engine's credits.
async function train(sequence) {
  const params = trainParams(sequence);
  if (sequence.length <= params.sample_length + params.washout) {
    throw new Error(`clip too short to train on (${sequence.length} steps)`);
  }
  const vocabSize = new Set(sequence).size;
  if (vocabSize < 2) throw new Error("clip has only one distinct token — nothing to learn");
  if (sequence.length < vocabSize * 4) {
    Max.post(`warning: ${sequence.length} tokens for a vocabulary of ${vocabSize} is thin — a longer clip trains better`);
  }

  const key = modelKey(params);
  const cached = CONFIG.models[key];
  if (cached && await assetExists(cached.asset)) {
    status("Ready to generate", 2);
    useModel(cached);
    return cached;
  }

  stage(1);
  Max.post(`training on ${sequence.length} steps, ${vocabSize} tokens`);
  status("Learning…", 1);
  const { status: s, result } = await runEngine(TRAIN_ENGINE, params, null, (st) => {
    if (Array.isArray(st.result) && st.result.length) {
      viz("coherence", Math.max(0, Math.min(1, 1 - st.result[st.result.length - 1])));
    }
  });

  const out = outputSlot(result, "state");
  if (!out || !out.output_asset_id) throw new Error("no state output in the train result");
  const state = await fetchOutput(out);
  const lossCurve = Array.isArray(s.result) ? s.result : (state && state.training_loss) || [];

  const m = {
    asset: out.output_asset_id,
    job: LAST_JOB,
    vocab: (state && state.vocabulary) || Array.from(new Set(sequence)),
    loss: lossCurve.length ? lossCurve[lossCurve.length - 1] : undefined,
    curve: lossCurve.slice(0, 64),
    internal: state && state.internal_state,
    clip: CLIP.name,
    steps: sequence.length,
    sequence,                 // kept so a phrase can be compared with what it learned from
    created: new Date().toISOString(),
  };
  CONFIG.models[key] = m;
  saveConfig();
  useModel(m);
  viz("progress", 1);
  stage(3);
  status("Ready to generate", 2);
  return m;
}

// ---------------------------------------------------------------- generation

// Which token is the reservoir's last output, read from a state file.
function tokenFromState(state) {
  if (!state || typeof state !== "object") return null;
  const vocab = state.vocabulary;
  const id = state.last_id;
  if (!Array.isArray(vocab) || typeof id !== "number") return null;
  return id >= 0 && id < vocab.length ? vocab[id] : null;
}

function freshSeed() {
  return SEED || crypto.randomBytes(4).readUInt32BE(0);
}

// Generate `n` tokens from `stateAsset`. Returns { tokens, state }.
//
// The sequence arrives inline on the job's *status* body. If that ever stops
// being true, fall back to the old route: one call per token, reading
// `last_id` out of each returned state and chaining it into the next call.
async function generate(n, variation, stateAsset, warmup, seed) {
  const params = { length: n, variation, random_seed: seed };
  if (warmup && warmup.length) params.initial_events = warmup;

  // longer phrases take longer: scale the expected time by length, around 16 steps
  const { status: s, result } = await runEngine(GEN_ENGINE, params, { state: stateAsset }, null, 0.5 + n / 32);
  const out = outputSlot(result, "state");
  if (!out) throw new Error("gen returned no state output");

  if (Array.isArray(s.result) && s.result.length === n) {
    return { tokens: s.result, state: out.output_asset_id };
  }

  Max.post("no inline sequence on the status body — falling back to one call per token");
  const tokens = [];
  let state = out.output_asset_id;
  if (Array.isArray(s.result) && s.result.length) {
    tokens.push(...s.result);
  } else {
    const t = tokenFromState(await fetchOutput(out));
    if (t !== null) tokens.push(t);
  }
  while (tokens.length < n) {
    const r = await runEngine(GEN_ENGINE, { length: 1, variation, random_seed: (seed + tokens.length) >>> 0 }, { state });
    const o = outputSlot(r.result, "state");
    const t = tokenFromState(await fetchOutput(o));
    if (t === null) break;
    tokens.push(t);
    state = o.output_asset_id;
    viz("progress", tokens.length / n);
  }
  return { tokens, state };
}

// The engine keeps the source's rhythm but not its bar phase: warmed up on a
// phrase whose notes sit on the beat, it hands back the same rhythm shifted
// by a few steps (measured: three, on a 48-step on-beat test). So the phrase
// is rotated to the offset whose onsets best line up with where the source
// puts its onsets within a bar. Rotation is harmless for loop material and
// keeps deliberate syncopation, since the profile carries it.
function alignPhase(tokens, source, stepsPerBar) {
  if (!source || !source.length || tokens.length < stepsPerBar) return { tokens, shift: 0 };
  const profile = new Array(stepsPerBar).fill(0);
  source.forEach((t, i) => { if (t > 0) profile[i % stepsPerBar] += 1; });
  let best = 0, bestScore = -1;
  for (let r = 0; r < stepsPerBar; r++) {
    let score = 0;
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[(k + r) % tokens.length] > 0) score += profile[k % stepsPerBar];
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  const rotated = tokens.slice(best).concat(tokens.slice(0, best));
  return { tokens: rotated, shift: best };
}

async function phrase(n, variation) {
  if (!MODEL) throw new Error("no model — Learn a clip first");
  n = Math.max(1, Math.min(256, Math.round(n)));
  const seed = freshSeed();
  const fromModel = !(CHAIN && GEN_STATE);
  const source = fromModel ? MODEL.asset : GEN_STATE;

  // Warm the reservoir on the source phrase when starting from the trained
  // model, so generation continues *this* clip rather than the vocabulary in
  // the abstract. Chained calls already carry their own trajectory.
  const warmup = fromModel && TOKENS ? TOKENS.slice(-Math.min(TOKENS.length, 32)) : null;

  stage(2);
  Max.post(`generating ${n} steps at variation ${Number(variation).toFixed(2)}, seed ${seed}`);
  status(`Generating ${Math.round(n / CLIP.stepsPerBar)} bar${n > CLIP.stepsPerBar ? "s" : ""}…`, 1);
  const r = await generate(n, Number(variation), source, warmup, seed);
  GEN_STATE = r.state;
  if (!r.tokens.length) throw new Error("engine returned no tokens");

  if (ALIGN) {
    const aligned = alignPhase(r.tokens, TOKENS, CLIP.stepsPerBar);
    if (aligned.shift) Max.post(`phase: rotated ${aligned.shift} step${aligned.shift > 1 ? "s" : ""} to sit on the source's grid`);
    r.tokens = aligned.tokens;
  }

  const last = displayPitch(r.tokens[r.tokens.length - 1]);
  if (typeof last === "number" && last > 0) viz("pitch", Math.max(0, Math.min(1, (last - 36) / 60)));
  try { vizState((await downloadAsset(r.state) || {}).internal_state); } catch (e) { /* cosmetic */ }

  Max.post("phrase: " + r.tokens.join(" "));
  pushSequence("seqgen", r.tokens);
  viz("ngen", r.tokens.length);
  viz("progress", 1);
  stage(3);
  Max.outlet("shade", Number(variation));   // live.js shades the clip's colour by it
  Max.outlet("write", ...r.tokens);
  return r.tokens;
}

// ---------------------------------------------------------------- handlers

// Serialise the API calls: a second Generate while one is running would
// double-spend and race on GEN_STATE.
async function guarded(label, fn) {
  if (BUSY) return status("Busy…");
  BUSY = true;
  pushEnable();
  try { await fn(); }
  catch (e) {
    stage(4);
    Max.post("ERROR " + e.message);
    status(friendly(e.message), 3);
  } finally {
    BUSY = false;
    pushEnable();
  }
}

// key <apikey> — textedit may hand it over as `symbol <key>`.
// Verified against /me before it replaces a working key: a stray Enter in the
// field must not take the device down.
Max.addHandler("key", async (...args) => {
  // textedit prefixes its output with `text` (or `symbol`); the key is what follows
  const atoms = args.map(String);
  while (atoms.length && (atoms[0] === "text" || atoms[0] === "symbol")) atoms.shift();
  const k = atoms.join("").trim();
  if (/^x+$/.test(k)) return keystate("That's the mask of the stored key — paste a new key over it, or press Back.");
  if (k.length < 16) return keystate(k ? "That doesn't look like a key." : "Paste your key first.");
  const previous = API_KEY;
  API_KEY = k;
  keystate("Checking…");
  try {
    await api("GET", "/me");
  } catch (e) {
    API_KEY = previous;
    const code = e.message.slice(0, 3);
    return keystate(code === "401" ? "Moth rejected that key (401). Check it and try again."
                                   : "Couldn't verify the key: " + e.message.slice(0, 80));
  }
  CONFIG.apiKey = k;
  KEY_SOURCE = "config";
  saveConfig();
  Max.outlet("clearkey");
  pushKeyMask();
  keystate("Key verified and saved.");
  Max.outlet("keysaved");
  status("Key saved", 2);
  refreshCosts();
});

Max.addHandler("bars", (n) => {
  BARS = Math.max(1, Math.min(8, Math.round(Number(n)) || 1));
  viz("steps", BARS * CLIP.stepsPerBar);
});

Max.addHandler("variation", (v) => {
  VARIATION = Math.max(0.05, Number(v) || 1);
  viz("variation", VARIATION);
});

Max.addHandler("align", (on) => {
  ALIGN = on === undefined ? true : !!Number(on);
});

Max.addHandler("seed", (n) => {
  SEED = Math.max(0, Math.floor(Number(n)) || 0) >>> 0;
  Max.post(SEED ? `seed fixed at ${SEED}` : "seed: random per phrase");
});

// learn — round trip through live.js: `read` out, `tokens`/`clip` back in.
Max.addHandler("learn", () => {
  if (BUSY) return status("Busy…", 1);
  status("Reading clip…", 1);
  PENDING_LEARN = true;
  Max.outlet("read");
});

// tokenmap 0,36,38,… — sent by live.js before `tokens` in chord/drum modes
Max.addHandler("tokenmap", (csv) => {
  const m = String(csv === undefined ? "" : csv).split(/[,\s]+/).filter((v) => v !== "").map(Number);
  TOKEN_MAP = m.length > 1 ? m : null;
});

// tokens 60,0,62,0,… — sent by live.js after reading a clip
Max.addHandler("tokens", (csv) => {
  const sequence = String(csv).split(/[,\s]+/).filter((v) => v !== "").map(Number);
  if (sequence.length < 8) {
    PENDING_LEARN = false;
    return status("Clip too short — use at least half a bar", 3);
  }
  TOKENS = sequence;
  Max.post(`clip: ${sequence.length} steps, ${new Set(sequence).size} distinct tokens`);
  pushSequence("seqlearn", sequence);
  viz("nlearn", sequence.length);
  pushEnable();
  if (PENDING_LEARN) {
    PENDING_LEARN = false;
    guarded("learn", () => train(TOKENS));
  }
});

// clip <stepsPerBar> <bars> <name…> — sent by live.js alongside tokens
Max.addHandler("clip", (stepsPerBar, bars, ...name) => {
  CLIP = {
    stepsPerBar: Math.max(1, Number(stepsPerBar) || 16),
    bars: Math.max(1, Math.round(Number(bars)) || 1),
    name: name.join(" "),
  };
  BARS = CLIP.bars;
  Max.outlet("setbars", BARS);
  viz("steps", BARS * CLIP.stepsPerBar);
});

// generate — the panel's button. Trains first if it has to.
Max.addHandler("generate", () => guarded("generation", async () => {
  if (!TOKENS) throw new Error("Learn a clip first");
  if (!MODEL) await train(TOKENS);
  await phrase(BARS * CLIP.stepsPerBar, VARIATION);
}));

// train [csv] — explicit training, for message boxes and tests
Max.addHandler("train", (seqStr) => guarded("training", async () => {
  const sequence = seqStr
    ? String(seqStr).split(/[,\s]+/).filter(Boolean).map(Number)
    : TOKENS;
  if (!sequence) throw new Error("no clip read yet — send `learn` or `train <csv>`");
  await train(sequence);
}));

// phrase [steps] [variation]
Max.addHandler("phrase", (n, variation) => guarded("generation", async () => {
  await phrase(n === undefined ? BARS * CLIP.stepsPerBar : n, variation === undefined ? VARIATION : variation);
}));

// gen [length] [variation] — raw call, posts the tokens, doesn't write a clip
Max.addHandler("gen", (length = 8, variation = 1) => guarded("generation", async () => {
  if (!MODEL) throw new Error("no model — Learn a clip first");
  const r = await generate(Number(length), Number(variation), CHAIN && GEN_STATE ? GEN_STATE : MODEL.asset, null, freshSeed());
  GEN_STATE = r.state;
  Max.post("gen: " + r.tokens.join(" "));
}));

Max.addHandler("chain", (on) => {
  const was = CHAIN;
  CHAIN = on === undefined ? true : !!Number(on);
  if (CHAIN !== was) Max.post(CHAIN ? "chain on: each phrase carries on from the last" : "chain off: each phrase restarts from the clip");
});

Max.addHandler("reset", () => {
  GEN_STATE = null;
  Max.post("generation state cleared");
});

Max.addHandler("model", (id) => {
  useModel({ asset: String(id).trim(), vocab: [] });
  Max.post("model set: " + MODEL.asset);
});

Max.addHandler("forget", () => {
  CONFIG.models = {};
  saveConfig();
  MODEL = null;
  GEN_STATE = null;
  Max.post("model cache cleared");
});

Max.addHandler("models", () => {
  const keys = Object.keys(CONFIG.models);
  if (!keys.length) return Max.post("no cached models");
  keys.forEach((k) => {
    const m = CONFIG.models[k];
    Max.post(`${k}: "${m.clip}" ${m.steps} steps, ${m.vocab.length} tokens, loss ${m.loss !== undefined ? m.loss.toFixed(3) : "?"} (${m.created})`);
  });
});

// --- dev inspection ---------------------------------------------------

Max.addHandler("coin", (shots = 10) => guarded("coin toss", async () => {
  dump("coin", await runEngine("coin-toss-v1", { shots: Number(shots) }));
}));

Max.addHandler("job", async () => {
  try {
    if (!LAST_JOB) return Max.post("no job yet");
    dump("job", await api("GET", `/jobs/${LAST_JOB}/status`));
  } catch (e) { Max.post("ERROR " + e.message); }
});

Max.addHandler("describe", async (engineId) => {
  try { dump("engine", await api("GET", `/engines/${engineId}`)); }
  catch (e) { Max.post("ERROR " + e.message); }
});

Max.addHandler("probe", async () => {
  try { dump("me", await api("GET", "/me")); }
  catch (e) { Max.post("ERROR " + e.message); }
});

// Messages that live.js emits for the panel; nothing to do with them here.
Max.addHandler("status", () => {});
Max.addHandler("clipname", () => {});

// ---------------------------------------------------------------- boot

loadConfig();
loadKey();
Max.outlet("credits", `${CONFIG.creditsUsed || 0} used · 0 session`);
Max.outlet("ready");
pushEnable();
pushKeyMask();
viz("variation", VARIATION);
viz("steps", BARS * CLIP.stepsPerBar);
Max.outlet("label", "SOURCE");
Max.outlet("clipname", "None yet");
Max.outlet("clipinfo", "Select a MIDI clip");
Max.outlet("clipinfo2", "and press Learn Clip");
if (API_KEY) {
  status("", 0);
  keystate(KEY_SOURCE === "env" ? "Key loaded from .env beside the script (developer override)." : "A key is stored. Paste a new one to replace it.");
  refreshCosts();
} else {
  Max.outlet("needkey");
  keystate("No key yet. Paste your Moth Quantum API key and press Save.");
  status("Add your API key in Settings", 3);
}
Max.post("quantum.js loaded");

module.exports = { trainParams, modelKey };   // for tests
