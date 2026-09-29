"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbytfWmh6uiUGee3jvOU4Cl-xv4SxQI-iHm34gkO2wjtvhVhj_lwNhzXwxBfoMrDglBu/exec";
let vehicles = [];
let total = 0;
let loadState = "loading";

const regions = ["北海道", "東北", "関東", "中部", "近畿", "中国・四国", "九州・沖縄"];
const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
// 内閣府公表の国民の祝日・休日（振替休日・国民の休日を含む）。
// https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
// 2026-09-30確認。2028年以降は内閣府の公表後に追記してください。
const japaneseHolidays = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
  "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
  "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
  "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21",
  "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11",
  "2027-11-03", "2027-11-23",
]);
const excludedModels = ["アルファード", "ハイエース", "ヴォクシー"];
const form = document.querySelector("#filter-form");
const FILTER_STORAGE_KEY = "katamichi-go-viewer.filters.v1";
const booleanFilters = ["availableOnly", "relatedRegions", "includesDayOff"];
const listFilters = ["departure", "arrival", "rentalDay", "returnDay", "excludedModel"];
let savedFilters = loadFilterSettings();

function loadFilterSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const settings = {};
    for (const name of booleanFilters) settings[name] = stored[name] === true;
    for (const name of listFilters) {
      settings[name] = Array.isArray(stored[name]) ? stored[name].filter(value => typeof value === "string") : [];
    }
    return settings;
  } catch {
    // 保存データの破損やストレージの利用制限があっても通常表示を続けます。
    return {};
  }
}

function readFilters() {
  const data = new FormData(form);
  const filters = {};
  for (const name of booleanFilters) filters[name] = data.has(name);
  for (const name of listFilters) filters[name] = data.getAll(name);
  return filters;
}

function restoreCheckbox(input) {
  input.checked = !input.disabled && (booleanFilters.includes(input.name)
    ? savedFilters[input.name] === true
    : Array.isArray(savedFilters[input.name]) && savedFilters[input.name].includes(input.value));
}

function saveFilterSettings() {
  const filters = readFilters();
  // APIから後で追加される地域の選択も、読み込み中の変更で失わないようにします。
  for (const name of ["departure", "arrival"]) {
    const visibleValues = new Set(Array.from(form.querySelectorAll(`input[name="${name}"]`), input => input.value));
    filters[name].push(...(savedFilters[name] || []).filter(value => !visibleValues.has(value)));
  }
  savedFilters = filters;
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // 保存できない環境でも、このページでの絞り込みは継続します。
  }
}

function createOptions(containerId, name, values) {
  const container = document.getElementById(containerId);
  values.forEach(value => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = value;
    if (value === "祝") {
      input.setAttribute("aria-describedby", "holiday-note");
    }
    restoreCheckbox(input);
    label.append(input, document.createTextNode(value));
    container.append(label);
  });
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function matchesDay(value, selectedDays) {
  const date = parseDate(value);
  return selectedDays.length === 0 || (date !== null && (
    selectedDays.includes(weekdays[date.getUTCDay()])
    || (selectedDays.includes("祝") && japaneseHolidays.has(value))
  ));
}

function isTrue(value) {
  return value === true || value === 1 || value === "true";
}

function matchesVehicle(vehicle, filters) {
  return (!filters.availableOnly || isTrue(vehicle.available))
    && (!filters.relatedRegions || [vehicle.startRegion, vehicle.returnRegion].some(region => ["関東", "東北"].includes(region)))
    && (!filters.includesDayOff || [vehicle.includesSaturday, vehicle.includesSunday, vehicle.includesHoliday].some(isTrue))
    && (!filters.departure.length || filters.departure.includes(vehicle.startRegion))
    && (!filters.arrival.length || filters.arrival.includes(vehicle.returnRegion))
    && matchesDay(vehicle.startDate, filters.rentalDay)
    && matchesDay(vehicle.endDate, filters.returnDay)
    && !filters.excludedModel.some(model => displayText(vehicle.car, "").normalize("NFKC").includes(model));
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}（${weekdays[date.getUTCDay()]}）` : "日付不明";
}

function displayText(value, fallback = "記載なし") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createCard(vehicle) {
  const available = isTrue(vehicle.available);
  const card = element("article", `vehicle-card${available ? "" : " unavailable"}`);
  const heading = element("div", "card-top");
  heading.append(element("h3", "", displayText(vehicle.car, "車種不明")), element("span", "status", available ? "● 利用可能" : "利用不可"));
  const route = element("dl", "route");
  [["出発", vehicle.startStore, vehicle.startRegion], ["返却", vehicle.returnStore, vehicle.returnRegion]].forEach(([label, store, region]) => {
    const detail = element("dd", "", displayText(store));
    detail.append(element("span", "", displayText(region, "地域不明")));
    route.append(element("dt", "", label), detail);
  });
  const period = element("p", "period");
  period.append(element("span", "period-label", "利用期間"));
  if (parseDate(vehicle.startDate) && parseDate(vehicle.endDate)) {
    const start = element("time", "", formatDate(vehicle.startDate));
    start.dateTime = vehicle.startDate;
    const end = element("time", "", formatDate(vehicle.endDate));
    end.dateTime = vehicle.endDate;
    period.append(start, document.createTextNode(" ～ "), end);
  } else {
    period.append(document.createTextNode(displayText(vehicle.period, "期間不明")));
  }
  const details = element("dl", "card-details");
  details.append(element("dt", "", "条件"), element("dd", "", displayText(vehicle.condition)));
  details.append(element("dt", "", "受付状況"), element("dd", "", displayText(vehicle.status, available ? "利用可能" : "利用不可")));
  const phone = displayText(vehicle.phone);
  const phoneDetail = element("dd", "");
  const dial = phone.normalize("NFKC").replace(/[\s()（）-]/g, "");
  if (/^\+?\d{6,15}$/.test(dial)) {
    const link = element("a", "phone-link", phone);
    link.href = `tel:${dial}`;
    phoneDetail.append(link);
  } else {
    phoneDetail.textContent = phone;
  }
  details.append(element("dt", "", "電話番号"), phoneDetail);
  const actions = element("div", "card-actions");
  const sourceUrl = safeSourceUrl(vehicle.sourceUrl);
  if (sourceUrl) {
    const link = element("a", "secondary-button source-link", "元サイトを見る ↗");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${displayText(vehicle.car, "車両")}の元サイトを見る（新しいタブ）`);
    actions.append(link);
  } else {
    actions.append(element("span", "results-note", "元サイトのURLがありません"));
  }
  card.append(heading, route, period, details, actions);
  return card;
}

function render() {
  if (loadState !== "ready") return;
  const filters = readFilters();
  const matches = vehicles.filter(vehicle => matchesVehicle(vehicle, filters));
  document.querySelector("#vehicle-list").replaceChildren(...matches.map(createCard));
  document.querySelector("#result-count").replaceChildren(document.createTextNode("該当件数 "), element("strong", "", String(matches.length)), document.createTextNode(`件 / 全${total}件`));
  document.querySelector("#empty-state").hidden = matches.length > 0;
}

async function loadVehicles() {
  if (loadState === "fetching") return;
  loadState = "fetching";
  const loading = document.querySelector("#loading-state");
  const error = document.querySelector("#error-state");
  loading.hidden = false;
  error.hidden = true;
  document.querySelector("#empty-state").hidden = true;
  document.querySelector("#vehicle-list").replaceChildren();
  document.querySelector("#vehicle-list").setAttribute("aria-busy", "true");
  document.querySelector("#result-count").textContent = "";
  document.querySelector("#updated-at").textContent = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(API_URL, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || data.ok === false || !Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0 || data.items.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("APIの応答形式が正しくありません");
    }
    vehicles = data.items;
    total = data.total;
    // APIに新しい地域が登場した場合も、既存の選択を維持して追加します。
    for (const [containerId, name, key] of [["departure-options", "departure", "startRegion"], ["arrival-options", "arrival", "returnRegion"]]) {
      const existing = new Set(Array.from(document.getElementById(containerId).querySelectorAll("input"), input => input.value));
      const extra = [...new Set(vehicles.map(item => item[key]).filter(region => typeof region === "string" && region && !existing.has(region)))];
      createOptions(containerId, name, extra);
    }
    const updated = typeof data.updatedAt === "string" && data.updatedAt ? new Date(data.updatedAt) : new Date(NaN);
    document.querySelector("#updated-at").textContent = Number.isNaN(updated.getTime())
      ? "最終更新：不明"
      : `最終更新：${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(updated)}（日本時間）`;
    loadState = "ready";
    render();
  } catch (cause) {
    loadState = "error";
    vehicles = [];
    document.querySelector("#error-message").textContent = cause.name === "AbortError"
      ? "通信に時間がかかっています。時間をおいて再度お試しください。"
      : "データを取得できませんでした。通信環境をご確認のうえ、再読み込みしてください。改善しない場合はAPIが一時的に利用できないか、公開設定に問題がある可能性があります。";
    error.hidden = false;
    console.error("車両情報の取得に失敗しました:", cause);
  } finally {
    clearTimeout(timeout);
    loading.hidden = true;
    document.querySelector("#vehicle-list").setAttribute("aria-busy", "false");
  }
}

function resetFilters() {
  form.reset();
  savedFilters = {};
  try {
    localStorage.removeItem(FILTER_STORAGE_KEY);
  } catch {
    // 保存領域にアクセスできない場合も画面の初期化は実行します。
  }
  render();
}

createOptions("departure-options", "departure", regions);
createOptions("arrival-options", "arrival", regions);
createOptions("rental-day-options", "rentalDay", ["月", "火", "水", "木", "金", "土", "日", "祝"]);
createOptions("return-day-options", "returnDay", ["月", "火", "水", "木", "金", "土", "日", "祝"]);
createOptions("excluded-model-options", "excludedModel", excludedModels);
for (const input of form.querySelectorAll('input[type="checkbox"]')) restoreCheckbox(input);
form.addEventListener("change", () => {
  saveFilterSettings();
  render();
});
form.addEventListener("submit", event => event.preventDefault());
document.querySelector("#reset-filters").addEventListener("click", resetFilters);
document.querySelector("#empty-reset").addEventListener("click", resetFilters);
document.querySelector("#recommended").addEventListener("click", () => {
  form.reset();
  savedFilters = {};
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = ["availableOnly", "relatedRegions", "excludedModel"].includes(input.name)
      || (["rentalDay", "returnDay"].includes(input.name) && ["土", "日", "祝"].includes(input.value));
  }
  saveFilterSettings();
  render();
});
document.querySelector("#retry-load").addEventListener("click", loadVehicles);
loadVehicles();
