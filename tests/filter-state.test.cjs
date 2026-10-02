const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../script.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const storageKey = "katamichi-go-viewer.filters.v1";
const panelStorageKey = "katamichi-go-viewer.filtersCollapsed.v1";
const hiddenStorageKey = "katamichi-go-viewer.hiddenVehicles.v1";
const settings = {
  availableOnly: true, relatedRegions: true, includesDayOff: false,
  departure: ["関東"], arrival: ["東北"], rentalDay: ["土", "日", "祝"],
  excludedModel: ["アルファード", "ハイエース", "ヴォクシー"],
  route: [],
  model: [],
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
  for (const id of ["departure-options", "arrival-options", "rental-day-options", "excluded-model-options"]) form.append(nodes[id]);
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
    inputs: () => [...form.querySelectorAll("input"), ...nodes["route-options"].querySelectorAll("input"),
      ...nodes["model-options"].querySelectorAll("input")],
    filters: () => JSON.parse(vm.runInContext("JSON.stringify(readFilters())", context)),
    show: persisted => lifecycle.pageshow({ persisted }),
    change(name, value, checked) {
      const input = app.inputs().find(input => input.name === name && (value === undefined || input.value === value));
      assert.ok(input, `Missing input: ${name}/${value}`);
      input.checked = checked;
      (["route", "model"].includes(name) ? nodes[`${name}-options`] : form).handlers.change({ target: input });
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

function hideAction(app, index = 0) {
  return app.nodes["vehicle-list"].children[index].querySelectorAll("*")
    .find(node => node.className === "text-button hide-vehicle-button");
}

function showHidden(app, checked) {
  app.nodes["show-hidden-vehicles"].checked = checked;
  app.nodes["show-hidden-vehicles"].handlers.change();
}

function routeOptions(app) {
  return app.nodes["route-options"].children.map(label => ({
    value: label.children[0].value, checked: label.children[0].checked,
    name: label.children[1].textContent, count: label.children[2].textContent,
  }));
}

function modelOptions(app) {
  return app.nodes["model-options"].children.map(label => ({
    value: label.children[0].value, checked: label.children[0].checked,
    name: label.children[1].textContent, count: label.children[2].textContent,
  }));
}

test("model counts normalize only typography and vehicle numbers and preserve order within each priority", async () => {
  const app = launch();
  await app.respond([
    "ルーミー 車両番号1631", "ヤリス 車両番号山形500わ9925", "アクア 宮城502わ6507",
    "ヤリス 4227", "カローラＨＶ 宮城300わ6564", "カローラHV 車両番号 123",
    "ヤリスHV 仙台502わ･368", "ヤリスHEV", "カローラ", "カローラツーリング",
    "　ｱｸｱ　車両番号　3674　", "シエンタ 登録番号9305", "GR86 車両番号 3771",
    "ランドクルーザー 300", "アクア 車両番号 0427",
  ].map(car => ({ ...item, car })));
  assert.deepEqual(modelOptions(app).map(option => [option.name, option.count]), [
    ["GR86", "1台"], ["カローラHV", "2台"], ["ヤリスHV", "1台"], ["ヤリスHEV", "1台"],
    ["ルーミー", "1台"], ["ヤリス", "2台"], ["アクア", "3台"], ["カローラ", "1台"],
    ["カローラツーリング", "1台"], ["シエンタ", "1台"], ["ランドクルーザー 300", "1台"],
  ]);
  assert.equal(app.nodes["vehicle-list"].children[0].children[0].children[0].textContent, "ルーミー 車両番号1631");
});

test("model priority is case insensitive, takes the highest match and keeps natural order within priorities", async () => {
  const app = launch();
  const names = ["ヤリス", "カローラhv", "クラウンスポーツ", "プリウス", "rav4", "アクア",
    "ヤリスクロス hev", "grヤリス", "ルーミー", "カローラハイブリッド", "GR86",
    "クラウンクロスオーバーHEV", "RAV4 Adventure", "プリウスα"];
  await app.respond(names.map(car => ({ ...item, car })));
  const expected = ["クラウンスポーツ", "rav4", "grヤリス", "GR86", "クラウンクロスオーバーHEV",
    "カローラhv", "プリウス", "ヤリスクロス hev", "カローラハイブリッド",
    "ヤリス", "アクア", "ルーミー", "RAV4 Adventure", "プリウスα"];
  assert.deepEqual(modelOptions(app).map(option => option.name), expected);
  assert.ok(modelOptions(app).every(option => option.count === "1台"));
  app.change("model", "grヤリス", true);
  app.change("model", "ヤリスクロス hev", true);
  assert.deepEqual(modelOptions(app).map(option => option.name), expected);
  assert.equal(app.nodes["vehicle-list"].children.length, 2);
  const reloaded = launch(app.storage);
  await reloaded.respond(names.map(car => ({ ...item, car })));
  assert.deepEqual(modelOptions(reloaded), modelOptions(app));
});

test("single and multiple model selections use OR without changing their own counts", async () => {
  const app = launch();
  const fixtures = ["ヤリス 車両番号123", "アクア", "ヤリス 青森501わ3175", "ルーミー"]
    .map(car => ({ ...item, car }));
  await app.respond(fixtures);
  const before = modelOptions(app).map(({ checked, ...option }) => option);
  app.change("model", "ヤリス", true);
  assert.equal(app.nodes["vehicle-list"].children.length, 2);
  assert.deepEqual(modelOptions(app).map(({ checked, ...option }) => option), before);
  app.change("model", "アクア", true);
  assert.equal(app.nodes["vehicle-list"].children.length, 3);
  assert.deepEqual(modelOptions(app).map(({ checked, ...option }) => option), before);
  app.change("model", "ヤリス", false);
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
  app.change("model", "アクア", false);
  assert.equal(app.nodes["vehicle-list"].children.length, 4);
});

test("model selections restore after reload, history and loading changes, and reset normally", async () => {
  const app = launch();
  const fixtures = ["ヤリス", "アクア", "ルーミー"].map(car => ({ ...item, car }));
  await app.respond(fixtures);
  app.change("model", "アクア", true);
  app.change("model", "ルーミー", true);
  const reloaded = launch(app.storage);
  reloaded.change("availableOnly", undefined, false);
  reloaded.show(false);
  await reloaded.respond(fixtures);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 2);
  assert.deepEqual(reloaded.filters().model, ["アクア", "ルーミー"]);
  reloaded.storage.set(storageKey, JSON.stringify({ ...settings, model: ["ヤリス"] }));
  reloaded.inputs().forEach(input => { input.checked = false; });
  reloaded.show(true);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.equal(modelOptions(reloaded).find(option => option.checked).name, "ヤリス");
  reloaded.click("recommended");
  assert.deepEqual(reloaded.filters().model, []);
  reloaded.change("model", "ヤリス", true);
  reloaded.click("empty-reset");
  assert.deepEqual(reloaded.filters().model, []);
  reloaded.change("model", "アクア", true);
  reloaded.click("reset-filters");
  assert.equal(reloaded.storage.has(storageKey), false);
  assert.deepEqual(reloaded.filters().model, []);
});

test("model and route facets exclude only themselves and respect regions, weekdays, exclusions and hidden vehicles", async () => {
  const fixtures = [
    { ...item, car: "ヤリス", startCompany: "トヨタレンタリース青森", returnCandidates: [{ name: "A", company: "トヨタレンタリース岩手" }] },
    { ...item, car: "アクア", startCompany: "トヨタレンタリース青森", returnCandidates: [{ name: "A", company: "トヨタレンタリース岩手" }] },
    { ...item, car: "アクア 車両番号123", available: false, startCompany: "トヨタレンタリース仙台", returnCandidates: [{ name: "B", company: "トヨタレンタリース新福島" }] },
    { ...item, car: "ルーミー", startRegion: "中部" },
    { ...item, car: "カローラ", startDate: "2026-10-09" },
    { ...item, car: "アルファードHV" },
  ];
  const app = launch();
  await app.respond(fixtures);
  assert.deepEqual(modelOptions(app).map(option => [option.name, option.count]), [["ヤリス", "1台"], ["アクア", "1台"]]);
  app.change("availableOnly", undefined, false);
  assert.equal(modelOptions(app).find(option => option.name === "アクア").count, "2台");
  const north = routeOptions(app).find(option => option.name === "青森 ↔ 岩手").value;
  const south = routeOptions(app).find(option => option.name === "仙台 ↔ 新福島").value;
  app.change("model", "ヤリス", true);
  assert.equal(routeOptions(app).length, 1);
  assert.equal(routeOptions(app)[0].count, "1台");
  app.change("route", north, true);
  assert.equal(modelOptions(app).find(option => option.name === "アクア").count, "1台");
  app.change("model", "アクア", true);
  assert.equal(app.nodes["vehicle-list"].children.length, 2);
  app.change("route", south, true);
  assert.equal(app.nodes["vehicle-list"].children.length, 3);
  app.change("model", "ヤリス", false);
  assert.equal(app.nodes["vehicle-list"].children.length, 2);
  assert.equal(routeOptions(app).find(option => option.value === north).count, "1台");
  hideAction(app).handlers.click();
  assert.equal(modelOptions(app).find(option => option.name === "アクア").count, "1台");
  app.change("availableOnly", undefined, true);
  assert.equal(modelOptions(app).find(option => option.name === "アクア").count, "0台");
  assert.equal(app.nodes["vehicle-list"].children.length, 0);
  showHidden(app, true);
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
  app.change("departure", "中部", true);
  app.change("rentalDay", "金", true);
  app.change("excludedModel", "アルファード", false);
  app.change("route", north, false);
  app.change("route", south, false);
  assert.deepEqual(modelOptions(app).map(option => option.name), ["アルファードHV", "ヤリス", "アクア", "ルーミー", "カローラ"]);
});

test("routes display north to south, sort by both endpoints and retain legacy stored keys", async () => {
  const legacyKey = JSON.stringify(["仙台", "新福島"].sort((a, b) => a.localeCompare(b, "ja")));
  const saved = { ...settings, route: [legacyKey] };
  const app = launch(new Map([[storageKey, JSON.stringify(saved)]]));
  const vehicle = (start, end) => ({ ...item, startCompany: `トヨタレンタリース${start}`,
    returnCandidates: [{ name: "返却店", company: `トヨタレンタリース${end}` }] });
  const fixtures = [
    vehicle("新福島", "仙台"), vehicle("岩手", "仙台"),
    vehicle("仙台", "青森"), vehicle("岩手", "青森"),
    vehicle("仙台", "岩手"), vehicle("仙台", "岩手"),
    vehicle("未登録B", "青森"), vehicle("未登録A", "青森"),
  ];
  await app.respond(fixtures);
  assert.deepEqual(routeOptions(app).map(option => [option.name, option.count]), [
    ["青森 ↔ 岩手", "1台"], ["青森 ↔ 仙台", "1台"],
    ["青森 ↔ 未登録A", "1台"], ["青森 ↔ 未登録B", "1台"],
    ["岩手 ↔ 仙台", "3台"], ["仙台 ↔ 新福島", "1台"],
  ]);
  const selected = routeOptions(app).find(option => option.checked);
  assert.equal(selected.name, "仙台 ↔ 新福島");
  assert.equal(selected.value, legacyKey);
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
  assert.deepEqual(app.writes, []);
  app.change("route", legacyKey, false);
  assert.equal(app.nodes["vehicle-list"].children.length, fixtures.length);
  app.change("route", legacyKey, true);
  assert.deepEqual(JSON.parse(app.storage.get(storageKey)).route, [legacyKey]);
  const reloaded = launch(app.storage);
  await reloaded.respond([...fixtures].reverse());
  assert.deepEqual(routeOptions(reloaded), routeOptions(app));
});

test("routes normalize company names, ignore direction and count each vehicle once per route", async () => {
  const app = launch();
  await app.respond([
    { ...item, startCompanyName: "(株)トヨタレンタリース山形", returnCandidates: [
      { name: "A店", companyName: "（株）トヨタレンタリース宮城" },
      { name: "B店", companyName: "株式会社トヨタレンタリース宮城" },
      { name: "C店", companyName: "(株)トヨタレンタリース新福島" },
    ] },
    { ...item, startStore: "トヨタレンタリース宮城 出発店 （宮城県）",
      returnStore: "トヨタレンタリース山形 返却可能店舗 （下記参照）", returnCandidates: [{ name: "返却店" }] },
    { ...item, startCompanyName: "トヨタモビリティサービス株式会社", returnCandidates: [
      { name: "D店", companyName: "トヨタS＆Dレンタシェア西東京(株)　" },
      { name: "E店", companyName: "静岡トヨタ自動車(株)　" },
      { name: "F店", companyName: "(株)トヨタレンタリース岩手" },
    ] },
    { ...item, returnCandidates: null },
  ]);
  const options = routeOptions(app);
  assert.equal(options.length, 5);
  assert.equal(options.find(option => option.name.includes("山形") && option.name.includes("宮城")).count, "2台");
  for (const name of ["新福島", "関東", "西東京", "静岡トヨタ", "岩手"]) {
    assert.ok(options.some(option => option.name.includes(name)), name);
  }
});

test("route selections use OR, keep counts stable and survive reload and other filters", async () => {
  const fixtures = [
    { ...item, car: "ヤリスA", startCompany: "(株)トヨタレンタリース山形", returnCandidates: [
      { name: "A", company: "(株)トヨタレンタリース宮城" },
      { name: "B", company: "(株)トヨタレンタリース岩手" },
    ] },
    { ...item, car: "ヤリスB", available: false, startCompany: "(株)トヨタレンタリース新福島", returnCandidates: [
      { name: "C", company: "(株)トヨタレンタリース宮城" },
    ] },
  ];
  const app = launch();
  await app.respond(fixtures);
  assert.equal(routeOptions(app).length, 2);
  app.change("availableOnly", undefined, false);
  const before = routeOptions(app);
  const first = before.find(option => option.name.includes("岩手")).value;
  const second = before.find(option => option.name.includes("新福島")).value;
  app.change("route", first, true);
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
  assert.deepEqual(routeOptions(app).map(({ checked, ...option }) => option), before.map(({ checked, ...option }) => option));
  app.change("route", second, true);
  assert.equal(app.nodes["vehicle-list"].children.length, 2);
  const reloaded = launch(app.storage);
  await reloaded.respond(fixtures);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 2);
  assert.deepEqual(reloaded.filters().route, [first, second]);
  reloaded.change("availableOnly", undefined, true);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.equal(routeOptions(reloaded).find(option => option.value === second).count, "0台");
  reloaded.change("route", first, false);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 0);
  reloaded.change("route", second, false);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  reloaded.click("reset-filters");
  assert.deepEqual(reloaded.filters().route, []);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 2);
});

test("hidden periods persist, can be reviewed and individually restored without changing filters", async () => {
  const app = launch();
  await app.respond();
  const filtersBefore = app.storage.get(storageKey);
  hideAction(app).handlers.click();
  assert.equal(app.nodes["vehicle-list"].children.length, 0);
  assert.equal(app.nodes["empty-state"].hidden, false);
  assert.deepEqual(JSON.parse(app.storage.get(hiddenStorageKey)), [{
    vehicleKey: JSON.stringify([item.car, item.startStore, item.returnStore]),
    startDate: item.startDate, endDate: item.endDate,
  }]);
  const reloaded = launch(app.storage);
  await reloaded.respond();
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 0);
  showHidden(reloaded, true);
  assert.match(reloaded.nodes["vehicle-list"].children[0].className, /hidden-vehicle/);
  assert.equal(hideAction(reloaded).textContent, "非表示を解除");
  hideAction(reloaded).handlers.click();
  showHidden(reloaded, false);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.equal(reloaded.storage.has(hiddenStorageKey), false);
  assert.equal(reloaded.storage.get(storageKey), filtersBefore);
});

test("changing either date or any identity field makes a hidden vehicle visible again", async () => {
  const app = launch(new Map());
  await app.respond();
  hideAction(app).handlers.click();
  const changed = [
    { ...item, startDate: "2026-10-11" }, { ...item, endDate: "2026-10-17" },
    { ...item, car: "別の車両" }, { ...item, startStore: "別の出発店舗" },
    { ...item, returnStore: "別の返却店舗" },
  ];
  const reloaded = launch(app.storage);
  await reloaded.respond([item, ...changed]);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, changed.length);
  showHidden(reloaded, true);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, changed.length + 1);
});

test("clear all removes only hidden settings and filter resets keep hidden periods", async () => {
  const app = launch();
  await app.respond();
  hideAction(app).handlers.click();
  const hiddenBefore = app.storage.get(hiddenStorageKey);
  app.click("reset-filters");
  assert.equal(app.storage.get(hiddenStorageKey), hiddenBefore);
  assert.equal(app.nodes["vehicle-list"].children.length, 0);
  app.click("recommended");
  const filtersBefore = app.storage.get(storageKey);
  app.storage.set(panelStorageKey, "true");
  app.click("clear-hidden-vehicles");
  assert.equal(app.storage.has(hiddenStorageKey), false);
  assert.equal(app.storage.get(storageKey), filtersBefore);
  assert.equal(app.storage.get(panelStorageKey), "true");
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
});

test("malformed hidden settings and missing dates do not hide unrelated vehicles", async () => {
  for (const stored of ["invalid JSON", "{}", '[null, {"vehicleKey":"x"}]']) {
    const app = launch(new Map([[hiddenStorageKey, stored]]));
    await app.respond([item, { ...item, startDate: null }]);
    assert.equal(app.nodes["vehicle-list"].children.length, 2);
    assert.equal(hideAction(app, 1).disabled, true);
  }
});

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
  await reloaded.respond([{ ...item, endDate: "2026-10-13" }, { ...item, startDate: "2026-10-09" }]);
  assert.deepEqual(reloaded.filters(), expected);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.deepEqual(reloaded.writes, []);
});

test("legacy return weekdays are ignored while rental weekdays and period display remain intact", async () => {
  const legacy = { ...settings, returnDay: ["金"] };
  const app = launch(new Map([[storageKey, JSON.stringify(legacy)]]));
  assert.deepEqual(app.filters(), settings);
  await app.respond([{ ...item, endDate: "2026-10-13" }, { ...item, startDate: "2026-10-09" }]);
  assert.equal(app.nodes["vehicle-list"].children.length, 1);
  const times = app.nodes["vehicle-list"].children[0].querySelectorAll("*").filter(node => node.tag === "time");
  assert.deepEqual(times.map(node => node.textContent), ["2026/10/10（土）", "2026/10/13（火）"]);
  app.change("availableOnly", undefined, false);
  assert.deepEqual(JSON.parse(app.storage.get(storageKey)), { ...settings, availableOnly: false });
  const reloaded = launch(app.storage);
  await reloaded.respond([{ ...item, endDate: "2026-10-13" }]);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
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

test("collapse survives reload and API completion without changing filters or cards", async () => {
  const app = launch();
  assert.equal(app.nodes["filter-content"].hidden, false);
  const stored = app.storage.get(storageKey);
  app.click("filter-toggle");
  assert.equal(app.nodes["filter-content"].hidden, true);
  assert.equal(app.nodes["filter-toggle"].attributes["aria-expanded"], "false");
  assert.equal(app.storage.get(panelStorageKey), "true");
  assert.deepEqual(app.filters(), settings);
  assert.equal(app.storage.get(storageKey), stored);
  assert.deepEqual(app.writes, [panelStorageKey]);

  const reloaded = launch(app.storage);
  assert.equal(reloaded.nodes["filter-content"].hidden, true);
  await reloaded.respond();
  reloaded.show(false);
  assert.equal(reloaded.nodes["filter-content"].hidden, true);
  assert.equal(reloaded.nodes["vehicle-list"].children.length, 1);
  assert.deepEqual(reloaded.filters(), settings);
  reloaded.click("filter-toggle");
  assert.equal(reloaded.nodes["filter-content"].hidden, false);
  assert.equal(reloaded.nodes["filter-toggle"].attributes["aria-expanded"], "true");
  assert.equal(reloaded.storage.get(storageKey), stored);
  assert.equal(launch(reloaded.storage).nodes["filter-content"].hidden, false);
});

test("filter initialization leaves panel preference intact and history restores it", async () => {
  const app = launch();
  app.click("filter-toggle");
  app.click("filter-toggle");
  app.click("reset-filters");
  assert.equal(app.storage.get(panelStorageKey), "false");
  assert.equal(app.storage.has(storageKey), false);
  app.storage.set(panelStorageKey, "true");
  app.show(true);
  assert.equal(app.nodes["filter-content"].hidden, true);
  await app.respond();
  assert.ok(app.inputs().every(input => !input.checked));
  assert.equal(app.storage.has(storageKey), false);
});
