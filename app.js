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
};
const MAX_CMP = 4;
const TAGS = ["實支實付", "住院日額", "手術", "癌症", "重大疾病", "重大傷病", "特定傷病", "失能", "長照", "身故", "意外", "門診", "豁免", "滿期/還本", "年金", "投資型", "外溢"];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("zh-TW") : n);
const short = (p) => S.meta.companies[p.company]?.short || p.company;
const mmdd = (iso) => (iso ? iso.slice(5).replace("-", "-") : "");
const ym = (iso) => (iso ? iso.slice(0, 7).replace("-", "/") : "");
const isClause = (p) => /批註|附加條款/.test(p.contract + p.name);

const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.3C1 8 3.4 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.6 0 6 3.5 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ---------- 資料 ---------- */
async function load() {
  const res = await fetch("data/products.json", { cache: "no-cache" });
  const d = await res.json();
  S.meta = d.meta;
  S.products = d.products;
  S.products.forEach((p) => S.byId.set(p.id, p));
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
    if (age != null && p.age_min != null && (age < p.age_min || age > p.age_max)) return false;
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

/* ---------- 卡片 ---------- */
function card(p) {
  const tags = [];
  if (p.is_new) tags.push(`<span class="badge new">新 ${esc(mmdd(p.approval_date || p.first_seen))}</span>`);
  if (p.status === "停售") tags.push(`<span class="badge stop">停售${p.removed_on ? " " + esc(p.removed_on.slice(0, 7).replace("-", "/")) : ""}</span>`);
  if (/附約/.test(p.contract + p.name)) tags.push('<span class="badge rider">附約</span>');
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
    el.innerHTML = `${esc(age)}歲${gender === "M" ? "男" : "女"} <b>${fmt(min.value)}</b> 元起 <span class="note">${esc(min.term || "")}</span>`;
  }
}

/* ---------- 畫面：查詢 / 新商品 / 最愛 ---------- */
function toolbar(showSearch = true) {
  const q = S.q, pf = S.profile;
  const comps = Object.entries(S.meta.companies).filter(([, c]) => c.count > 0);
  return `<div class="toolbar">
    ${showSearch ? `<div class="search"><input id="qText" type="search" placeholder="搜尋商品名稱、代碼、保障…" value="${esc(q.text)}">
      <button id="toggleF" class="${filterActive() ? "on" : ""}">篩選${filterActive() ? "•" : ""}</button></div>` : ""}
    <div class="row">
      <label for="pAge">我的條件</label><input id="pAge" type="number" min="0" max="100" inputmode="numeric" placeholder="年齡" value="${esc(pf.age)}">
      <span class="seg" id="pGender"><button data-g="M" class="${pf.gender === "M" ? "on" : ""}">男</button><button data-g="F" class="${pf.gender === "F" ? "on" : ""}">女</button></span>
      <select id="pTerm" aria-label="繳費年期"><option value="">全部年期</option>${["1年期", "5年期", "6年期", "10年期", "15年期", "20年期", "30年期"].map((t) => `<option ${pf.term === t ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
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
    <div class="count">共 ${list.length.toLocaleString()} 筆${S.profile.age !== "" ? `（已依 ${esc(S.profile.age)} 歲可投保過濾）` : ""}</div>
    ${shown.length ? `<div class="grid" id="grid">${shown.map(card).join("")}</div>` : '<div class="empty">沒有符合條件的商品</div>'}
    ${list.length > S.limit ? '<button class="btn more" id="more">顯示更多</button>' : ""}`;
  bindToolbar(() => renderList(base, title));
  $("#more")?.addEventListener("click", () => { S.limit += 60; renderList(base, title); });
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
  $("#pAge").addEventListener("change", (e) => { S.profile.age = e.target.value === "" ? "" : String(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0))); save(); });
  $("#pGender").addEventListener("click", (e) => { const g = e.target.dataset.g; if (g) { S.profile.gender = g; save(); } });
  $("#pTerm").addEventListener("change", (e) => { S.profile.term = e.target.value; save(); });
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
        <dt>幣別</dt><dd>${esc(p.currency || "—")}</dd>
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
      <table class="rate-table"><thead><tr><th>方案</th><th style="text-align:right">年繳保費（元）</th></tr></thead><tbody>
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
  $("#view").innerHTML = `${toolbar(false)}
    <div class="count">比較 ${items.length} 個商品 · 保費依「我的條件」試算</div>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th></th>${items.map((p) => `<td>${esc(p.name)}<small>${esc(short(p))} · ${esc(p.code)}</small></td>`).join("")}</tr></thead>
      <tbody>
      ${row("保費試算", (p, i) => (pf.age === "" ? '<span class="note">請輸入年齡</span>' : !p.has_rates ? '<span class="note">無費率表</span>' : premiums[i].length
        ? `<div class="${mins[i] === best && items.length > 1 ? "best" : ""}">${fmt(mins[i])} 元起</div>${premiums[i].slice(0, 6).map((h) => `<div class="note">${esc(h.label)}：${fmt(h.value)}</div>`).join("")}<div class="note">${esc(premiums[i][0].unit)}</div>`
        : '<span class="note">不在承保範圍</span>'))}
      ${row("主附約", (p) => esc(p.contract || "—"))}
      ${row("承保年齡", (p) => esc(p.age_text || (p.age_min != null ? `${p.age_min}–${p.age_max} 歲` : "—")))}
      ${row("繳費年期", (p) => esc(p.pay_period || "—"))}
      ${row("幣別", (p) => esc(p.currency || "—"))}
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
  const tab = (location.hash.match(/^#\/?(\w+)/) || [, "search"])[1];
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  S.limit = 60;
  if (tab === "new") renderList(S.products.filter((p) => p.is_new), "近 45 天新上架或新收錄");
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
