const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../script.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const storageKey = "katamichi-go-viewer.filters.v1";
const settings = {
  availableOnly: true, relatedRegions: true, includesDayOff: false,
  departure: ["関東"], arrival: ["東北"], rentalDay: ["土", "日", "祝"],
  returnDay: ["土", "日", "祝"], excludedModel: ["アルファード", "ハイエース", "ヴォクシー"],
};
const item = {
  car: "ヤリス", available: true, startRegion: "関東", returnRegion: "東北",
  startDate: "2026-10-10", endDate: "2026-10-12", startStore: "出発店舗", returnStore: "返却店舗",
  condition: "禁煙", phone: "0120-123-456", sourceUrl: "https://example.com/",
};

// A small DOM/storage harness runs the complete application, including its async API flow.
// Browser form restoration is simulated by changing .checked after initial UI creation.
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.checked = false;
    this.disabled = false;
    this.handlers = {};
    this.attributes = {};
    this.text = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll(selector) {
    const name = selector.match(/name="([^"]+)"/);
    const descendants = this.children.flatMap(child => child instanceof Element
      ? [child, ...child.querySelectorAll("*")] : []);
    if (selector === "*") return descendants;
    return descendants.filter(child => child.tag === "input" && (!name || child.name === name[1]));
  }
  reset() { this.querySelectorAll("input").forEach(input => { input.checked = false; }); }
}

function launch(storage = new Map([[storageKey, JSON.stringify(settings)]])) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const form = nodes["filter-form"];
  for (const id of ["departure-options", "arrival-options", "rental-day-options", "return-day-options", "excluded-model-options"]) form.append(nodes[id]);
  for (const match of html.matchAll(/<input type="checkbox" name="([^"]+)"/g)) {
    const input = new Element("input");
    input.name = match[1];
    input.type = "checkbox";
    form.append(input);
  }
  const lifecycle = {};
  const writes = [];
  const removals = [];
  let resolveRequest, rejectRequest;
  const context = {
    document: {
      querySelector: selector => nodes[selector.slice(1)], getElementById: id => nodes[id],
      createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    },
    window: { addEventListener: (type, handler) => { lifecycle[type] = handler; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { writes.push(key); storage.set(key, value); },
      removeItem: key => { removals.push(key); storage.delete(key); },
    },
    FormData: class {
      constructor() { this.inputs = form.querySelectorAll("input").filter(input => input.checked && !input.disabled); }
      has(name) { return this.inputs.some(input => input.name === name); }
      getAll(name) { return this.inputs.filter(input => input.name === name).map(input => input.value); }
    },
    fetch: () => new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }),
    URL, Intl, AbortController, setTimeout: () => 1, clearTimeout() {}, console: { error() {} },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  const app = {
    nodes, storage, writes, removals,
    inputs: () => form.querySelectorAll("input"),
    filters: () => JSON.parse(vm.runInContext("JSON.stringify(readFilters())", context)),
    show: persisted => lifecycle.pageshow({ persisted }),
    change(name, value, checked) {
      const input = app.inputs().find(input => input.name === name && (value === undefined || input.value === value));
      assert.ok(input, `Missing input: ${name}/${value}`);
      input.checked = checked;
      form.handlers.change({ target: input });
    },
    click: id => nodes[id].handlers.click(),
    async respond(items = [item]) {
      resolveRequest({ ok: true, json: async () => ({ items, total: items.length, updatedAt: "2026-09-30T00:00:00Z" }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(nodes["error-state"].hidden, true);
    },
    async fail() {
      rejectRequest(new Error("offline"));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  return app;
}

for (const apiFirst of [false, true]) {
  test(`reload preserves settings with ${apiFirst ? "API" : "pageshow"} completing first`, async () => {
    const app = launch();
    const stored = app.storage.get(storageKey);
    assert.deepEqual(app.filters(), settings);
    if (apiFirst) await app.respond();
    app.inputs().forEach(input => { input.checked = false; });
    app.show(false);
    assert.deepEqual(app.filters(), settings);
    if (!apiFirst) await app.respond();
    assert.deepEqual(app.filters(), settings);
    assert.equal(app.nodes["vehicle-list"].children.length, 1);
    assert.equal(app.storage.get(storageKey), stored);
    assert.deepEqual(app.writes, []);
    assert.deepEqual(app.removals, []);
    const reloaded = launch(app.storage);
    await reloaded.respond();
    reloaded.show(false);
    assert.deepEqual(reloaded.filters(), settings);
  });
}

test("API completion reapplies all checkboxes after late browser form restoration", async () => {
  const app = launch();
  app.show(false);
  app.inputs().forEach(input => { input.checked = false; });
  await app.respond();
  assert.deepEqual(app.filters(), settings);
  assert.deepEqual(app.writes, []);
});

test("history restore reloads current storage without writing it", async () => {
  const app = launch();
  await app.respond();
  const changed = { ...settings, availableOnly: false, rentalDay: ["金"] };
  app.storage.set(storageKey, JSON.stringify(changed));
  app.show(true);
  assert.deepEqual(app.filters(), changed);
  assert.deepEqual(app.writes, []);
});

test("user changes while loading survive late API regions and stale unrelated inputs", async () => {
  const saved = { ...settings, departure: ["追加地域"] };
  const app = launch(new Map([[storageKey, JSON.stringify(saved)]]));
  app.inputs().forEach(input => { input.checked = false; });
  app.change("availableOnly", undefined, false);
  await app.respond([{ ...item, startRegion: "追加地域" }]);
  assert.deepEqual(app.filters(), { ...saved, availableOnly: false });
  assert.deepEqual(JSON.parse(app.storage.get(storageKey)), { ...saved, availableOnly: false });
  app.change("rentalDay", "土", false);
  const reloaded = launch(app.storage);
  await reloaded.respond([{ ...item, startRegion: "追加地域" }]);
  assert.deepEqual(reloaded.filters().rentalDay, ["日", "祝"]);
});

test("only initialization deletes storage, including during a pending API request", async () => {
  const app = launch();
  app.storage.set("unrelated", "keep");
  app.click("empty-reset");
  assert.ok(app.storage.has(storageKey));
  assert.deepEqual(app.removals, []);
  app.click("recommended");
  assert.deepEqual(app.removals, []);
  app.click("reset-filters");
  assert.equal(app.storage.has(storageKey), false);
  await app.respond();
  app.show(false);
  assert.ok(app.inputs().every(input => !input.checked));
  assert.equal(app.storage.has(storageKey), false);
  assert.deepEqual(app.removals, [storageKey]);
  assert.equal(app.storage.get("unrelated"), "keep");
});

test("recommended settings persist without saving API items or metadata", async () => {
  const app = launch();
  app.click("recommended");
  const expected = { ...settings, departure: [], arrival: [] };
  assert.deepEqual(JSON.parse(app.storage.get(storageKey)), expected);
  const reloaded = launch(app.storage);
  await reloaded.respond([item, { ...item, startDate: "2026-10-09" }]);
  assert.deepEqual(reloaded.filters(), expected);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.deepEqual(reloaded.writes, []);
});

test("API errors and retries leave saved filters intact", async () => {
  const app = launch();
  await app.fail();
  app.show(false);
  assert.deepEqual(app.filters(), settings);
  assert.equal(app.nodes["error-state"].hidden, false);
  const retry = app.click("retry-load");
  await app.respond();
  await retry;
  assert.deepEqual(app.filters(), settings);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.removals, []);
});
