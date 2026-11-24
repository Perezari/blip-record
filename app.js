/* Blip public record — vanilla JS renderer (spec §7.5 M7, §7.8).
 * Reads the JSON documents written by the record export (stats.json, signals.json, ...),
 * which the local API also serves under the same names, so this file works unchanged on
 * GitHub Pages and on 127.0.0.1:8095 (the local API). All data is inserted with textContent (no innerHTML).
 */
(function () {
  "use strict";

  var body = document.body;
  var ROOT = body.getAttribute("data-root") || "";
  var PAGE = body.getAttribute("data-page") || "index";
  var SVGNS = "http://www.w3.org/2000/svg";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ------------------------------------------------------------------ helpers
  function getJSON(name) {
    return fetch(ROOT + name, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(name + ": HTTP " + r.status);
      return r.json();
    });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") n.textContent = attrs[k];
        else if (k === "cls") n.className = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function isNum(x) { return typeof x === "number" && isFinite(x); }

  function fmtR(x, d) {
    if (!isNum(x)) return "—";
    var s = x.toFixed(d === undefined ? 2 : d);
    return (x > 0 ? "+" : "") + s + "R";
  }
  function fmtPct(x) { return isNum(x) ? (x * 100).toFixed(0) + "%" : "—"; }
  function fmtNum(x, d) { return isNum(x) ? x.toFixed(d === undefined ? 2 : d) : "—"; }
  function signCls(x) { return !isNum(x) ? "flat" : x > 0 ? "up" : x < 0 ? "down" : "flat"; }

  function fmtPrice(x, decimals) {
    if (!isNum(x)) return "—";
    var d = isNum(decimals) ? decimals : (Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 4 : 6);
    var parts = x.toFixed(d).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function fmtDate(ms) {
    if (!isNum(ms)) return "—";
    var t = new Date(ms);
    return t.getUTCDate() + " " + MONTHS[t.getUTCMonth()] + " " + t.getUTCFullYear();
  }
  function fmtDateTime(ms) {
    if (!isNum(ms)) return "—";
    var t = new Date(ms);
    var hh = ("0" + t.getUTCHours()).slice(-2), mm = ("0" + t.getUTCMinutes()).slice(-2);
    return fmtDate(ms) + " " + hh + ":" + mm + " UTC";
  }

  function pill(status) { return el("span", { cls: "pill " + status, text: status }); }
  function td(text, cls) { return el("td", { cls: cls || "", text: text }); }

  function showError(container, err) {
    clear(container).appendChild(el("div", { cls: "empty err", text: "Could not load data (" + err.message + ")." }));
  }

  function signalHref(s) {
    if (s.no === null || s.no === undefined) return null;
    return ROOT + "s/" + encodeURIComponent(s.no) + ".html";
  }

  // ------------------------------------------------------------------ site banner + head
  function renderSite(site) {
    var head = document.getElementById("head");
    if (head && site.ledger_head) {
      head.textContent = "#" + site.ledger_head.seq + " " + String(site.ledger_head.hash || "").slice(0, 16);
    }
    var b = document.getElementById("banner");
    if (!b) return;
    var text = null;
    if (site.mode === "results_only") {
      text = "Results-only mode: trades are revealed after they close. Nothing actionable is published while a trade is open.";
    } else if (site.mode === "off") {
      text = "Public signals are currently off. Results continue to be recorded.";
    }
    if (text) {
      clear(b).appendChild(el("b", { text: "Note: " }));
      b.appendChild(document.createTextNode(text + " Updated " + fmtDateTime(site.generated_ms) + "."));
      b.hidden = false;
    }
  }

  // ------------------------------------------------------------------ chart (inline SVG)
  function lineChart(container, series, opts) {
    opts = opts || {};
    var W = 920, H = opts.height || 260, P = { l: 48, r: 12, t: 12, b: 26 };
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { all.push(p); }); });
    clear(container);
    if (all.length < 2) {
      container.appendChild(el("div", { cls: "empty", text: opts.empty || "Not enough data yet." }));
      return;
    }
    var xs = all.map(function (p) { return p[0]; }), ys = all.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min(0, Math.min.apply(null, ys)), y1 = Math.max(0, Math.max.apply(null, ys));
    if (x1 === x0) x1 = x0 + 1;
    if (y1 === y0) y1 = y0 + 1;
    var pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    function X(v) { return P.l + (v - x0) / (x1 - x0) * (W - P.l - P.r); }
    function Y(v) { return P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b); }

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label || "chart");
    function sv(tag, a) {
      var n = document.createElementNS(SVGNS, tag);
      Object.keys(a).forEach(function (k) { n.setAttribute(k, a[k]); });
      svg.appendChild(n); return n;
    }
    // grid + y labels
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var v = y0 + (y1 - y0) * i / ticks, y = Y(v);
      sv("line", { x1: P.l, x2: W - P.r, y1: y, y2: y, stroke: "#1F2430", "stroke-width": 1 });
      var t = sv("text", { x: P.l - 6, y: y + 4, "text-anchor": "end", fill: "#8A93A6", "font-size": 11 });
      t.textContent = v.toFixed(1) + "R";
    }
    sv("line", { x1: P.l, x2: W - P.r, y1: Y(0), y2: Y(0), stroke: "#3A4150", "stroke-width": 1 });
    // x labels: first and last date
    [x0, x1].forEach(function (xv, j) {
      var t = sv("text", { x: X(xv), y: H - 6, "text-anchor": j ? "end" : "start", fill: "#8A93A6", "font-size": 11 });
      t.textContent = fmtDate(xv);
    });
    series.forEach(function (s) {
      if (s.points.length < 1) return;
      var d = s.points.map(function (p, k) { return (k ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join(" ");
      sv("path", { d: d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round",
                   "stroke-dasharray": s.dash || "none" });
    });
    var legend = el("div", { cls: "legend" });
    series.forEach(function (s) {
      var sw = el("i"); sw.style.background = s.color;
      legend.appendChild(el("span", null, [sw, s.name]));
    });
    container.appendChild(legend);
    container.appendChild(svg);
  }

  // ------------------------------------------------------------------ pages
  function kpi(label, value, cls) {
    return el("div", { cls: "kpi" }, [el("div", { cls: "v " + (cls || ""), text: value }), el("div", { cls: "k", text: label })]);
  }

  function renderStats(st) {
    var k = clear(document.getElementById("kpis"));
    var pf = st.profit_factor_infinite ? "∞" : fmtNum(st.profit_factor);
    k.appendChild(kpi("Net R (closed)", fmtR(st.net_r, 1), signCls(st.net_r)));
    k.appendChild(kpi("Closed trades", String(st.n)));
    k.appendChild(kpi("Win rate (" + st.wins + "W/" + st.losses + "L)", fmtPct(st.win_rate)));
    k.appendChild(kpi("Avg R / trade", fmtR(st.expectancy), signCls(st.expectancy)));
    k.appendChild(kpi("Profit factor", pf));
    k.appendChild(kpi("Max drawdown (MTM)", isNum(st.max_dd_mtm) ? "−" + st.max_dd_mtm.toFixed(1) + "R" : "—"));
    k.appendChild(kpi("Longest losing streak", String(st.longest_losing_streak)));
    k.appendChild(kpi("Void / expired", st["void"] + " / " + st.expired));
    k.appendChild(kpi("Open trades · unrealised", st.open_public + " · " + fmtR(st.open_mtm_r, 1), signCls(st.open_mtm_r)));
    if (st.scratches) k.appendChild(kpi("Scratches (±0.1R)", String(st.scratches)));

    var tb = clear(document.querySelector("#bystrategy tbody"));
    var keys = Object.keys(st.by_strategy || {});
    if (!keys.length) { tb.appendChild(el("tr", null, [el("td", { colspan: 7, cls: "empty", text: "No closed trades yet." })])); return; }
    keys.forEach(function (name) {
      var g = st.by_strategy[name];
      tb.appendChild(el("tr", null, [
        td(name), td(String(g.n), "num"), td(fmtPct(g.win_rate), "num"),
        td(fmtR(g.expectancy), "num " + signCls(g.expectancy)), td(fmtR(g.net_r, 1), "num " + signCls(g.net_r)),
        td(g["void"] + " / " + g.expired, "num"),
        td(g.insufficient_data ? "insufficient data (< 30 trades)" : "", "muted small")
      ]));
    });
  }

  function renderEquity(eq) {
    var mtm = (eq.daily || []).map(function (r) { return [r[0], r[2]]; }).filter(function (p) { return isNum(p[1]); });
    var real = (eq.daily || []).length ? (eq.daily || []).map(function (r) { return [r[0], r[1]]; }) : (eq.realised || []);
    lineChart(document.getElementById("equity"), [
      { name: "Realised", points: real.filter(function (p) { return isNum(p[1]); }), color: "#22C55E" },
      { name: "Incl. open trades (MTM)", points: mtm, color: "#3B82F6", width: 1.5, dash: "4 3" }
    ], { label: "Cumulative R", empty: "The equity curve appears after the first closed trades." });
  }

  function renderSignalsTable(data) {
    var tb = clear(document.querySelector("#signals tbody"));
    var rows = data.signals || [];
    if (!rows.length) { tb.appendChild(el("tr", null, [el("td", { colspan: 7, cls: "empty", text: "No public signals yet. Zero signals is a valid outcome." })])); return; }
    rows.forEach(function (s) {
      var href = signalHref(s);
      var label = href ? el("a", { href: href, text: s.label }) : s.label;
      var revealed = !!s.display;
      tb.appendChild(el("tr", null, [
        el("td", null, [label]),
        td(revealed ? s.display : "committed — revealed after close", revealed ? "" : "muted"),
        td(revealed ? s.side : ""),
        el("td", null, [pill(s.status)]),
        td(s.status === "closed" ? fmtR(s.result_r) : (s.status === "open" ? "" : "0R"), "num " + signCls(s.result_r)),
        td(fmtDate(s.signal_ms)),
        td(s.exit_ms ? fmtDate(s.exit_ms) : "")
      ]));
    });
  }

  function dl(pairs) {
    var d = el("dl");
    pairs.forEach(function (p) { if (p) { d.appendChild(el("dt", { text: p[0] })); d.appendChild(el("dd", { text: p[1], cls: p[2] || "" })); } });
    return d;
  }

  function pctFrom(ref, x) {
    if (!isNum(ref) || !isNum(x) || ref === 0) return "";
    var v = (x / ref - 1) * 100;
    return " (" + (v > 0 ? "+" : "") + v.toFixed(1) + "%)";
  }

  function renderSignalDetail(s, site) {
    var c = clear(document.getElementById("detail"));
    document.getElementById("title").textContent = s.display ? (s.label + " · " + s.display + " " + s.side) : s.label;
    var sub = document.getElementById("subtitle");
    if (!s.display) {
      sub.textContent = "Committed in the ledger" + (s.commit_seq ? " (#" + s.commit_seq + ")" : "") + " at " + fmtDateTime(s.signal_ms) + ".";
      c.appendChild(el("div", { cls: "card" }, [el("p", null, ["Details of open trades are revealed after the trade closes. The commitment ",
        el("code", { text: String(s.ledger_ref || "") }), " is in the public ledger, so the reveal can be checked against it."])]));
      return;
    }
    sub.textContent = "Published " + fmtDateTime(s.signal_ms) + (s.revealed ? " · revealed after close" : " · open");
    var dec = s.decimals;
    var levels = dl([
      ["Status", s.status.toUpperCase() + (s.close_reason ? " (" + s.close_reason + ")" : "") + (s.void_reason ? " (" + s.void_reason + ")" : "")],
      ["Reference", fmtPrice(s.ref, dec)],
      ["Entry range", fmtPrice(s.entry_lo, dec) + " – " + fmtPrice(s.entry_hi, dec)],
      ["Valid until", fmtDateTime(s.valid_until_ms)],
      ["Initial stop", fmtPrice(s.stop_init, dec) + pctFrom(s.ref, s.stop_init)],
      isNum(s.tp1) ? ["TP1", fmtPrice(s.tp1, dec) + pctFrom(s.ref, s.tp1)] : null,
      isNum(s.tp2) ? ["TP2", fmtPrice(s.tp2, dec) + pctFrom(s.ref, s.tp2)] : null,
      ["Current stop", fmtPrice(s.stop, dec) + " (" + s.stop_kind + ")"],
      isNum(s.pending_stop) ? ["Pending stop", fmtPrice(s.pending_stop, dec) + " from " + fmtDateTime(s.pending_stop_from_ms)] : null
    ]);
    var outcome = dl([
      ["Tracked fill", isNum(s.fill) ? fmtPrice(s.fill, dec) + " · " + fmtDateTime(s.fill_ms) : "—"],
      s.revealed ? ["Result", fmtR(s.result_r), signCls(s.result_r)] : ["Mark-to-market", fmtR(s.mtm_r), signCls(s.mtm_r)],
      s.revealed ? ["Closed", fmtDateTime(s.exit_ms)] : null,
      isNum(s.hold_days) ? ["Held", s.hold_days.toFixed(1) + " days"] : null,
      isNum(s.mfe_r) && s.revealed ? ["Best / worst (MFE / MAE)", fmtR(s.mfe_r) + " / " + fmtR(s.mae_r)] : null,
      ["Strategy", s.strategy_id + " v" + s.strategy_version],
      s.delivery_failed ? ["Delivery", "not delivered (outage)", "down"] : null
    ]);
    c.appendChild(el("div", { cls: "grid2" }, [el("div", { cls: "card" }, [levels]), el("div", { cls: "card" }, [outcome])]));

    if (s.legs && s.legs.length) {
      c.appendChild(el("h2", { text: "Timeline" }));
      var tb = el("tbody");
      s.legs.forEach(function (l) {
        tb.appendChild(el("tr", null, [td(fmtDateTime(l.ms)), td(l.reason || ""), td(isNum(l.frac) ? (l.frac * 100).toFixed(0) + "%" : "", "num"),
          td(fmtPrice(l.price, dec), "num"), td(fmtR(l.r), "num " + signCls(l.r))]));
      });
      c.appendChild(el("div", { cls: "scroll" }, [el("table", { cls: "tbl" }, [
        el("thead", null, [el("tr", null, [el("th", { text: "Time" }), el("th", { text: "Exit" }), el("th", { cls: "num", text: "Size" }),
          el("th", { cls: "num", text: "Price" }), el("th", { cls: "num", text: "R (net)" })])]), tb])]));
    }

    var st = s.stats || {};
    var rec = "Family record at signal time: live " + st.n_live + " trades" + (isNum(st.exp_live) ? ", avg " + fmtR(st.exp_live) : "");
    if (isNum(st.n_bt)) rec += " · backtest (hypothetical, out-of-sample) " + fmtPct(st.wr_bt) + " wins, avg " + fmtR(st.exp_bt) + ", n=" + st.n_bt;
    c.appendChild(el("p", { cls: "muted small", text: rec }));

    var v = el("p", { cls: "small muted" }, ["Ledger: commit #" + (s.commit_seq || "?") + (s.reveal_seq ? ", reveal #" + s.reveal_seq : "") + " · ref ",
      el("code", { text: String(s.ledger_ref || "") }), " · ", el("a", { href: ROOT + "methodology.html#verify", text: "verify" })]);
    c.appendChild(v);
    if (s.card) {
      var img = el("img", { cls: "resultcard", src: ROOT + s.card, alt: "Result card " + s.label, loading: "lazy" });
      img.onerror = function () { img.remove(); };
      c.appendChild(img);
    }
  }

  function renderShadow(sh) {
    var tf = clear(document.querySelector("#shadowfam tbody"));
    var fams = Object.keys(sh.by_family || {});
    if (!fams.length) tf.appendChild(el("tr", null, [el("td", { colspan: 6, cls: "empty", text: "No closed shadow trades yet." })]));
    fams.forEach(function (f) {
      var g = sh.by_family[f];
      tf.appendChild(el("tr", null, [td(f), td(String(g.n), "num"), td(fmtPct(g.win_rate), "num"),
        td(fmtR(g.expectancy), "num " + signCls(g.expectancy)), td(fmtR(g.net_r, 1), "num " + signCls(g.net_r)), td(g["void"] + " / " + g.expired, "num")]));
    });
    var tt = clear(document.querySelector("#shadowtrades tbody"));
    (sh.trades || []).forEach(function (s) {
      tt.appendChild(el("tr", null, [td(s.label), td(s.display || ""), td(s.side || ""), td(s.strategy_id || ""),
        el("td", null, [pill(s.status)]), td(s.status === "closed" ? fmtR(s.result_r) : "0R", "num " + signCls(s.result_r)),
        td(fmtDate(s.fill_ms)), td(fmtDate(s.exit_ms))]));
    });
  }

  function renderMethodology(m) {
    var tb = clear(document.querySelector("#famtable tbody"));
    if (!(m.families || []).length) { tb.appendChild(el("tr", null, [el("td", { colspan: 9, cls: "empty", text: "No families qualified yet." })])); return; }
    m.families.forEach(function (f) {
      var pmb = isNum(f.plan_minus_baseline) ? fmtR(f.plan_minus_baseline) : "—";
      if (Array.isArray(f.plan_minus_baseline_ci) && f.plan_minus_baseline_ci.length === 2) {
        pmb += " [" + fmtNum(f.plan_minus_baseline_ci[0]) + ", " + fmtNum(f.plan_minus_baseline_ci[1]) + "]";
      }
      var tdv = f.tracking_divergence;
      var tds = tdv && isNum(tdv.mean) ? fmtR(tdv.mean, 3) : "—";
      tb.appendChild(el("tr", null, [td(f.family_id), td(f.state || ""),
        td(isNum(f.p95_dd_1y) ? "−" + f.p95_dd_1y.toFixed(1) + "R" : "—", "num"),
        td(fmtPct(f.p_negative_year), "num"), td(pmb, "num"), td(fmtNum(f.pbo), "num"),
        td((isNum(f.losing_streak_bt) ? String(f.losing_streak_bt) : "—") + " / " + f.losing_streak_live, "num"),
        td(String(f.n_live), "num"), td(tds, "num")]));
    });
  }

  function queryNo() {
    var n = body.getAttribute("data-no");
    if (n) return parseInt(n, 10);
    var m = /[?&]no=(\d+)/.exec(window.location.search);
    return m ? parseInt(m[1], 10) : null;
  }

  // ------------------------------------------------------------------ boot
  var sitePromise = getJSON("site.json").then(function (site) { renderSite(site); return site; }, function () { return {}; });

  if (PAGE === "index") {
    getJSON("stats.json").then(renderStats, function (e) { showError(document.getElementById("kpis"), e); });
    getJSON("equity.json").then(renderEquity, function (e) { showError(document.getElementById("equity"), e); });
    getJSON("signals.json").then(renderSignalsTable, function (e) { showError(document.querySelector("#signals tbody"), e); });
  } else if (PAGE === "signal") {
    var no = queryNo();
    Promise.all([getJSON("signals.json"), sitePromise]).then(function (res) {
      var s = (res[0].signals || []).filter(function (x) { return x.no === no; })[0];
      if (!s) { clear(document.getElementById("detail")).appendChild(el("div", { cls: "empty", text: "Signal #" + no + " is not in the public record." })); return; }
      renderSignalDetail(s, res[1]);
    }, function (e) { showError(document.getElementById("detail"), e); });
  } else if (PAGE === "shadow") {
    getJSON("shadow.json").then(renderShadow, function (e) { showError(document.querySelector("#shadowfam tbody"), e); });
  } else if (PAGE === "methodology") {
    getJSON("methodology.json").then(renderMethodology, function (e) { showError(document.querySelector("#famtable tbody"), e); });
  }
})();
