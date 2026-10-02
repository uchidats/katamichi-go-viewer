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
const listFilters = ["departure", "arrival", "rentalDay", "excludedModel", "route"];
let savedFilters = loadFilterSettings();
let restoringFilters = false;
const FILTER_PANEL_STORAGE_KEY = "katamichi-go-viewer.filtersCollapsed.v1";
let filtersCollapsed = false;
const HIDDEN_VEHICLES_STORAGE_KEY = "katamichi-go-viewer.hiddenVehicles.v1";
let hiddenVehicles = loadHiddenVehicles();
const showHiddenVehicles = document.querySelector("#show-hidden-vehicles");
showHiddenVehicles.checked = false;
showHiddenVehicles.addEventListener("change", render);
document.querySelector("#clear-hidden-vehicles").addEventListener("click", () => {
  hiddenVehicles = [];
  saveHiddenVehicles("非表示設定をすべて解除しました。");
  render();
});

function loadHiddenVehicles(fallback = []) {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_VEHICLES_STORAGE_KEY));
    return Array.isArray(stored) ? stored.filter(entry => entry
      && typeof entry.vehicleKey === "string" && entry.vehicleKey
      && parseDate(entry.startDate) && parseDate(entry.endDate)) : [];
  } catch {
    return fallback;
  }
}

function hiddenVehicleEntry(vehicle) {
  if (![vehicle.car, vehicle.startStore, vehicle.returnStore].every(value => displayText(value, ""))
    || !parseDate(vehicle.startDate) || !parseDate(vehicle.endDate)) return null;
  return {
    vehicleKey: JSON.stringify([vehicle.car, vehicle.startStore, vehicle.returnStore]),
    startDate: vehicle.startDate,
    endDate: vehicle.endDate,
  };
}

function sameHiddenVehicle(a, b) {
  return a && b && a.vehicleKey === b.vehicleKey && a.startDate === b.startDate && a.endDate === b.endDate;
}

function isHiddenVehicle(vehicle) {
  const entry = hiddenVehicleEntry(vehicle);
  return hiddenVehicles.some(saved => sameHiddenVehicle(saved, entry));
}

function saveHiddenVehicles(message) {
  try {
    if (hiddenVehicles.length) localStorage.setItem(HIDDEN_VEHICLES_STORAGE_KEY, JSON.stringify(hiddenVehicles));
    else localStorage.removeItem(HIDDEN_VEHICLES_STORAGE_KEY);
  } catch {
    message = "非表示設定を保存できませんでした。このページ内でのみ適用されます。";
  }
  document.querySelector("#hidden-vehicle-message").textContent = message;
}

function toggleHiddenVehicle(vehicle) {
  const entry = hiddenVehicleEntry(vehicle);
  if (!entry) return;
  const hidden = isHiddenVehicle(vehicle);
  hiddenVehicles = hiddenVehicles.filter(saved => !sameHiddenVehicle(saved, entry));
  if (!hidden) hiddenVehicles.push(entry);
  saveHiddenVehicles(hidden ? "非表示を解除しました。" : "この期間の案件を非表示にしました。「非表示にした車両を表示」から解除できます。");
  render();
}

function applyFilterPanelState() {
  document.querySelector("#filter-content").hidden = filtersCollapsed;
  document.querySelector("#filter-toggle").setAttribute("aria-expanded", String(!filtersCollapsed));
}

function restoreFilterPanelState() {
  try {
    filtersCollapsed = localStorage.getItem(FILTER_PANEL_STORAGE_KEY) === "true";
  } catch {
    // 保存できない環境でも、このページ内での開閉は利用できます。
  }
  applyFilterPanelState();
}

// フィルター設定とは別に表示状態だけを保存し、チェック値には触れません。
restoreFilterPanelState();
document.querySelector("#filter-toggle").addEventListener("click", () => {
  filtersCollapsed = !filtersCollapsed;
  applyFilterPanelState();
  try {
    localStorage.setItem(FILTER_PANEL_STORAGE_KEY, String(filtersCollapsed));
  } catch {
    // ストレージの利用制限があっても開閉操作は継続します。
  }
});

function loadFilterSettings(fallback = {}) {
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
    return fallback;
  }
}

function readFilters() {
  const data = new FormData(form);
  const filters = {};
  for (const name of booleanFilters) filters[name] = data.has(name);
  for (const name of listFilters) filters[name] = data.getAll(name);
  // 区間候補が他の条件で消えても、保存された選択を維持します。
  filters.route = [...(savedFilters.route || [])];
  return filters;
}

function restoreCheckbox(input) {
  input.checked = !input.disabled && (booleanFilters.includes(input.name)
    ? savedFilters[input.name] === true
    : Array.isArray(savedFilters[input.name]) && savedFilters[input.name].includes(input.value));
}

function restoreFilterSettings() {
  // ブラウザのフォーム復元やAPIによる選択肢追加の後も、保存設定を正とします。
  // 復元ではlocalStorageに書き込まず、初期値による上書きを防ぎます。
  restoringFilters = true;
  try {
    for (const input of [...form.querySelectorAll('input[type="checkbox"]'),
      ...document.querySelector("#route-options").querySelectorAll("input")]) restoreCheckbox(input);
  } finally {
    restoringFilters = false;
  }
}

function saveFilterSettings() {
  if (restoringFilters) return;
  const filters = readFilters();
  filters.route = [...(savedFilters.route || [])];
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
    && !filters.excludedModel.some(model => displayText(vehicle.car, "").normalize("NFKC").includes(model));
}

function companyLabel(value) {
  const name = displayText(value, "").normalize("NFKC").trim();
  if (!name) return "";
  if (name.includes("トヨタモビリティサービス")) return "関東";
  if (/トヨタS[&＆]Dレンタシェア西東京/.test(name)) return "西東京";
  if (name.includes("静岡トヨタ自動車")) return "静岡トヨタ";
  return name.replace(/株式会社|\(株\)|トヨタレンタリース/g, "").trim();
}

function storeCompanyLabel(store) {
  // 現行APIは「運営会社 店舗名 （所在地）」の形式です。
  const name = displayText(store, "").normalize("NFKC").trim();
  if (!/トヨタレンタリース|トヨタモビリティサービス|トヨタS[&＆]Dレンタシェア西東京|静岡トヨタ自動車/.test(name)) return "";
  return companyLabel(name.replace(/株式会社|\(株\)/g, "").trim().split(/\s+/)[0]);
}

function vehicleRoutes(vehicle) {
  const start = companyLabel(vehicle.startCompanyName ?? vehicle.startCompany)
    || storeCompanyLabel(vehicle.startStore);
  const routes = new Set();
  if (!start || !Array.isArray(vehicle.returnCandidates)) return routes;
  for (const candidate of vehicle.returnCandidates) {
    if (!candidate || (typeof candidate !== "string" && typeof candidate !== "object")) continue;
    const end = companyLabel(candidate.companyName ?? candidate.company)
      || storeCompanyLabel(typeof candidate === "string" ? candidate : candidate.name ?? candidate.storeName)
      || companyLabel(vehicle.returnCompanyName ?? vehicle.returnCompany)
      || storeCompanyLabel(vehicle.returnStore);
    if (end) routes.add(JSON.stringify([start, end].sort((a, b) => a.localeCompare(b, "ja"))));
  }
  return routes;
}

function renderRouteOptions(baseVehicles, selected) {
  const counts = new Map();
  for (const vehicle of baseVehicles) {
    for (const route of vehicleRoutes(vehicle)) counts.set(route, (counts.get(route) || 0) + 1);
  }
  // 現在0台の選択も解除できるよう表示します。
  for (const route of selected) if (!counts.has(route)) counts.set(route, 0);
  const options = [];
  for (const [route, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))) {
    let labels;
    try { labels = JSON.parse(route); } catch { continue; }
    if (!Array.isArray(labels) || labels.length !== 2 || !labels.every(label => typeof label === "string")) continue;
    const label = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.name = "route";
    input.value = route;
    input.setAttribute("form", "filter-form");
    input.checked = selected.includes(route);
    label.append(input, element("span", "route-name", labels.join(" ↔ ")), element("span", "route-count", `${count}台`));
    options.push(label);
  }
  document.querySelector("#route-options").replaceChildren(...options);
  document.querySelector("#route-empty").hidden = options.length > 0;
  document.querySelector("#route-filter").hidden = false;
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
  const hidden = isHiddenVehicle(vehicle);
  const card = element("article", `vehicle-card${available ? "" : " unavailable"}${hidden ? " hidden-vehicle" : ""}`);
  const heading = element("div", "card-top");
  heading.append(element("h3", "", displayText(vehicle.car, "車種不明")), element("span", "status", available ? "● 利用可能" : "利用不可"));
  if (hidden) heading.append(element("span", "hidden-vehicle-badge", "この期間は非表示に設定済み"));
  const route = element("dl", "route");
  [["出発", vehicle.startStore, vehicle.startRegion], ["返却", vehicle.returnStore, vehicle.returnRegion]].forEach(([label, store, region]) => {
    const detail = element("dd", "", displayText(store));
    if (label === "出発" && displayText(store, "")) {
      const name = displayText(store);
      const prefecture = displayText(vehicle.startPrefecture, "");
      const address = displayText(vehicle.startAddress, "");
      const query = (address ? [name, prefecture, address] : ["トヨタレンタカー", name, prefecture])
        .filter(Boolean).join(" ");
      const link = element("a", "departure-store-link", name);
      link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${name}をGoogle Mapsで検索（新しいタブ）`);
      detail.replaceChildren(link);
    }
    detail.append(element("span", "", displayText(region, "地域不明")));
    if (label === "返却" && Array.isArray(vehicle.returnCandidates)) {
      const candidates = vehicle.returnCandidates
        .map(candidate => ({
          name: displayText(typeof candidate === "string" ? candidate : candidate?.name ?? candidate?.storeName, ""),
          prefecture: displayText(candidate?.prefecture, ""),
          address: displayText(candidate?.address, ""),
        }))
        .filter(candidate => candidate.name);
      if (candidates.length > 0) {
        // detailsの開閉はカード内で完結し、フィルターや保存設定には触れません。
        const disclosure = element("details", "return-candidates");
        const summary = element("summary", "return-candidates-toggle");
        const arrow = element("span", "filter-arrow", "▾");
        arrow.setAttribute("aria-hidden", "true");
        summary.append(document.createTextNode("返却可能店舗を見る"), arrow);
        const list = element("ul", "return-candidates-list");
        candidates.forEach(({ name, prefecture, address }) => {
          const query = (address ? [name, prefecture, address] : ["トヨタレンタカー", name, prefecture])
            .filter(Boolean).join(" ");
          const link = element("a", "return-candidate-link", name);
          link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.setAttribute("aria-label", `${name}をGoogle Mapsで検索（新しいタブ）`);
          const item = element("li");
          item.append(link);
          list.append(item);
        });
        disclosure.append(summary, list);
        detail.append(disclosure);
      }
    }
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
  const hideButton = element("button", "text-button hide-vehicle-button", hidden ? "非表示を解除" : "この期間は表示しない");
  hideButton.type = "button";
  hideButton.disabled = !hiddenVehicleEntry(vehicle);
  if (hideButton.disabled) hideButton.title = "店舗・利用期間の情報が不足しているため非表示にできません";
  hideButton.addEventListener("click", () => toggleHiddenVehicle(vehicle));
  actions.append(hideButton);
  card.append(heading, route, period, details, actions);
  return card;
}

function render() {
  if (loadState !== "ready") return;
  const filters = readFilters();
  const baseVehicles = vehicles.filter(vehicle => matchesVehicle(vehicle, filters)
    && (showHiddenVehicles.checked || !isHiddenVehicle(vehicle)));
  renderRouteOptions(baseVehicles, filters.route);
  const matches = baseVehicles.filter(vehicle => !filters.route.length
    || filters.route.some(route => vehicleRoutes(vehicle).has(route)));
  document.querySelector("#vehicle-list").replaceChildren(...matches.map(createCard));
  document.querySelector("#result-count").replaceChildren(document.createTextNode("該当件数 "), element("strong", "", String(matches.length)), document.createTextNode(`件 / 全${total}件`));
  document.querySelector("#empty-state").hidden = matches.length > 0;
}

async function loadVehicles() {
  if (loadState === "fetching") return;
  loadState = "fetching";
  document.querySelector("#route-filter").hidden = true;
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
    restoreFilterSettings();
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
  savedFilters = {};
  restoreFilterSettings();
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
createOptions("excluded-model-options", "excludedModel", excludedModels);
restoreFilterSettings();
function handleFilterChange(event) {
  if (restoringFilters || event.target.type !== "checkbox") return;
  // 変更された項目だけを反映し、他の項目のブラウザ復元状態で保存値を上書きしません。
  const input = event.target;
  if (booleanFilters.includes(input.name)) {
    savedFilters[input.name] = input.checked;
  } else if (listFilters.includes(input.name)) {
    const values = new Set(savedFilters[input.name] || []);
    if (input.checked) values.add(input.value);
    else values.delete(input.value);
    savedFilters[input.name] = [...values];
  } else {
    return;
  }
  restoreFilterSettings();
  saveFilterSettings();
  render();
}
form.addEventListener("change", handleFilterChange);
document.querySelector("#route-options").addEventListener("change", handleFilterChange);
form.addEventListener("submit", event => event.preventDefault());
document.querySelector("#reset-filters").addEventListener("click", resetFilters);
document.querySelector("#empty-reset").addEventListener("click", () => {
  savedFilters = {};
  restoreFilterSettings();
  saveFilterSettings();
  render();
});
document.querySelector("#recommended").addEventListener("click", () => {
  form.reset();
  savedFilters = {};
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = ["availableOnly", "relatedRegions", "excludedModel"].includes(input.name)
      || (input.name === "rentalDay" && ["土", "日", "祝"].includes(input.value));
  }
  saveFilterSettings();
  render();
});
document.querySelector("#retry-load").addEventListener("click", loadVehicles);
// pull-to-refresh、F5、履歴キャッシュからの復帰でブラウザがフォーム状態を
// 再適用した後に復元します。APIの完了順序に関係なく、保存値を上書きしません。
window.addEventListener("pageshow", () => {
  hiddenVehicles = loadHiddenVehicles(hiddenVehicles);
  restoreFilterPanelState();
  savedFilters = loadFilterSettings(savedFilters);
  restoreFilterSettings();
  render();
});
loadVehicles();
