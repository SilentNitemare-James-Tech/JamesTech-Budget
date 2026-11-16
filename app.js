(() => {
  "use strict";

  // Shared settings and local calendar helpers (weeks run Monday–Sunday).
  const storageKey = "jamestech-budget-v1";
  const categories = ["Food", "Gas", "Bills", "Subscriptions", "Entertainment", "Other"];
  const colors = ["#76ebbb", "#82b1ff", "#ffc978", "#c3a5ff", "#ff9cad", "#a9bbcc"];
  const frequencies = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const money = cents => currency.format(cents / 100);
  const cents = dollars => Math.round(dollars * 100);
  const $ = id => document.getElementById(id);
  const income = $("income-form").elements;
  const savings = $("savings-form").elements;
  const purchase = $("purchase-form").elements;
  const lists = [];
  let editingId = null;

  function dateKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return String(date.getFullYear()).padStart(4, "0") + "-" + month + "-" + day;
  }

  function offsetDate(key, days) {
    const date = new Date(key + "T12:00:00");
    date.setDate(date.getDate() + days);
    return dateKey(date);
  }

  function monday(key) {
    const day = new Date(key + "T12:00:00").getDay();
    return offsetDate(key, -((day + 6) % 7));
  }

  function validDate(key) {
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key) || key < "1900-01-01" || key > "9998-12-31") return false;
    const date = new Date(key + "T12:00:00");
    return Number.isFinite(date.getTime()) && dateKey(date) === key;
  }

  function displayDate(key) {
    return new Date(key + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  const today = () => dateKey(new Date());
  const validNumber = (value, max, min = 0) =>
    Number.isFinite(value) && value >= min && value <= max && Math.abs(value - cents(value) / 100) < 0.000001;
  const validMode = value => value === "amount" || value === "percent";
  const validPay = entry => entry && validDate(entry.date) &&
    validNumber(entry.rate, 1000000) && validNumber(entry.hours, 168) &&
    validMode(entry.taxMode) && validNumber(entry.tax, entry.taxMode === "percent" ? 100 : 168000000);
  const validPurchase = item => item && typeof item.id === "string" && item.id.length > 0 &&
    typeof item.title === "string" && item.title.trim().length > 0 && item.title.length <= 100 &&
    validNumber(item.amount, 1000000, .01) && categories.includes(item.category) && validDate(item.date) &&
    (item.type === "One-time" && item.frequency === null ||
     item.type === "Recurring" && Object.hasOwn(frequencies, item.frequency));

  // State and backup validation. Keep one saved snapshot per calendar week.
  let selectedDate = today();
  let state = { version: 1, savings: { mode: "amount", value: 0, target: null }, drafts: [], history: [], purchases: [] };

  function validateBackup(data) {
    if (data?.version !== 1 || !data.savings || !validMode(data.savings.mode) ||
        !validNumber(data.savings.value, data.savings.mode === "percent" ? 100 : 1000000) ||
        (data.savings.target !== null && !validNumber(data.savings.target, 100000000)) ||
        !Array.isArray(data.drafts) || !Array.isArray(data.history) || !Array.isArray(data.purchases) ||
        !data.drafts.every(validPay) ||
        !data.history.every(entry => validPay(entry) && payTotals(entry).net >= 0 &&
          Number.isSafeInteger(entry.saved) && entry.saved >= 0 && entry.saved <= 16800000000) ||
        !data.purchases.every(validPurchase)) {
      throw new Error("Invalid JamesTech Budget backup.");
    }
    const unique = (entries, key) => new Set(entries.map(key)).size === entries.length;
    const weekKey = entry => monday(entry.date);
    if (!unique(data.drafts, weekKey) || !unique(data.history, weekKey) || !unique(data.purchases, item => item.id)) {
      throw new Error("The backup contains duplicate records.");
    }
    return data;
  }

  function announce(message) {
    $("status").hidden = false;
    $("status").textContent = message;
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      return true;
    } catch {
      announce("Browser storage is unavailable. Export your data to keep a copy.");
      return false;
    }
  }

  function load() {
    try {
      const backup = localStorage.getItem(storageKey);
      if (backup !== null) state = validateBackup(JSON.parse(backup));
    } catch {
      announce("Saved data could not be loaded. Restore a JSON backup if you have one.");
    }
  }

  function setWeek(entries, entry) {
    const week = monday(entry.date);
    const index = entries.findIndex(item => monday(item.date) === week);
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  }

  // Money is calculated in cents. Recurring costs are rounded per purchase.
  function payTotals(entry) {
    const gross = cents(entry.rate * entry.hours);
    const tax = entry.taxMode === "percent" ? Math.round(gross * entry.tax / 100) : cents(entry.tax);
    return { gross, tax, net: gross - tax };
  }

  function weeklySavings(net) {
    const plan = state.savings;
    return plan.mode === "percent" ? Math.round(Math.max(0, net) * plan.value / 100) : cents(plan.value);
  }

  function weeklyCost(item) {
    const cost = cents(item.amount);
    if (item.frequency === "biweekly") return Math.round(cost / 2);
    if (item.frequency === "monthly") return Math.round(cost * 12 / 52);
    return cost;
  }

  function budgetExpenses(start, end) {
    const totals = Object.fromEntries(categories.map(category => [category, 0]));
    for (const item of state.purchases) {
      const inScope = item.date <= end && (item.type === "Recurring" || item.date >= start);
      if (inScope) totals[item.category] += weeklyCost(item);
    }
    return totals;
  }

  // Input handling and live dashboard.
  function readPay() {
    return {
      date: selectedDate, rate: income.rate.valueAsNumber, hours: income.hours.valueAsNumber,
      taxMode: income.taxMode.value, tax: income.tax.valueAsNumber
    };
  }

  function weekPay() {
    const week = monday(selectedDate);
    const byWeek = entry => monday(entry.date) === week;
    return state.drafts.find(byWeek) || state.history.find(byWeek);
  }

  function fillIncome() {
    const entry = weekPay();
    income.date.value = selectedDate;
    income.rate.value = entry?.rate ?? 0;
    income.hours.value = entry?.hours ?? 0;
    income.taxMode.value = entry?.taxMode ?? "amount";
    income.tax.value = entry?.tax ?? 0;
    updateTaxField();
  }

  function updateTaxField() {
    const percent = income.taxMode.value === "percent";
    $("tax-label").textContent = percent ? "Taxes withheld (%)" : "Taxes withheld ($)";
    income.tax.max = percent ? 100 : 168000000;
    income.tax.setCustomValidity("");
    const entry = readPay();
    if (validPay(entry) && payTotals(entry).net < 0) {
      income.tax.setCustomValidity("Taxes withheld cannot exceed gross pay.");
    }
  }

  function fillSavings() {
    savings.mode.value = state.savings.mode;
    savings.value.value = state.savings.value;
    savings.target.value = state.savings.target ?? "";
    updateSavingsField();
  }

  function updateSavingsField() {
    const percent = savings.mode.value === "percent";
    $("saving-label").textContent = percent ? "Share of net pay (%)" : "Weekly amount ($)";
    savings.value.max = percent ? 100 : 1000000;
  }

  function renderDashboard() {
    const start = monday(selectedDate);
    const end = offsetDate(start, 6);
    $("week-label").textContent = displayDate(start) + " – " + displayDate(end);
    const entry = readPay();
    // Blank or temporarily invalid fields contribute zero until corrected.
    for (const [field, max] of [["rate", 1000000], ["hours", 168], ["tax", entry.taxMode === "percent" ? 100 : 168000000]]) {
      if (!validNumber(entry[field], max)) entry[field] = 0;
    }
    const { gross, net } = payTotals(entry);
    const saving = weeklySavings(net);
    const totals = budgetExpenses(start, end);
    const expense = Object.values(totals).reduce((sum, value) => sum + value, 0);
    const free = net - saving - expense;
    $("gross-pay").value = money(gross);
    $("net-pay").value = money(net);
    $("weekly-saving").value = money(saving);
    $("total-expenses").value = money(expense);
    $("free-money").value = money(free);
    $("free-money").dataset.tone = free < 0 ? "red" : free < 5000 ? "yellow" : "green";
    $("free-caption").textContent = free < 0 ? "Over budget" : "Available after savings and expenses";

    const saved = state.history.reduce((sum, item) => sum + item.saved, 0);
    const target = cents(state.savings.target ?? 0);
    $("saved-total").value = money(saved);
    $("goal").hidden = target === 0;
    if (target > 0) {
      $("goal-progress").max = target;
      $("goal-progress").value = Math.min(saved, target);
      $("goal-caption").textContent = money(saved) + " of " + money(target) + " saved";
    }
    renderChart(totals, expense);
  }

  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function renderChart(totals, expense) {
    const chart = $("chart");
    const legend = $("chart-legend");
    chart.replaceChildren();
    legend.replaceChildren();
    let x = 0;
    categories.forEach((category, index) => {
      const color = colors[index];
      const value = totals[category];
      if (value > 0) {
        const width = value / expense * 300;
        const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        for (const [name, attribute] of Object.entries({ x, y: 0, width, height: 16, fill: color })) {
          bar.setAttribute(name, attribute);
        }
        chart.append(bar);
        x += width;
      }
      const row = node("li");
      const swatch = node("span", "", "swatch");
      swatch.style.backgroundColor = color;
      row.append(swatch, node("span", category), node("span", money(value)));
      legend.append(row);
    });
  }

  function renderHistory() {
    const container = $("history");
    container.replaceChildren();
    if (state.history.length === 0) {
      container.append(node("p", "Save a week to start your income history.", "muted"));
      return;
    }
    const scroll = node("div", undefined, "table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "Scrollable weekly income history");
    const table = node("table");
    const headings = table.createTHead().insertRow();
    for (const label of ["Week date", "Hours", "Gross", "Taxes", "Net", "Savings"]) {
      const heading = node("th", label);
      heading.scope = "col";
      headings.append(heading);
    }
    const body = table.createTBody();
    for (const entry of [...state.history].sort((a, b) => b.date.localeCompare(a.date))) {
      const { gross, tax, net } = payTotals(entry);
      const row = body.insertRow();
      for (const value of [displayDate(entry.date), entry.hours, money(gross), money(tax), money(net), money(entry.saved)]) {
        row.insertCell().textContent = value;
      }
    }
    scroll.append(table);
    container.append(scroll);
  }

  // Purchase lists, category totals, and editing.
  function fillCategories(select, includeAll = false) {
    if (includeAll) select.add(new Option("All categories", ""));
    for (const category of categories) select.add(new Option(category, category));
  }

  function buildLists() {
    for (const type of ["Recurring", "One-time"]) {
      const section = $("expense-template").content.firstElementChild.cloneNode(true);
      section.querySelector("h2").textContent = type;
      section.querySelector(".scope").textContent = type === "Recurring"
        ? "Weekly equivalents for listed purchases, including future start dates."
        : "Purchase totals across all dates.";
      const filter = section.querySelector(".filter");
      const sort = section.querySelector(".sort");
      fillCategories(filter, true);
      const list = { section, type, filter, sort };
      filter.addEventListener("change", () => renderList(list));
      sort.addEventListener("change", () => renderList(list));
      lists.push(list);
      $("purchase-lists").append(section);
    }
  }

  function renderList({ section, type, filter, sort }) {
    const rows = state.purchases.filter(item => item.type === type && (!filter.value || item.category === filter.value));
    const byDate = (a, b) => b.date.localeCompare(a.date);
    const order = {
      date: byDate,
      amount: (a, b) => b.amount - a.amount || byDate(a, b),
      category: (a, b) => a.category.localeCompare(b.category) || byDate(a, b)
    };
    rows.sort(order[sort.value]);
    const entries = section.querySelector(".entries");
    const totals = section.querySelector(".category-totals");
    entries.replaceChildren();
    totals.replaceChildren();
    const categoryCosts = Object.fromEntries(categories.map(category => [category, 0]));
    for (const item of rows) {
      categoryCosts[item.category] += weeklyCost(item);
      const row = node("li");
      const heading = node("div", undefined, "entry-head");
      heading.append(node("strong", item.title), node("span", money(cents(item.amount)), "entry-amount"));
      const details = [item.category, displayDate(item.date)];
      if (type === "Recurring") details.push(frequencies[item.frequency], money(weeklyCost(item)) + "/week");
      row.append(heading, node("p", details.join(" · "), "muted"));
      const actions = node("div", undefined, "actions");
      const edit = node("button", "Edit");
      const remove = node("button", "Delete");
      edit.type = remove.type = "button";
      edit.setAttribute("aria-label", "Edit " + item.title);
      remove.setAttribute("aria-label", "Delete " + item.title);
      edit.addEventListener("click", () => editPurchase(item));
      remove.addEventListener("click", () => deletePurchase(item));
      actions.append(edit, remove);
      row.append(actions);
      entries.append(row);
    }
    if (!rows.length) entries.append(node("li", "No matching purchases.", "muted"));
    for (const category of filter.value ? [filter.value] : categories) {
      totals.append(node("dt", category), node("dd", money(categoryCosts[category])));
    }
    const subtotal = Object.values(categoryCosts).reduce((sum, cost) => sum + cost, 0);
    section.querySelector(".subtotal").value = money(subtotal) + (type === "Recurring" ? "/wk" : "");
  }

  function updateFrequency() {
    const recurring = purchase.type.value === "Recurring";
    $("frequency-field").hidden = !recurring;
    purchase.frequency.disabled = !recurring;
  }

  function clearPurchase() {
    editingId = null;
    $("purchase-form").reset();
    purchase.title.setCustomValidity("");
    const start = monday(selectedDate);
    purchase.date.value = today() >= start && today() <= offsetDate(start, 6) ? today() : selectedDate;
    $("purchase-title").textContent = "Add a purchase";
    $("purchase-submit").textContent = "Add purchase";
    $("cancel-edit").hidden = true;
    updateFrequency();
  }

  function editPurchase(item) {
    editingId = item.id;
    for (const field of ["title", "amount", "category", "date", "type", "frequency"]) {
      purchase[field].value = item[field] ?? "weekly";
    }
    purchase.title.setCustomValidity("");
    $("purchase-title").textContent = "Edit purchase";
    $("purchase-submit").textContent = "Save changes";
    $("cancel-edit").hidden = false;
    updateFrequency();
    purchase.title.focus();
  }

  function deletePurchase(item) {
    if (!window.confirm("Delete " + item.title + "?")) return;
    state.purchases = state.purchases.filter(entry => entry.id !== item.id);
    if (editingId === item.id) clearPurchase();
    if (persist()) announce("Purchase deleted.");
    refresh();
  }

  function refresh() {
    renderDashboard();
    renderHistory();
    lists.forEach(renderList);
  }

  // Connect form events and persist valid edits as they happen.
  $("income-form").addEventListener("input", event => {
    if (event.target === income.date) return;
    updateTaxField();
    const entry = readPay();
    if (validPay(entry)) {
      setWeek(state.drafts, entry);
      persist();
    }
    renderDashboard();
  });

  income.date.addEventListener("change", () => {
    if (!validDate(income.date.value)) {
      income.date.value = selectedDate;
      return;
    }
    selectedDate = income.date.value;
    fillIncome();
    if (!editingId) {
      const start = monday(selectedDate);
      purchase.date.value = today() >= start && today() <= offsetDate(start, 6) ? today() : selectedDate;
    }
    renderDashboard();
  });

  $("income-form").addEventListener("submit", event => {
    event.preventDefault();
    updateTaxField();
    if (!$("income-form").reportValidity()) return;
    const entry = readPay();
    if (!validPay(entry)) return;
    setWeek(state.drafts, entry);
    setWeek(state.history, { ...entry, saved: weeklySavings(payTotals(entry).net) });
    if (persist()) announce("Week saved to income history.");
    refresh();
  });

  $("savings-form").addEventListener("submit", event => event.preventDefault());
  $("savings-form").addEventListener("input", event => {
    updateSavingsField();
    // Save the mode and its amount together so a dollar amount cannot become an invalid percentage.
    if (event.target !== savings.target && savings.value.validity.valid) {
      state.savings.mode = savings.mode.value;
      state.savings.value = savings.value.valueAsNumber;
      persist();
    } else if (event.target === savings.target && savings.target.validity.valid) {
      state.savings.target = savings.target.value === "" ? null : savings.target.valueAsNumber;
      persist();
    }
    renderDashboard();
  });

  purchase.type.addEventListener("change", updateFrequency);
  purchase.title.addEventListener("input", () => purchase.title.setCustomValidity(""));
  $("cancel-edit").addEventListener("click", clearPurchase);
  $("purchase-form").addEventListener("submit", event => {
    event.preventDefault();
    const title = purchase.title.value.trim();
    if (!title) {
      purchase.title.setCustomValidity("Enter a purchase name.");
      purchase.title.reportValidity();
      return;
    }
    const item = {
      id: editingId ?? (window.crypto.randomUUID?.() ?? Date.now() + "-" + Math.random().toString(36).slice(2)),
      title, amount: purchase.amount.valueAsNumber, category: purchase.category.value,
      date: purchase.date.value, type: purchase.type.value,
      frequency: purchase.type.value === "Recurring" ? purchase.frequency.value : null
    };
    if (!validPurchase(item)) return;
    const message = editingId ? "Purchase updated." : "Purchase added.";
    if (editingId) state.purchases = state.purchases.map(entry => entry.id === editingId ? item : entry);
    else state.purchases.push(item);
    clearPurchase();
    if (persist()) announce(message);
    refresh();
  });

  // Reset affects the current calendar week. Backups include all records and drafts.
  $("reset").addEventListener("click", () => {
    if (!window.confirm("Clear hours and one-time purchases for the current calendar week? Saved history will be kept.")) return;
    selectedDate = today();
    const start = monday(selectedDate);
    const end = offsetDate(start, 6);
    const entry = weekPay();
    setWeek(state.drafts, {
      date: selectedDate, hours: 0, rate: entry?.rate ?? 0, taxMode: entry?.taxMode ?? "amount",
      tax: entry?.taxMode === "percent" ? entry.tax : 0
    });
    state.purchases = state.purchases.filter(item => item.type === "Recurring" || item.date < start || item.date > end);
    fillIncome();
    clearPurchase();
    if (persist()) announce("Current week reset. Saved history is intact.");
    refresh();
  });

  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = "jamestech-budget-" + today() + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    let backup;
    try {
      backup = validateBackup(JSON.parse(await file.text()));
    } catch {
      announce("Import failed. Choose a valid JamesTech Budget JSON backup.");
      return;
    }
    if (!window.confirm("Replace the current budget data with this backup?")) return;
    state = backup;
    selectedDate = today();
    fillIncome();
    fillSavings();
    clearPurchase();
    if (persist()) announce("Backup restored.");
    refresh();
  });

  // Initialize the dashboard from browser storage.
  load();
  fillIncome();
  fillSavings();
  fillCategories(purchase.category);
  clearPurchase();
  buildLists();
  refresh();
})();
