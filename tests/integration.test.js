/*
 * MediaSniff integration proof — loads the REAL shipped background.js / popup.js
 * with stubbed browser + DOM APIs and exercises the end-to-end pipeline.
 * Run: node tests/integration.test.js   (exit 0 = pass)
 *
 * Each script is wrapped in its own function scope before evaluation so that
 * the two top-level `const browser` declarations don't collide in Node's single
 * shared realm (in the real extension they run in separate realms).
 */
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const load = f => vm.runInThisContext("(function(){\n" + read(f) + "\n})();", { filename: f });

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n         " + e.message); }
}

// Load the shared lib exactly like the extension does (attaches to globalThis).
const M = require("../lib/media.js");
global.importScripts = () => {}; // background.js guard calls this; lib already loaded.

let asyncErr = null;
process.on("unhandledRejection", e => { asyncErr = e; });

// ---- load real background.js against a stubbed browser ----
let sentCb = null, respCb = null, msgCb = null, lastSet = null;
global.browser = {
  webRequest: {
    onSendHeaders: { addListener: cb => { sentCb = cb; } },
    onResponseStarted: { addListener: cb => { respCb = cb; } }
  },
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  runtime: { onMessage: { addListener: cb => { msgCb = cb; } } },
  storage: {
    session: {
      get: async () => ({}),
      set: o => { lastSet = o; return Promise.resolve(); },
      remove: async () => {}
    }
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
};
load("background.js");

// Drive a background onMessage handler with a stubbed fetch (the grabber/jobs
// handlers call response.json(), so the stub provides one).
async function driveMessage(message, jsonBody) {
  let fetched = null;
  const body = jsonBody || {
    id: 7,
    jobs: [{ id: 7, url: "https://cdn/s.m3u8", status: "done", pct: 100 }],
    status: "done", pct: 100, file: "/tmp/x.mp4"
  };
  global.fetch = async (url, opts) => {
    fetched = { url, opts };
    return { ok: true, status: 200, json: async () => body };
  };
  let resp = null;
  const ret = msgCb(message, null, r => { resp = r; });
  await new Promise(r => setTimeout(r, 10));
  return { fetched, resp, ret };
}

async function run() {
  await test("lib exposes every symbol background.js / popup.js reference", () => {
    for (const fn of ["isMediaUrl", "labelUrl", "shortUrl", "buildCommand", "outExt", "shq",
                      "sortMedia", "exportContent", "abdmPayload", "grabberPayload", "isStream"]) {
      assert.strictEqual(typeof global[fn], "function", "missing global: " + fn);
    }
    assert.strictEqual(typeof global.MAX_PER_TAB, "number");
    assert.strictEqual(global.ABDM_ADD_URL, "http://localhost:15151/add");
    assert.strictEqual(global.GRABBER_URL, "http://localhost:15152/grab");
    assert.strictEqual(global.GRABBER_JOBS_URL, "http://localhost:15152/jobs");
    assert.strictEqual(global.GRABBER_STATUS_URL, "http://localhost:15152/status/");
  });

  await test("background.js registers webRequest + message listeners", () => {
    assert.strictEqual(typeof sentCb, "function");
    assert.strictEqual(typeof respCb, "function");
    assert.strictEqual(typeof msgCb, "function");
  });

  await test("background.js: media response detected, labelled, header-tagged, persisted", async () => {
    sentCb({
      tabId: 1,
      url: "https://cdn/s.m3u8",
      requestHeaders: [
        { name: "Referer", value: "https://site/watch" },
        { name: "User-Agent", value: "UA/1.0" }
      ]
    });
    await respCb({
      tabId: 1,
      url: "https://cdn/s.m3u8",
      responseHeaders: [{ name: "Content-Type", value: "application/x-mpegurl" }],
      timeStamp: 1
    });
    const entry = lastSet && lastSet["media_1"] && lastSet["media_1"][0];
    assert.ok(entry, "entry was persisted to storage.session");
    assert.strictEqual(entry.label, "HLS");
    assert.strictEqual(entry.referer, "https://site/watch");
    assert.strictEqual(entry.userAgent, "UA/1.0");
  });

  await test("background.js: non-media response is ignored", async () => {
    lastSet = null;
    await respCb({
      tabId: 2,
      url: "https://cdn/app.js",
      responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
      timeStamp: 2
    });
    assert.strictEqual(lastSet, null, "no persist for non-media");
  });

  await test("background.js: SEND_TO_ABDM POSTs payload to ABDM and reports ok", async () => {
    const { fetched, resp, ret } = await driveMessage({
      type: "SEND_TO_ABDM",
      payload: [{ link: "https://h/v.mp4", headers: { Referer: "https://h/" }, downloadPage: "https://h/" }]
    });
    assert.strictEqual(ret, true);
    assert.strictEqual(fetched.url, "http://localhost:15151/add");
    assert.strictEqual(fetched.opts.method, "POST");
    assert.deepStrictEqual(resp, { ok: true, status: 200 });
  });

  await test("background.js: SEND_TO_GRABBER POSTs to the grabber and returns a job id", async () => {
    const { fetched, resp, ret } = await driveMessage({
      type: "SEND_TO_GRABBER",
      payload: { url: "https://cdn/s.m3u8", referer: "https://site/", userAgent: "UA/1.0", format: "worst", subs: true }
    });
    assert.strictEqual(ret, true);
    assert.strictEqual(fetched.url, "http://localhost:15152/grab");
    assert.strictEqual(fetched.opts.method, "POST");
    const sent = JSON.parse(fetched.opts.body);
    assert.strictEqual(sent.url, "https://cdn/s.m3u8");
    assert.strictEqual(sent.format, "worst");
    assert.strictEqual(sent.subs, true);
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.id, 7);
  });

  await test("background.js: GET_JOBS fetches the job list", async () => {
    const { fetched, resp } = await driveMessage({ type: "GET_JOBS" });
    assert.strictEqual(fetched.url, "http://localhost:15152/jobs");
    assert.ok(Array.isArray(resp.jobs));
    assert.strictEqual(resp.jobs[0].status, "done");
  });

  await test("background.js: GET_JOB_STATUS fetches /status/<id> and passes it through", async () => {
    const { fetched, resp } = await driveMessage({ type: "GET_JOB_STATUS", id: 7 });
    assert.strictEqual(fetched.url, "http://localhost:15152/status/7");
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.status, "done");
    assert.strictEqual(resp.pct, 100);
  });

  await test("popup.js loads + renders an item without reference errors", async () => {
    const el = () => ({
      style: {}, classList: { add() {}, remove() {} },
      addEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
      replaceChildren() {}, focus() {}, select() {}, click() {},
      value: "all", textContent: "", title: "", onclick: null, onchange: null,
      checked: false, disabled: false, innerHTML: "", href: "", download: "", dataset: {}
    });
    global.document = {
      getElementById: el, createElement: el, createDocumentFragment: el,
      body: { appendChild() {}, removeChild() {} }
    };
    global.navigator = { clipboard: { writeText: async () => {} } };
    global.setInterval = () => 0;  // don't actually start the downloads poller
    global.browser = {
      tabs: { query: async () => [{ id: 1 }], create() {} },
      runtime: {
        sendMessage: async () => ({
          urls: [{ url: "https://cdn/s.m3u8", label: "HLS", contentType: "application/x-mpegurl", referer: "https://site/", userAgent: "UA/1.0" }]
        })
      },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    };
    asyncErr = null;
    load("popup.js");
    await new Promise(r => setTimeout(r, 30)); // let async init() settle
    assert.strictEqual(asyncErr, null, asyncErr && asyncErr.message);
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

run();
