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

const ATTR = [
  { key: "currentMessage", label: "your message (this turn)", css: "--pink" },
  { key: "history", label: "conversation history", css: "--output" },
  { key: "toolResults", label: "tool results (file reads, output)", css: "--cyan" },
  { key: "thinking", label: "thinking blocks", css: "--cc5m" },
  { key: "files", label: "file attachments", css: "--green" },
  { key: "systemToolsBaseline", label: "system + tools + MCP + skills (residual)", css: "--yellow" },
];

const KIND_CSS = {
  "your message (this turn)": "--pink",
  baseline: "--yellow",
  tool_result: "--cyan",
  thinking: "--cc5m",
  file: "--green",
  user: "--output",
  assistant: "--output",
};

async function openAttribution(messageId) {
  const r = await (await fetch(`/api/turn/${encodeURIComponent(messageId)}/attribution`)).json();
  $("#attr").classList.remove("hidden");
  if (r.error) {
    $("#attr-body").innerHTML = `<div class="note">Could not attribute: ${esc(r.error)}</div>`;
    return;
  }
  const a = r.attribution;
  const total = r.totalInput || 1;
  const rows = ATTR.map((c) => {
    const v = a[c.key] || 0;
    const pct = Math.min(100, (100 * v) / total);
    return `<div class="attr-row">
      <div class="k">${c.label}</div>
      <div class="bar" style="width:${Math.max(0.5, pct)}%;background:var(${c.css})"></div>
      <div class="v">${fmt(v)} · ${pct.toFixed(0)}%</div>
    </div>`;
  }).join("");
  const warn = a.unreliable
    ? `<div class="note">⚠ This turn's split is unreliable: the proxy tokenizer counted ${fmt(a.overcounted)} more visible tokens than the exact input. That usually means prior extended-thinking was stripped on resend (it sits in the transcript but isn't re-billed), so the baseline is shown as 0 rather than a fabricated number. The billing totals above are still exact.</div>`
    : "";

  // The actual content of every context segment — baseline first (the big one), then context order.
  const items = (r.items || [])
    .slice()
    .sort((x, y) => (x.kind === "baseline" ? -1 : y.kind === "baseline" ? 1 : x.order - y.order));
  const content = items
    .map((it) => {
      const css = KIND_CSS[it.label] || KIND_CSS[it.kind] || "--muted";
      const pct = ((100 * it.tokens) / total).toFixed(1);
      const meta = it.inLogs
        ? `${fmt(it.chars)} chars${it.truncated ? " (truncated)" : ""} · ${(it.ts || "").slice(11, 19)}`
        : `content not stored in logs`;
      const body = it.inLogs
        ? `<pre class="content">${esc(it.text) || "(empty)"}</pre>`
        : `<div class="note">This is the standing scaffolding (system prompt + tool/MCP/skill schemas + memory). Claude Code does not write it into the transcript, so there is no text to show — its size is inferred as the residual: total input minus everything visible above.</div>`;
      return `<details class="citem" ${it.kind === "baseline" ? "open" : ""}>
        <summary>
          <span class="badge" style="background:var(${css})"></span>
          <span class="ck">${esc(it.label)}</span>
          <span class="ctok">${fmt(it.tokens)} tok · ${pct}%</span>
          <span class="cmeta">${esc(meta)}</span>
        </summary>
        ${body}
      </details>`;
    })
    .join("");

  $("#attr-body").innerHTML =
    `<p class="mono" style="color:var(--muted)">Turn ${esc(messageId.slice(0, 12))} · ${esc(r.model)} · ${fmt(r.totalInput)} input tokens sent · tokenizer: ${esc(r.tokenizer || "")}</p>` +
    rows +
    warn +
    `<h3 class="content-h">The actual context that was tokenized <small>click any block to read it</small></h3>` +
    content +
    `<div class="note">${esc(r.note)}</div>`;
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
connectLive();
setInterval(loadSummary, 20000);
