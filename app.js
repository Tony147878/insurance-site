"use strict";

/* ---------- 狀態 ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  meta: null,
  products: [],
  byId: new Map(),
  rates: {},                       // company → {id: tables}
  favs: new Set(store.get("favs", [])),
  cmp: store.get("cmp", []),       // 最多 4 個
  profile: store.get("profile", { age: "", gender: "M", term: "" }),
  q: { showStopped: false, ...store.get("q", { text: "", companies: [], tags: [], contract: "", onlyRates: false, hideClauses: true, sort: "new" }) },
  limit: 60,
  qf: { facets: [], companies: [] },   // 速查條件（送出後套用到查詢結果）
  qsel: { facets: new Set(), companies: new Set() },  // 速查卡片上正在選的
};
const MAX_CMP = 4;
const TAGS = ["實支實付", "住院日額", "手術", "癌症", "重大疾病", "重大傷病", "特定傷病", "失能", "長照", "身故", "意外", "門診", "豁免", "滿期/還本", "年金", "投資型", "外溢"];

/* ---------- 速查：分類條件（由名稱／給付項目／分類自動判斷） ---------- */
const has = (re) => (p) => re.test(p._t);
const FACETS = {
  // 險種
  k_health: { label: "醫療健康", test: has(/健康|醫療|癌|重大疾病|重大傷病|特定傷病|長期照顧|長照|手術|住院/) },
  k_accident: { label: "傷害", test: has(/傷害|意外/) },
  k_life: { label: "壽險", test: (p) => /壽險|終身保險|定期保險|養老|還本/.test(p.name) && !/健康|醫療|傷害/.test(p.name) },
  k_annuity: { label: "年金", test: (p) => /年金/.test(p.name) },
  k_invest: { label: "投資型", test: (p) => /變額|萬能|投資型/.test(p.name) },
  // 期間
  t_1y: { label: "一年期", test: (p) => /一年|1年期|１年/.test(p.name) || /^1\s*年/.test(p.pay_period) },
  t_term: { label: "定期", test: (p) => /定期/.test(p.name) && !/一年/.test(p.name) },
  t_life: { label: "終身", test: (p) => /終身/.test(p.name) },
  // 主附約
  c_main: { label: "主約", test: (p) => !/附約|附加條款|批註/.test(p.contract + p.name) },
  c_rider: { label: "附約", test: (p) => /附約/.test(p.contract + p.name) },
  // 實支實付
  d_yes: { label: "有自負額", test: has(/自負額/) },
  d_no: { label: "無自負額", test: (p) => /實支|實際支出|醫療費用/.test(p._t) && !/自負額/.test(p._t) },
  // 保障
  b_reimb: { label: "實支實付", test: (p) => p.tags.includes("實支實付") },
  b_deduct: { label: "自負額", test: has(/自負額/) },
  b_either: { label: "日額實支擇一", test: has(/擇一|擇優|較優|日額給付型.*實支|實支.*日額給付型/) },
  b_hosp: { label: "住院", test: has(/住院/) },
  b_daily: { label: "日額", test: has(/日額/) },
  b_surgery: { label: "手術", test: (p) => p.tags.includes("手術") },
  b_cancer: { label: "癌症", test: (p) => p.tags.includes("癌症") },
  b_lump: { label: "一次金", test: has(/一次金|一筆|整筆|一次給付|一次保險金/) },
  b_ci: { label: "重大疾病", test: (p) => p.tags.includes("重大疾病") },
  b_cii: { label: "重大傷病", test: (p) => p.tags.includes("重大傷病") },
  b_si: { label: "特定傷病", test: (p) => p.tags.includes("特定傷病") },
  b_ltc: { label: "長照", test: (p) => p.tags.includes("長照") },
  // 只算以失能為主要保障的商品（壽險附帶的「完全失能保險金」、失能豁免不算）
  b_dis: { label: "失能", test: (p) => /失能/.test(p.name) || /失能(扶助|照護|生活|關懷|安養|年金|分期|照顧|補償)/.test(p._t) },
  b_waiver: { label: "豁免", test: (p) => p.tags.includes("豁免") },
  b_mom: { label: "婦嬰", test: has(/婦女|女性|嬰|孕|產婦|分娩|妊娠|媽咪|新生兒|母嬰/) },
  b_dental: { label: "牙齒", test: has(/牙/) },
  b_abroad: { label: "海外醫療", test: has(/海外|國外|突發疾病/) },
  b_acc: { label: "傷害險", test: (p) => /傷害保險|傷害險|意外/.test(p.name) },
  b_travel: { label: "旅平險", test: (p) => /旅行|旅平|旅遊/.test(p.name) },
  b_disins: { label: "失能險", test: (p) => /失能/.test(p.name) },
  b_accmed: { label: "傷害醫療", test: has(/傷害醫療|意外醫療/) },
  b_spill: { label: "外溢", test: (p) => p.tags.includes("外溢") },
  b_death: { label: "身故", test: (p) => p.tags.includes("身故") },
};
// 幣別（依名稱與幣別欄位判斷）
const curOf = (p) => {
  const t = `${p.name} ${p.currency || ""}`;
  if (/美元|美金|USD/.test(t)) return "美元";
  if (/澳幣|澳元|AUD/.test(t)) return "澳幣";
  if (/人民幣|CNY/.test(t)) return "人民幣";
  if (/日圓|日幣|JPY|歐元|EUR|外幣|foreign/.test(t)) return "外幣";
  return "新台幣";
};
Object.assign(FACETS, {
  m_twd: { label: "新台幣", test: (p) => p._cur === "新台幣" },
  m_usd: { label: "美元", test: (p) => p._cur === "美元" },
  m_aud: { label: "澳幣", test: (p) => p._cur === "澳幣" },
  m_cny: { label: "人民幣", test: (p) => p._cur === "人民幣" },
  m_other: { label: "其他外幣", test: (p) => p._cur === "外幣" },
  m_fx: { label: "外幣保單", test: (p) => p._cur !== "新台幣" },
});

const QF_GROUPS = [
  ["險種", ["k_health", "k_accident", "k_life", "k_annuity", "k_invest"]],
  ["期間", ["t_1y", "t_term", "t_life"]],
  ["主約／附約", ["c_main", "c_rider"]],
  ["實支實付", ["d_yes", "d_no"]],
  ["幣別", ["m_twd", "m_usd", "m_aud", "m_cny", "m_other"]],
];
const QF_COVER = ["b_reimb", "b_deduct", "b_either", "b_hosp", "b_daily", "b_surgery", "b_cancer", "b_lump", "b_ci", "b_cii", "b_si", "b_ltc",
  "b_dis", "b_waiver", "b_mom", "b_dental", "b_abroad", "b_acc", "b_travel", "b_disins", "b_accmed", "b_spill", "b_death"];
const HOT = [["實支實付", ["b_reimb"]], ["癌症一次金", ["b_cancer", "b_lump"]], ["重大傷病", ["b_cii"]], ["長照", ["b_ltc"]], ["失能", ["b_dis"]], ["住院日額", ["b_hosp", "b_daily"]], ["外幣保單", ["m_fx"]], ["美元保單", ["m_usd"]]];
const groupOf = (id) => (QF_GROUPS.find(([, ids]) => ids.includes(id)) || [null])[0];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("zh-TW") : n);
const short = (p) => S.meta.companies[p.company]?.short || p.company;
const mmdd = (iso) => (iso ? iso.slice(5).replace("-", "-") : "");
const ym = (iso) => (iso ? iso.slice(0, 7).replace("-", "/") : "");
const unitOf = (p) => (p._cur === "新台幣" ? "元" : p._cur === "外幣" ? "（外幣）" : " " + p._cur);
const isClause = (p) => /批註|附加條款/.test(p.contract + p.name);

const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.3C1 8 3.4 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.6 0 6 3.5 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ---------- 資料 ---------- */
async function load() {
  const res = await fetch("data/products.json", { cache: "no-cache" });
  const d = await res.json();
  S.meta = d.meta;
  S.products = d.products;
  S.products.forEach((p) => {
    S.byId.set(p.id, p);
    p._t = `${p.name} ${p.benefits.join(" ")} ${p.category.join(" ")} ${p.tags.join(" ")} ${p.features.join(" ")}`;
    p._cur = curOf(p);
    p._f = new Set(Object.keys(FACETS).filter((k) => FACETS[k].test(p)));
  });
  S.cmp = S.cmp.filter((id) => S.byId.has(id));
  const active = S.products.filter((p) => p.status !== "停售").length;
  const comps = Object.values(S.meta.companies).filter((c) => c.count > 0).length;
  $("#meta").textContent = `${active.toLocaleString()} 個商品 · ${comps} 家公司 · 資料 ${S.meta.updated.replaceAll("-", "/")} · v${S.meta.version}`;
}

async function ratesFor(p) {
  if (!p.has_rates) return null;
  if (!S.rates[p.company]) {
    S.rates[p.company] = fetch(`data/rates/${p.company}.json`, { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}));
  }
  const all = await S.rates[p.company];
  return all[p.id] || null;
}

/** 依年齡/性別/年期查費率 → [{label, value, unit, page, plan}] */
function lookup(tables, age, gender, term) {
  const out = [];
  if (!tables || age === "" || age == null) return out;
  for (const t of tables) {
    const row = t.rows[String(age)];
    if (!row) continue;
    t.columns.forEach((c, i) => {
      const v = row[i];
      if (v == null) return;
      if (gender && c.gender && c.gender !== gender) return;
      if (term && c.term && c.term !== term) return;
      out.push({ label: c.label, term: c.term, value: v, unit: t.unit, page: t.page });
    });
  }
  return out;
}
function termsOf(tables) {
  const s = new Set();
  (tables || []).forEach((t) => t.columns.forEach((c) => c.term && s.add(c.term)));
  return [...s].sort((a, b) => parseInt(a) - parseInt(b));
}

/* ---------- 篩選 ---------- */
function filtered(base) {
  const q = S.q;
  S.unknownAgeHidden = 0;
  const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const age = S.profile.age === "" ? null : Number(S.profile.age);
  let list = base.filter((p) => {
    if (p.status === "停售" && !q.showStopped && !words.length) return false;
    if (q.hideClauses && isClause(p)) return false;
    if (q.companies.length && !q.companies.includes(p.company)) return false;
    if (q.tags.length && !q.tags.every((t) => p.tags.includes(t))) return false;
    if (q.contract === "主約" && !/主約/.test(p.contract)) return false;
    if (q.contract === "附約" && !/附約/.test(p.contract + p.name)) return false;
    if (q.onlyRates && !p.has_rates) return false;
    if (!matchQf(p, S.qf)) return false;
    if (age != null) {
      if (p.age_min == null) { if (!q.showUnknownAge) { S.unknownAgeHidden++; return false; } }
      else if (age < p.age_min || age > p.age_max) return false;
    }
    if (words.length) {
      const hay = `${p.name} ${p.code} ${short(p)} ${p.tags.join(" ")} ${p.category.join(" ")} ${p.benefits.join(" ")}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  // 有備查日期者依日期新到舊；無日期者排後面
  const key = (p) => p.approval_date || (p.is_new ? p.first_seen : "");
  if (q.sort === "new") list.sort((a, b) => key(b).localeCompare(key(a)));
  if (q.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  if (q.sort === "company") list.sort((a, b) => a.company.localeCompare(b.company) || key(b).localeCompare(key(a)));
  return list;
}

/** 速查條件：同一組（險種／期間…）內為「或」，不同組之間與每個保障項目為「且」；公司為「或」 */
function matchQf(p, qf) {
  if (qf.companies.length && !qf.companies.includes(p.company)) return false;
  const groups = {};
  for (const f of qf.facets) {
    const g = groupOf(f);
    if (g) (groups[g] = groups[g] || []).push(f);
    else if (!p._f.has(f)) return false;
  }
  return Object.values(groups).every((fs) => fs.some((f) => p._f.has(f)));
}
const qfActive = () => S.qf.facets.length || S.qf.companies.length;
function qfLabel() {
  return [...S.qf.facets.map((f) => FACETS[f].label), ...S.qf.companies.map((c) => S.meta.companies[c].short)].join("、");
}

/* ---------- 卡片 ---------- */
function card(p) {
  const tags = [];
  if (p.is_new) tags.push(`<span class="badge new">新 ${esc(mmdd(p.approval_date || p.first_seen))}</span>`);
  if (p.status === "停售") tags.push(`<span class="badge stop">停售${p.removed_on ? " " + esc(p.removed_on.slice(0, 7).replace("-", "/")) : ""}</span>`);
  if (/附約/.test(p.contract + p.name)) tags.push('<span class="badge rider">附約</span>');
  if (p._cur !== "新台幣") tags.push(`<span class="badge fx">${esc(p._cur === "外幣" ? "外幣" : p._cur)}</span>`);
  p.tags.slice(0, 5).forEach((t) => tags.push(`<span class="badge">${esc(t)}</span>`));
  const age = p.age_min != null ? `${p.age_min}–${p.age_max} 歲` : "";
  const sel = S.cmp.includes(p.id);
  return `<article class="card${sel ? " sel" : ""}" data-id="${esc(p.id)}">
    <div class="hd"><span>${esc(short(p))}</span><span class="d">${esc(ym(p.approval_date))}</span>
      <button class="icon-btn fav${S.favs.has(p.id) ? " on" : ""}" aria-label="加入最愛" data-fav="${esc(p.id)}">${ICON_HEART}</button></div>
    <div class="bd"><h3>${esc(p.name.replace(/^(.{2,8}?人壽(保險)?)/, "$1"))}</h3><div class="badges">${tags.join("")}</div></div>
    <div class="prem" data-prem="${esc(p.id)}"></div>
    <button class="cmp-toggle${sel ? " on" : ""}" data-cmp="${esc(p.id)}">${sel ? "✓ 比較中" : "+ 比較"}</button>
    <div class="ft"><span class="code">${esc(p.code)}</span><span>${esc(age)}</span></div>
  </article>`;
}

async function fillPremiums(root) {
  const { age, gender, term } = S.profile;
  if (age === "") return;
  for (const el of root.querySelectorAll("[data-prem]")) {
    const p = S.byId.get(el.dataset.prem);
    if (!p.has_rates) continue;
    const hits = lookup(await ratesFor(p), age, gender, term);
    if (!hits.length) continue;
    const min = hits.reduce((a, b) => (b.value < a.value ? b : a));
    el.innerHTML = `${esc(age)}歲${gender === "M" ? "男" : "女"} <b>${fmt(min.value)}</b>${esc(unitOf(p))}起 <span class="note">${esc(min.term || "")}</span>`;
  }
}

/* ---------- 被保險人（年齡、性別） ---------- */
function whoChip() {
  const pf = S.profile;
  return pf.age === ""
    ? `<button class="who empty" data-who><span class="who-ic">👤</span><span><b>設定被保險人</b><small>只看能保的商品、直接顯示保費</small></span><span class="who-go">›</span></button>`
    : `<button class="who" data-who><span class="who-ic">👤</span><span><b>被保險人：${esc(pf.age)} 歲・${pf.gender === "M" ? "男" : "女"}</b><small>只列出可投保的商品，卡片顯示保費</small></span><span class="who-go">更改</span></button>`;
}

function openWho() {
  const draft = { age: S.profile.age === "" ? 30 : Number(S.profile.age), gender: S.profile.gender || "M" };
  const presets = [0, 5, 10, 18, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];
  const paint = () => {
    $("#sheetBody").innerHTML = `
      <div class="sheet-hd"><h2>被保險人<small>設定後會用在查詢、速查、比較和保費試算</small></h2>
        <button class="icon-btn" id="closeSheet" aria-label="關閉">${ICON_X}</button></div>
      <div class="sheet-bd who-sheet">
        <div class="who-age">
          <button class="who-step" data-step="-1" aria-label="減一歲">−</button>
          <div class="who-num"><input id="whoAge" type="number" min="0" max="100" inputmode="numeric" value="${draft.age}" aria-label="年齡"><span>歲</span></div>
          <button class="who-step" data-step="1" aria-label="加一歲">＋</button>
        </div>
        <div class="who-presets">${presets.map((a) => `<button class="qchip${a === draft.age ? " on" : ""}" data-age="${a}">${a}</button>`).join("")}</div>
        <div class="who-gender">${[["M", "男"], ["F", "女"]].map(([g, l]) => `<button class="qchip${draft.gender === g ? " on" : ""}" data-g="${g}">${l}</button>`).join("")}</div>
        <ul class="who-why">
          <li>只列出這個年齡<b>可以投保</b>的商品</li>
          <li>有費率表的商品，卡片上直接顯示<b>年繳保費</b></li>
          <li>比較時，保費最便宜的會標成綠色</li>
        </ul>
        <div class="row" style="justify-content:flex-end">
          ${S.profile.age !== "" ? '<button class="ghost" id="whoClear">不設定</button>' : ""}
          <button class="primary" id="whoApply">套用</button>
        </div>
      </div>`;
    const dlg = $("#sheet");
    $("#closeSheet").onclick = () => dlg.close();
    $("#whoAge").onchange = (e) => { draft.age = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)); paint(); };
    $("#sheetBody").querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { draft.age = Math.max(0, Math.min(100, draft.age + Number(b.dataset.step))); paint(); }));
    $("#sheetBody").querySelectorAll("[data-age]").forEach((b) => (b.onclick = () => { draft.age = Number(b.dataset.age); paint(); }));
    $("#sheetBody").querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { draft.gender = b.dataset.g; paint(); }));
    const done = () => { store.set("profile", S.profile); dlg.close(); const y = window.scrollY, q = $("#quick"), x = q ? q.scrollLeft : 0; route(); window.scrollTo(0, y); if ($("#quick")) $("#quick").scrollLeft = x; };
    $("#whoApply").onclick = () => { S.profile.age = String(Math.max(0, Math.min(100, parseInt($("#whoAge").value, 10) || draft.age))); S.profile.gender = draft.gender; done(); };
    $("#whoClear")?.addEventListener("click", () => { S.profile.age = ""; done(); });
  };
  paint();
  const dlg = $("#sheet");
  if (!dlg.open) dlg.showModal();
}

/* ---------- 畫面：查詢 / 新商品 / 最愛 ---------- */
function toolbar(showSearch = true, showTerm = false) {
  const q = S.q, pf = S.profile;
  const comps = Object.entries(S.meta.companies).filter(([, c]) => c.count > 0);
  return `<div class="toolbar">
    ${showSearch ? `<div class="search"><input id="qText" type="search" placeholder="搜尋商品名稱、代碼、保障…" value="${esc(q.text)}">
      <button id="toggleF" class="${filterActive() ? "on" : ""}">篩選${filterActive() ? "•" : ""}</button></div>` : ""}
    <div class="row">${whoChip()}${showTerm ? `<select id="pTerm" aria-label="繳費年期"><option value="">全部繳費年期</option>${["1年期", "5年期", "6年期", "10年期", "15年期", "20年期", "30年期"].map((t) => `<option ${pf.term === t ? "selected" : ""}>${t}</option>`).join("")}</select>` : ""}</div>
    <div class="filters" id="filters" hidden>
      <div><h4>公司</h4><div class="wrap">${comps.map(([k, c]) => `<button class="chip${q.companies.includes(k) ? " on" : ""}" data-company="${k}">${esc(c.short)} ${c.count}</button>`).join("")}</div></div>
      <div><h4>保障內容（全部符合）</h4><div class="wrap">${TAGS.map((t) => `<button class="chip${q.tags.includes(t) ? " on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>
      <div class="row"><span class="seg" id="fContract">${["", "主約", "附約"].map((c) => `<button data-c="${c}" class="${q.contract === c ? "on" : ""}">${c || "主附約不拘"}</button>`).join("")}</span>
        <label><input type="checkbox" id="fRates" ${q.onlyRates ? "checked" : ""}> 只看可試算保費</label>
        <label><input type="checkbox" id="fClauses" ${q.hideClauses ? "checked" : ""}> 隱藏批註條款</label>
        <label><input type="checkbox" id="fStopped" ${q.showStopped ? "checked" : ""}> 包含停售商品</label></div>
      <div class="row"><label>排序</label><span class="seg" id="fSort">${[["new", "最新"], ["company", "公司"], ["name", "名稱"]].map(([k, l]) => `<button data-s="${k}" class="${q.sort === k ? "on" : ""}">${l}</button>`).join("")}</span>
        <button class="btn" id="fReset">清除篩選</button></div>
    </div>
  </div>`;
}
const filterActive = () => S.q.companies.length || S.q.tags.length || S.q.contract || S.q.onlyRates || !S.q.hideClauses || S.q.showStopped;

function renderList(base, title) {
  const list = filtered(base);
  const shown = list.slice(0, S.limit);
  $("#view").innerHTML = `${toolbar()}
    ${title ? `<div class="count">${title}</div>` : ""}
    ${qfActive() ? `<div class="qf-bar"><span>速查條件：<b>${esc(qfLabel())}</b></span><button class="btn" id="qfEdit">修改</button><button class="btn" id="qfClear">清除</button></div>` : ""}
    <div class="count">共 ${list.length.toLocaleString()} 筆${S.profile.age !== "" ? `（${esc(S.profile.age)} 歲可投保）` : ""}
      ${S.profile.age !== "" && S.unknownAgeHidden ? `<span class="note">・另有 ${S.unknownAgeHidden} 項官網未標示承保年齡，未列入</span> <button class="btn" id="showUnknown" style="padding:2px 8px;font-size:12px">顯示</button>` : ""}
      ${S.profile.age !== "" && S.q.showUnknownAge ? `<button class="btn" id="hideUnknown" style="padding:2px 8px;font-size:12px">隱藏未標示年齡的商品</button>` : ""}</div>
    ${shown.length ? `<div class="grid" id="grid">${shown.map(card).join("")}</div>` : '<div class="empty">沒有符合條件的商品</div>'}
    ${list.length > S.limit ? '<button class="btn more" id="more">顯示更多</button>' : ""}`;
  bindToolbar(() => renderList(base, title));
  $("#more")?.addEventListener("click", () => { S.limit += 60; renderList(base, title); });
  $("#showUnknown")?.addEventListener("click", () => { S.q.showUnknownAge = true; store.set("q", S.q); renderList(base, title); });
  $("#hideUnknown")?.addEventListener("click", () => { S.q.showUnknownAge = false; store.set("q", S.q); renderList(base, title); });
  $("#qfClear")?.addEventListener("click", () => { S.qf = { facets: [], companies: [] }; renderList(base, title); });
  $("#qfEdit")?.addEventListener("click", () => { location.hash = "#quick"; });
  fillPremiums($("#view"));
}

function bindToolbar(rerender) {
  const save = () => { store.set("q", S.q); store.set("profile", S.profile); S.limit = 60; rerender(); };
  const qt = $("#qText");
  if (qt) {
    let t;
    qt.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.q.text = qt.value; save(); const el = $("#qText"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); });
  }
  const f = $("#filters");
  if (f && sessionStorage.getItem("fOpen") === "1") f.hidden = false;
  $("#toggleF")?.addEventListener("click", () => { f.hidden = !f.hidden; sessionStorage.setItem("fOpen", f.hidden ? "0" : "1"); });
  $("#pTerm")?.addEventListener("change", (e) => { S.profile.term = e.target.value; save(); });
  f?.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const tog = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    if (b.dataset.company) S.q.companies = tog(S.q.companies, b.dataset.company);
    else if (b.dataset.tag) S.q.tags = tog(S.q.tags, b.dataset.tag);
    else if (b.dataset.c !== undefined) S.q.contract = b.dataset.c;
    else if (b.dataset.s) S.q.sort = b.dataset.s;
    else if (b.id === "fReset") S.q = { ...S.q, companies: [], tags: [], contract: "", onlyRates: false, hideClauses: true, showStopped: false };
    else return;
    save();
  });
  $("#fRates")?.addEventListener("change", (e) => { S.q.onlyRates = e.target.checked; save(); });
  $("#fClauses")?.addEventListener("change", (e) => { S.q.hideClauses = e.target.checked; save(); });
  $("#fStopped")?.addEventListener("change", (e) => { S.q.showStopped = e.target.checked; save(); });
}

/* ---------- 詳細資料 ---------- */
async function openDetail(id) {
  const p = S.byId.get(id);
  if (!p) return;
  const docs = Object.entries(p.docs || {}).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)} ↗</a>`).join("");
  $("#sheetBody").innerHTML = `
    <div class="sheet-hd"><h2>${esc(p.name)}<small>${esc(S.meta.companies[p.company]?.name)} · ${esc(p.code)}</small></h2>
      <button class="icon-btn fav${S.favs.has(p.id) ? " on" : ""}" data-fav="${esc(p.id)}" aria-label="最愛">${ICON_HEART}</button>
      <button class="icon-btn" id="closeSheet" aria-label="關閉">${ICON_X}</button></div>
    <div class="sheet-bd">
      <dl class="kv">
        <dt>主附約</dt><dd>${esc(p.contract || "—")}</dd>
        <dt>險種</dt><dd>${esc(p.category.join("、") || "—")}</dd>
        <dt>承保年齡</dt><dd>${esc(p.age_text || (p.age_min != null ? `${p.age_min}–${p.age_max} 歲` : "—"))}</dd>
        <dt>繳費年期</dt><dd>${esc(p.pay_period || "—")}</dd>
        <dt>繳費方式</dt><dd>${esc(p.pay_method || "—")}</dd>
        <dt>幣別</dt><dd>${esc(p.currency && p.currency !== "foreign" ? p.currency : p._cur)}</dd>
        <dt>備查日期</dt><dd>${esc(p.approval_date || "—")}${p.approval_no ? `<br><span class="note">${esc(p.approval_no)}</span>` : ""}</dd>
        <dt>收錄日期</dt><dd>${esc(p.first_seen)}</dd>
        ${p.status === "停售" ? `<dt>銷售狀態</dt><dd><span class="badge stop">停售</span> ${p.removed_on ? esc(p.removed_on) + " 起停止銷售" : "已停止銷售"}</dd>` : ""}
      </dl>
      ${p.benefits.length ? `<div class="sec"><h3>保障內容 / 給付項目</h3><div class="badges">${p.benefits.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}</div></div>` : ""}
      ${p.features.length ? `<div class="sec"><h3>商品特色</h3><ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      <div class="sec"><h3>保費試算</h3><div id="calc" class="calc">${p.has_rates ? "載入費率…" : '<span class="note">尚未取得此商品的費率表，請參考 DM 或洽業務員。</span>'}</div></div>
      <div class="sec"><h3>文件</h3><div class="docs">${docs || '<span class="note">無</span>'}<a href="${esc(p.url)}" target="_blank" rel="noopener">官網 ↗</a></div></div>
      <div class="row"><button class="primary" data-cmp="${esc(p.id)}">${S.cmp.includes(p.id) ? "✓ 已加入比較" : "+ 加入比較"}</button></div>
    </div>`;
  const dlg = $("#sheet");
  if (!dlg.open) dlg.showModal();
  $("#closeSheet").onclick = () => dlg.close();
  if (p.has_rates) renderCalc(p, await ratesFor(p));
}

function fullTable(t) {
  const ages = Object.keys(t.rows).sort((a, b) => a - b);
  return `<div class="cmp-wrap" style="margin:8px 0"><table class="rate-table full"><caption class="note" style="text-align:left">第 ${t.page} 頁 ${esc(t.unit)}</caption>
    <thead><tr><th>年齡</th>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${ages.map((a) => `<tr${a === String(S.profile.age) ? ' class="hl"' : ""}><td>${a}</td>${t.rows[a].map((v) => `<td class="v">${v == null ? "—" : fmt(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderCalc(p, tables) {
  const el = $("#calc");
  if (!el) return;
  const pf = S.profile;
  const terms = termsOf(tables);
  const term = terms.includes(pf.term) ? pf.term : "";
  const hits = lookup(tables, pf.age, pf.gender, term);
  const src = p.rate_src;
  el.innerHTML = `
    <div class="row"><label>年齡</label><input id="cAge" type="number" min="0" max="100" inputmode="numeric" value="${esc(pf.age)}" placeholder="例 30">
      <span class="seg" id="cGender"><button data-g="M" class="${pf.gender === "M" ? "on" : ""}">男</button><button data-g="F" class="${pf.gender === "F" ? "on" : ""}">女</button></span>
      ${terms.length ? `<select id="cTerm"><option value="">全部年期</option>${terms.map((t) => `<option ${t === term ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""}
      <label>單位數</label><input id="cUnits" type="number" min="0" step="0.5" value="${esc(store.get("units", 1))}"></div>
    ${pf.age === "" ? '<span class="note">輸入年齡即可試算。</span>' : hits.length ? `
      <table class="rate-table"><thead><tr><th>方案</th><th style="text-align:right">年繳保費（${esc(p._cur === "新台幣" ? "新台幣" : p._cur)}）</th></tr></thead><tbody>
      ${hits.map((h) => `<tr><td>${esc(h.label)}<br><span class="note">${esc(h.unit)}</span></td><td class="v">${fmt(Math.round(h.value * store.get("units", 1)))}</td></tr>`).join("")}
      </tbody></table>` : `<span class="note">費率表內沒有 ${esc(pf.age)} 歲${pf.gender === "M" ? "男性" : "女性"}的資料（可能不在承保年齡內）。</span>`}
    <details><summary class="note">看完整費率表（${tables.length} 張）</summary>${tables.map(fullTable).join("")}</details>
    <span class="note">費率自動解析自官方 PDF（第 ${[...new Set(tables.map((t) => t.page))].join("、")} 頁），僅供參考，實際保費以保險公司核保為準。<a href="${esc(src)}" target="_blank" rel="noopener">開啟原始 PDF ↗</a></span>`;
  const save = () => { store.set("profile", S.profile); renderCalc(p, tables); };
  $("#cAge").addEventListener("change", (e) => { pf.age = e.target.value === "" ? "" : String(parseInt(e.target.value, 10) || 0); save(); });
  $("#cGender").addEventListener("click", (e) => { if (e.target.dataset.g) { pf.gender = e.target.dataset.g; save(); } });
  $("#cTerm")?.addEventListener("change", (e) => { pf.term = e.target.value; save(); });
  $("#cUnits").addEventListener("change", (e) => { store.set("units", Math.max(0, parseFloat(e.target.value) || 1)); save(); });
}

/* ---------- 速查 ---------- */
function quickBase() {
  const age = S.profile.age === "" ? null : Number(S.profile.age);
  return S.products.filter((p) => p.status !== "停售" && !isClause(p) &&
    (age == null || (p.age_min != null && age >= p.age_min && age <= p.age_max)));
}

/** 「查 實支實付 45歲 國泰」→ 速查條件 */
function parseQuick(text) {
  const qf = { facets: [], companies: [] };
  let age = null;
  const rest = [];
  const labels = Object.entries(FACETS).map(([k, f]) => [k, f.label]).sort((a, b) => b[1].length - a[1].length);
  for (let tok of text.replace(/一筆金/g, "一次金").replace(/^查\s*/, "").split(/[\s,，、＋+]+/).filter(Boolean)) {
    const m = tok.match(/^(\d{1,3})\s*歲?$/);
    if (m && +m[1] <= 110) { age = m[1]; continue; }
    const co = Object.entries(S.meta.companies).find(([, c]) => tok === c.short || tok === c.name || tok === c.short + "人壽");
    if (co) { qf.companies.push(co[0]); continue; }
    const hot = HOT.find(([l]) => l === tok);
    if (hot) { qf.facets.push(...hot[1]); continue; }
    let hit = false;
    for (const [k, l] of labels) {
      if (tok.includes(l)) { qf.facets.push(k); tok = tok.replace(l, ""); hit = true; }
    }
    if (tok.trim() && !hit) rest.push(tok);
  }
  return { qf: { facets: [...new Set(qf.facets)], companies: [...new Set(qf.companies)] }, age, rest: rest.join(" ") };
}

function goQuick(qf, opts = {}) {
  S.qf = qf;
  if (opts.age != null) { S.profile.age = String(opts.age); store.set("profile", S.profile); }
  S.q.text = opts.text || "";
  store.set("q", S.q);
  location.hash = "#search";
}

function renderQuick() {
  const base = quickBase();
  const cnt = (ids) => base.filter((p) => ids.every((f) => p._f.has(f))).length;
  const sel = S.qsel;
  const chip = (id) => `<button class="qchip${sel.facets.has(id) ? " on" : ""}" data-qf="${id}">${esc(FACETS[id].label)}<small>${cnt([id])}</small></button>`;
  const picked = () => [...[...sel.facets].map((f) => FACETS[f].label), ...[...sel.companies].map((c) => S.meta.companies[c].short)];
  const pickedLine = () => (picked().length ? `<div class="qpicked">已選：${esc(picked().join("、"))}</div>` : "");
  const submit = `<button class="primary qsubmit" data-qsubmit>送出查詢${picked().length ? `（${picked().length}）` : ""}</button>`;
  const cos = Object.entries(S.meta.companies).filter(([, c]) => c.count > 0);
  const newCount = base.filter((p) => p.is_new).length;
  $("#view").innerHTML = `
  <div class="quick" id="quick">
    <section class="qcard">
      <header><h2>快速查</h2><p>點一下直接看結果</p></header>
      <div class="qbody">
        ${whoChip()}
        <button class="qbig" data-new>新商品（60 天內）<small>${newCount}</small></button>
        <h4>熱門保障</h4>
        <div class="qgrid g2">${HOT.map(([l, ids], i) => `<button class="qchip" data-hot="${i}">${esc(l)}<small>${cnt(ids)}</small></button>`).join("")}</div>
        <form class="qtype" id="qtype"><input id="qtext" type="search" placeholder="直接打字，例如：實支實付 45歲" autocomplete="off"><button class="primary">查</button></form>
        <p class="note">要組合條件（例如三家公司＋45 歲），往右滑複選 →${S.profile.age !== "" ? `<br>數字為 ${esc(S.profile.age)} 歲可投保的商品數（不含未標示年齡的商品）` : ""}</p>
      </div>
    </section>
    <section class="qcard">
      <header><h2>② 險種、期間</h2><p>可複選，點了會顯示已選什麼；再點一次取消</p></header>
      <div class="qbody">${pickedLine()}
        ${QF_GROUPS.map(([g, ids]) => `<h4>${g}</h4><div class="qgrid g${Math.min(ids.length, 3)}">${ids.map(chip).join("")}</div>`).join("")}
        <h4>被保險人</h4>${whoChip()}
      </div>${submit}
    </section>
    <section class="qcard">
      <header><h2>③ 保障</h2><p>可複選，選多個代表都要有</p></header>
      <div class="qbody">${pickedLine()}<div class="qgrid g3">${QF_COVER.map(chip).join("")}</div></div>${submit}
    </section>
    <section class="qcard">
      <header><h2>④ 公司</h2><p>可複選</p></header>
      <div class="qbody">${pickedLine()}<div class="qgrid g3">${cos.map(([k, c], i) =>
        `<button class="qchip co c${i % 6}${sel.companies.has(k) ? " on" : ""}" data-qco="${k}">${esc(c.short)}<small>${base.filter((p) => p.company === k).length}</small></button>`).join("")}</div></div>${submit}
    </section>
  </div>`;
  const v = $("#view");
  v.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.hasAttribute("data-who")) return;
    if (b.dataset.qf) { sel.facets.has(b.dataset.qf) ? sel.facets.delete(b.dataset.qf) : sel.facets.add(b.dataset.qf); keepScroll(renderQuick); }
    else if (b.dataset.qco) { sel.companies.has(b.dataset.qco) ? sel.companies.delete(b.dataset.qco) : sel.companies.add(b.dataset.qco); keepScroll(renderQuick); }
    else if (b.dataset.hot) goQuick({ facets: HOT[+b.dataset.hot][1], companies: [] });
    else if (b.hasAttribute("data-new")) { S.qf = { facets: [], companies: [] }; location.hash = "#new"; }
    else if (b.hasAttribute("data-qsubmit")) goQuick({ facets: [...sel.facets], companies: [...sel.companies] });
  };
  $("#qtype").onsubmit = (e) => {
    e.preventDefault();
    const r = parseQuick($("#qtext").value);
    goQuick(r.qf, { age: r.age, text: r.rest });
  };
}
function keepScroll(fn) {
  const q = $("#quick"), x = q ? q.scrollLeft : 0, y = window.scrollY;
  fn();
  const q2 = $("#quick"); if (q2) q2.scrollLeft = x;
  window.scrollTo(0, y);
}

/* ---------- 比較 ---------- */
async function renderCompare() {
  const items = S.cmp.map((id) => S.byId.get(id)).filter(Boolean);
  if (!items.length) {
    $("#view").innerHTML = `<div class="empty">尚未選擇商品。<br>在商品卡片上按「+ 比較」，最多可同時比較 ${MAX_CMP} 個商品。</div>`;
    return;
  }
  const pf = S.profile;
  $("#view").innerHTML = '<div class="empty">載入費率中…</div>';
  const tables = await Promise.all(items.map(ratesFor));
  const premiums = items.map((p, i) => lookup(tables[i], pf.age, pf.gender, pf.term));
  const minOf = (h) => (h.length ? Math.min(...h.map((x) => x.value)) : null);
  const mins = premiums.map(minOf);
  const best = Math.min(...mins.filter((x) => x != null));
  const allTags = TAGS.filter((t) => items.some((p) => p.tags.includes(t)));
  const row = (label, f) => `<tr><th>${label}</th>${items.map((p, i) => `<td>${f(p, i)}</td>`).join("")}</tr>`;
  $("#view").innerHTML = `${toolbar(false, true)}
    <div class="count">比較 ${items.length} 個商品 · 保費依「我的條件」試算</div>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th></th>${items.map((p) => `<td>${esc(p.name)}<small>${esc(short(p))} · ${esc(p.code)}</small></td>`).join("")}</tr></thead>
      <tbody>
      ${row("保費試算", (p, i) => (pf.age === "" ? '<span class="note">請輸入年齡</span>' : !p.has_rates ? '<span class="note">無費率表</span>' : premiums[i].length
        ? `<div class="${mins[i] === best && items.length > 1 && items.every((x) => x._cur === p._cur) ? "best" : ""}">${fmt(mins[i])}${esc(unitOf(p))}起</div>${premiums[i].slice(0, 6).map((h) => `<div class="note">${esc(h.label)}：${fmt(h.value)}</div>`).join("")}<div class="note">${esc(premiums[i][0].unit)}</div>`
        : '<span class="note">不在承保範圍</span>'))}
      ${row("主附約", (p) => esc(p.contract || "—"))}
      ${row("承保年齡", (p) => esc(p.age_text || (p.age_min != null ? `${p.age_min}–${p.age_max} 歲` : "—")))}
      ${row("繳費年期", (p) => esc(p.pay_period || "—"))}
      ${row("幣別", (p) => esc(p.currency && p.currency !== "foreign" ? p.currency : p._cur))}
      ${allTags.map((t) => row(esc(t), (p) => (p.tags.includes(t) ? '<span class="yes">✓</span>' : '<span class="no">—</span>'))).join("")}
      ${row("給付項目", (p) => esc(p.benefits.join("、") || "—"))}
      ${row("商品特色", (p) => p.features.map(esc).join("<br>") || "—")}
      ${row("備查日期", (p) => esc(p.approval_date || "—"))}
      ${row("文件", (p) => Object.entries(p.docs).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`).join("　") || "—")}
      ${row("", (p) => `<button class="ghost" data-uncmp="${esc(p.id)}">移除</button>`)}
      </tbody></table></div>
    <p class="note">保障內容依官網給付項目整理，詳細給付條件請以條款為準。</p>`;
  bindToolbar(renderCompare);
}

/* ---------- 公司 ---------- */
function renderCompanies() {
  const cs = Object.entries(S.meta.companies).sort((a, b) => b[1].count - a[1].count);
  const err = Object.keys(S.meta.errors || {});
  $("#view").innerHTML = `<div class="co-list">${cs.map(([k, c]) => `<div class="co${c.count ? "" : " zero"}" data-co="${k}"><b>${esc(c.name)}</b><span>${c.count ? c.count + " 個" + (c.stopped ? `・停售 ${c.stopped}` : "") : c.auto === false ? "官網有防護，需手動匯入" : "收錄中"}</span></div>`).join("")}</div>
    ${err.length ? `<p class="notice">本次更新未成功：${err.map((k) => esc(S.meta.companies[k]?.name || k)).join("、")}（沿用上次資料）</p>` : ""}
    <p class="note">資料來源：各公司官網商品專區與「資訊公開」。每日自動更新。</p>`;
}

/* ---------- 路由 ---------- */
function route() {
  const tab = (location.hash.match(/^#\/?(\w+)/) || [, "quick"])[1];
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  S.limit = 60;
  if (tab === "quick") renderQuick();
  else if (tab === "new") renderList(S.products.filter((p) => p.is_new), "近 60 天新上架或新收錄");
  else if (tab === "fav") renderList(S.products.filter((p) => S.favs.has(p.id)), S.favs.size ? "" : "尚無最愛：點卡片右上角的愛心加入");
  else if (tab === "compare") renderCompare();
  else if (tab === "companies") renderCompanies();
  else renderList(S.products, "");
  updateCmpBar();
  window.scrollTo(0, 0);
}

function updateCmpBar() {
  const n = S.cmp.length;
  const onCompare = /^#\/?compare/.test(location.hash);
  $("#compareBar").hidden = !n || onCompare;
  $("#compareCount").textContent = `已選 ${n}/${MAX_CMP} 個商品`;
  const b = $("#cmpBadge"); b.hidden = !n; b.textContent = n;
}

function toggleCmp(id) {
  if (S.cmp.includes(id)) S.cmp = S.cmp.filter((x) => x !== id);
  else if (S.cmp.length >= MAX_CMP) { const c = $("#compareCount"); c.textContent = `最多比較 ${MAX_CMP} 個，請先移除一個`; $("#compareBar").hidden = false; return; }
  else S.cmp.push(id);
  store.set("cmp", S.cmp);
  document.querySelectorAll(`[data-cmp="${CSS.escape(id)}"]`).forEach((b) => {
    const on = S.cmp.includes(id);
    b.classList.toggle("on", on);
    b.textContent = b.classList.contains("primary") ? (on ? "✓ 已加入比較" : "+ 加入比較") : on ? "✓ 比較中" : "+ 比較";
    b.closest(".card")?.classList.toggle("sel", on);
  });
  updateCmpBar();
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-who]")) { openWho(); return; }
  const fav = e.target.closest("[data-fav]");
  if (fav) {
    e.stopPropagation();
    const id = fav.dataset.fav;
    S.favs.has(id) ? S.favs.delete(id) : S.favs.add(id);
    store.set("favs", [...S.favs]);
    document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle("on", S.favs.has(id)));
    return;
  }
  const cmp = e.target.closest("[data-cmp]");
  if (cmp) { e.stopPropagation(); toggleCmp(cmp.dataset.cmp); return; }
  const un = e.target.closest("[data-uncmp]");
  if (un) { toggleCmp(un.dataset.uncmp); renderCompare(); return; }
  const co = e.target.closest("[data-co]");
  if (co) { S.q.companies = [co.dataset.co]; store.set("q", S.q); location.hash = "#search"; return; }
  const c = e.target.closest(".card");
  if (c) openDetail(c.dataset.id);
});
$("#compareGo").addEventListener("click", () => (location.hash = "#compare"));
$("#compareClear").addEventListener("click", () => { S.cmp = []; store.set("cmp", []); route(); });
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") e.target.close(); });
window.addEventListener("hashchange", route);

load().then(route).catch((e) => { $("#view").innerHTML = `<div class="empty">資料載入失敗：${esc(e.message)}</div>`; });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
