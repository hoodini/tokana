const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tk = (n) => {
  n = n ?? 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const BUCKETS = [
  { key: "uncached", css: "--uncached", label: "uncached input", mult: "1×" },
  { key: "cc5m", css: "--cc5m", label: "cache write 5m", mult: "1.25×" },
  { key: "cc1h", css: "--cc1h", label: "cache write 1h", mult: "2×" },
  { key: "cacheRead", css: "--cacheRead", label: "cache read", mult: "0.1×" },
  { key: "output", css: "--output", label: "output", mult: "out" },
];

async function loadSummary() {
  const s = await (await fetch("/api/summary")).json();
  const g = s.grand;
  const savedPct = g.costNoCache ? (100 * g.savings) / g.costNoCache : 0;

  $("#cards").innerHTML = [
    card("Total tokens", tk(g.totalTokens), `${fmt(g.turns)} turns across all tools`),
    card("List cost (API-equivalent)", usd(g.costList), `what this would cost on the API`, "hero"),
    card("Saved by caching", usd(g.savings), `${savedPct.toFixed(0)}% off vs no cache`, "save"),
    card("Cache-read tokens", tk(g.cacheRead), `served cheap at 0.1× — ${((100 * g.cacheRead) / g.totalTokens).toFixed(0)}% of all tokens`),
    card("Output tokens", tk(g.output), `the expensive ones (75× cache-read)`),
  ].join("");

  // billing bar
  const total = BUCKETS.reduce((a, b) => a + (g[b.key] || 0), 0) || 1;
  $("#billing-bar").innerHTML = BUCKETS.map(
    (b) => `<span style="width:${(100 * (g[b.key] || 0)) / total}%;background:var(${b.css})" title="${b.label}: ${fmt(g[b.key])}"></span>`,
  ).join("");
  $("#billing-legend").innerHTML = BUCKETS.map(
    (b) =>
      `<span class="item"><span class="sw" style="background:var(${b.css})"></span>${b.label} <span class="mult">(${b.mult})</span> <b>${tk(g[b.key])}</b></span>`,
  ).join("");

  $("#by-model").innerHTML = tableFrom(
    ["model", "turns", "tokens", "cost"],
    s.byModel.map((m) => [esc(m.model), fmt(m.turns), tk(m.tokens), usd(m.costList)]),
    [false, true, true, true],
  );
  $("#by-project").innerHTML = tableFrom(
    ["project", "turns", "tokens", "cost"],
    s.byProject.map((m) => [shortPath(m.project), fmt(m.turns), tk(m.totalTokens), usd(m.costList)]),
    [false, true, true, true],
  );

  const maxDay = Math.max(...s.byDay.map((d) => d.costList), 0.0001);
  $("#by-day").innerHTML = s.byDay
    .slice()
    .reverse()
    .map(
      (d) =>
        `<div class="day" style="height:${(100 * d.costList) / maxDay}%" data-t="${d.day}: ${usd(d.costList)} · ${tk(d.totalTokens)} tok · ${d.turns} turns"></div>`,
    )
    .join("");
}

function card(label, value, sub, cls = "") {
  return `<div class="card ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}
function shortPath(p) {
  if (!p) return "(unknown)";
  return esc(p.replace(/^\/Users\/[^/]+\//, "~/"));
}
function tableFrom(headers, rows, nums = []) {
  const th = headers.map((h, i) => `<th class="${nums[i] ? "num" : ""}">${h}</th>`).join("");
  const tr = rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${nums[i] ? "num" : ""}">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

async function loadSessions() {
  const rows = await (await fetch("/api/sessions?limit=60")).json();
  const table = document.createElement("table");
  table.innerHTML =
    `<thead><tr><th>session</th><th>project</th><th></th><th class="num">turns</th><th class="num">tokens</th><th class="num">cache-read</th><th class="num">cost</th><th class="num">saved</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "click";
    tr.innerHTML = `<td class="mono">${r.session_id.slice(0, 8)}</td>
      <td>${shortPath(r.project)}</td>
      <td>${r.is_sidechain ? '<span class="pill side">subagent</span>' : ""}</td>
      <td class="num">${fmt(r.turns)}</td>
      <td class="num">${tk(r.totalTokens)}</td>
      <td class="num">${tk(r.cacheRead)}</td>
      <td class="num">${usd(r.costList)}</td>
      <td class="num" style="color:var(--green)">${usd((r.costNoCache || 0) - (r.costList || 0))}</td>`;
    tr.onclick = () => openSession(r.session_id, r.project);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  $("#sessions").innerHTML = "";
  $("#sessions").appendChild(table);
}

async function openSession(id, project) {
  const turns = await (await fetch("/api/session/" + encodeURIComponent(id))).json();
  $("#drill").classList.remove("hidden");
  $("#drill-title").textContent = `Session ${id.slice(0, 8)} — ${shortPath(project)} · ${turns.length} turns`;
  const table = document.createElement("table");
  table.innerHTML =
    `<thead><tr><th>time</th><th>model</th><th class="num">uncached</th><th class="num">cache-wr</th><th class="num">cache-rd</th><th class="num">output</th><th class="num">total in</th><th class="num">cost</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const t of turns) {
    const tr = document.createElement("tr");
    tr.className = "click";
    tr.innerHTML = `<td class="mono">${(t.ts || "").slice(11, 19)}</td>
      <td>${esc(t.model.replace("claude-", ""))}</td>
      <td class="num">${fmt(t.uncached)}</td>
      <td class="num">${fmt(t.cc5m + t.cc1h)}</td>
      <td class="num">${fmt(t.cache_read)}</td>
      <td class="num">${fmt(t.output)}</td>
      <td class="num">${fmt(t.total_input)}</td>
      <td class="num">${usd(t.cost_list)}</td>`;
    tr.onclick = () => openAttribution(t.message_id);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  $("#turns").innerHTML = "";
  $("#turns").appendChild(table);
  $("#drill").scrollIntoView({ behavior: "smooth" });
}

// Forensics segments — the anatomy of one turn's input, in narrative order.
const SEGMENTS = [
  { key: "currentMessage", cat: "msg", label: "your message", css: "--seg-msg", ico: "✍️" },
  { key: "history", cat: "history", label: "history", css: "--seg-history", ico: "💬" },
  { key: "toolResults", cat: "tools", label: "tool results", css: "--seg-tools", ico: "🔧" },
  { key: "thinking", cat: "thinking", label: "thinking", css: "--seg-thinking", ico: "🧠" },
  { key: "files", cat: "files", label: "files", css: "--seg-files", ico: "📎" },
  { key: "systemToolsBaseline", cat: "baseline", label: "system + tools baseline", css: "--seg-baseline", ico: "🏗️" },
];
const CAT_META = {
  msg: { label: "your message", css: "--seg-msg" },
  history: { label: "conversation history", css: "--seg-history" },
  tools: { label: "tool results", css: "--seg-tools" },
  thinking: { label: "thinking", css: "--seg-thinking" },
  files: { label: "files / attachments", css: "--seg-files" },
};
function catOf(it) {
  if (it.kind === "baseline") return "baseline";
  if (it.label === "your message (this turn)") return "msg";
  if (it.kind === "tool_result") return "tools";
  if (it.kind === "thinking") return "thinking";
  if (it.kind === "file") return "files";
  return "history"; // user + assistant history text
}

async function openAttribution(messageId) {
  const r = await (await fetch(`/api/turn/${encodeURIComponent(messageId)}/attribution`)).json();
  $("#attr").classList.remove("hidden");
  if (r.error) {
    $("#attr-body").innerHTML = `<div class="note">Could not run forensics: ${esc(r.error)}</div>`;
    return;
  }
  const a = r.attribution;
  const total = r.totalInput || 1;
  const pc = (v) => (100 * (v || 0)) / total;
  const segVals = SEGMENTS.map((s) => ({ ...s, v: a[s.key] || 0, pct: pc(a[s.key]) }));
  const msgPct = pc(a.currentMessage);

  // 1. VERDICT — the one-sentence finding
  const dominant = segVals.slice().sort((x, y) => y.v - x.v)[0];
  const verdict =
    `This turn sent <b>${fmt(r.totalInput)}</b> tokens to ${esc(r.model.replace("claude-", ""))}. ` +
    (dominant.cat === "baseline"
      ? `<b>${dominant.pct.toFixed(0)}%</b> was standing scaffolding you re-send every turn — your message was just <b>${msgPct.toFixed(1)}%</b>.`
      : `Its largest slice was <b>${esc(dominant.label)}</b> at <b>${dominant.pct.toFixed(0)}%</b>.`);

  // 2. GAUGE — the context window as one fuel bar
  const shown = segVals.filter((s) => s.v > 0);
  const gauge = shown
    .map(
      (s) =>
        `<span style="width:${Math.max(0.4, s.pct)}%;background:var(${s.css})" title="${esc(s.label)}: ${fmt(s.v)} (${s.pct.toFixed(1)}%)">${s.pct >= 7 ? `<small>${s.pct.toFixed(0)}%</small>` : ""}</span>`,
    )
    .join("");
  const gaugeLegend = shown
    .map(
      (s) =>
        `<span class="gi"><span class="sw" style="background:var(${s.css})"></span>${s.ico} ${esc(s.label)} <b>${tk(s.v)}</b> · ${s.pct.toFixed(0)}%</span>`,
    )
    .join("");

  // 3. LEVERS — auto-generated "what you could do about it"
  const cacheReadPct = r.billing ? (100 * (r.billing.cacheRead || 0)) / total : 0;
  const biggest = (r.items || []).filter((it) => it.inLogs).sort((x, y) => y.tokens - x.tokens)[0];
  const levers = [
    {
      accent: "--seg-baseline", ico: "🏗️", big: `${pc(a.systemToolsBaseline).toFixed(0)}%`,
      cap: `<b>${fmt(a.systemToolsBaseline)}</b> tokens of system prompt + tool/MCP/skill schemas + memory, re-sent every turn. Your biggest lever: trim MCP servers &amp; skills you don't need here.`,
    },
    {
      accent: "--seg-msg", ico: "✍️", big: `${msgPct.toFixed(1)}%`,
      cap: `<b>${fmt(a.currentMessage)}</b> tokens — the part you actually typed this turn.`,
    },
    {
      accent: "--seg-tools", ico: "💾", big: `${cacheReadPct.toFixed(0)}%`,
      cap: `of this turn's input was served from cache at <b>0.1×</b> price.${biggest ? ` Largest single block: ${esc(biggest.label)} (${fmt(biggest.tokens)} tok).` : ""}`,
    },
  ]
    .map(
      (l) =>
        `<div class="lever" style="--accent:var(${l.accent})"><div class="ico">${l.ico}</div><div class="big">${l.big}</div><div class="cap">${l.cap}</div></div>`,
    )
    .join("");

  // 4. EVIDENCE — the actual content, grouped by category, biggest first
  const items = (r.items || []).filter((it) => it.inLogs);
  const groups = ["msg", "tools", "files", "history", "thinking"]
    .map((cat) => {
      const list = items.filter((it) => catOf(it) === cat).sort((x, y) => y.tokens - x.tokens);
      if (!list.length) return "";
      const m = CAT_META[cat];
      const groupTok = list.reduce((s, it) => s + it.tokens, 0);
      const rows = list
        .map((it) => {
          const preview = esc((it.text || "").slice(0, 100).replace(/\s+/g, " ")) || "(empty)";
          const meta = `${fmt(it.chars)} chars${it.truncated ? " · truncated" : ""}`;
          return `<details class="citem">
            <summary>
              <span class="ck">${preview}</span>
              <span class="ctok">${fmt(it.tokens)} tok</span>
              <span class="cmeta">${esc(meta)}</span>
            </summary>
            <pre class="content">${esc(it.text) || "(empty)"}</pre>
          </details>`;
        })
        .join("");
      return `<div class="egroup">
        <div class="egroup-h"><span class="sw" style="background:var(${m.css});color:var(${m.css})"></span>${esc(m.label)}<span class="gt">${list.length} block${list.length > 1 ? "s" : ""} · ${tk(groupTok)} tok</span></div>
        ${rows}
      </div>`;
    })
    .join("");

  const warn = a.unreliable
    ? `<div class="note">⚠ This turn's split is unreliable: the proxy tokenizer counted ${fmt(a.overcounted)} more visible tokens than the exact input — usually prior extended-thinking that was stripped on resend. The baseline is shown as 0 rather than a fabricated number; the billing totals are still exact.</div>`
    : "";
  const baselineNote = `<div class="note baseline-note">🏗️ The <b>baseline</b> has no readable content because Claude Code doesn't store the system prompt or tool schemas in the transcript. Its size is the honest residual — total input minus everything visible above.</div>`;

  $("#attr-body").innerHTML =
    `<p class="forensic-verdict">${verdict}</p>` +
    `<p class="forensic-sub">turn ${esc(messageId.slice(0, 14))} · tokenizer ${esc(r.tokenizer || "")}</p>` +
    `<div class="gauge-wrap"><div class="gauge">${gauge}</div><div class="gauge-legend">${gaugeLegend}</div></div>` +
    warn +
    `<div class="levers">${levers}</div>` +
    `<h3 class="evidence-h">The evidence <small>the actual context that was tokenized — click any block to read it</small></h3>` +
    groups +
    baselineNote;
  $("#attr").scrollIntoView({ behavior: "smooth" });
}

function connectLive() {
  const es = new EventSource("/api/live");
  es.addEventListener("turn", (e) => {
    const d = JSON.parse(e.data);
    $("#live").classList.add("on");
    $("#live-text").innerHTML =
      `live · ${esc(d.model.replace("claude-", ""))} · turn ${d.turns} · ` +
      `<b>${tk(d.turn.totalInput)}</b> in / <b>${fmt(d.turn.billing.output)}</b> out · session ${usd(d.session.costList)}`;
  });
  es.onerror = () => $("#live").classList.remove("on");
}

loadSummary();
loadSessions();
if (!location.search.includes("nolive")) {
  connectLive();
  setInterval(loadSummary, 20000);
}
// deep-link straight to a turn's forensics: /?turn=<message_id> (focuses on just that panel)
const _turn = new URLSearchParams(location.search).get("turn");
if (_turn) {
  document.querySelectorAll("body > section, body > .two-col, #cards").forEach((el) => {
    if (el.id !== "attr") el.style.display = "none";
  });
  openAttribution(_turn);
}
