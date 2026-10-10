const state = { documents: [], selected: null, trace: null, legalActs: [] };
const graphState = { positions: {}, dragging: null };
const $ = (selector) => document.querySelector(selector);
const documentList = $("#document-list");

documentList.addEventListener("click", (event) => {
  const toggle = event.target.closest(".toggle");
  if (!toggle) return;
  event.stopPropagation();
  selectDocument(toggle.closest(".document-card").dataset.id);
});

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Помилка запиту");
  return payload;
}

function titleFor(document) {
  return document.notes ? document.notes.split(".")[0] : document.name;
}

function renderDocuments(documents = state.documents) {
  const list = $("#document-list");
  list.innerHTML = documents.length ? documents.map((document) => `
    <article class="document-card ${state.selected?.id === document.id ? "selected" : ""}" data-id="${document.id}">
      <div class="document-summary">
        <button
          class="toggle"
          type="button"
          aria-expanded="${state.selected?.id === document.id}"
          aria-label="${state.selected?.id === document.id ? "Згорнути документ" : "Розгорнути документ"}"
        >${state.selected?.id === document.id ? "−" : "+"}</button>
        <div><strong>${escapeHtml(titleFor(document))}</strong>
        <small>${escapeHtml(document.name)}</small></div>
      </div>
      ${state.selected?.id === document.id ? `<div class="document-extra">
        <p><b>Назва файлу:</b><span>${escapeHtml(document.name)}</span></p>
        <p><b>Вид документа:</b><span>${escapeHtml(document.legalType || "—")}</span></p>
        <p><b>Ключові слова:</b><span>${escapeHtml(document.keywords || "—")}</span></p>
        <p><b>Опис:</b><span>${escapeHtml(document.notes || "Опис відсутній")}</span></p>
        <div class="links"><a href="${escapeHtml(document.recognizedDocument || "#")}" target="_blank">Розпізнаний документ ↗</a>
        <a href="${escapeHtml(document.sourceDocument || "#")}" target="_blank">Оригінал документа ↗</a></div>
      </div>` : ""}
    </article>`).join("") : '<div class="empty">Нічого не знайдено</div>';
  list.querySelectorAll(".document-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      if (event.target.closest(".toggle")) return;
      selectDocument(card.dataset.id);
    });
  });
}

async function selectDocument(id) {
  const document = state.documents.find((item) => item.id === id);
  if (!document) return;
  if (state.selected?.id === id) {
    state.selected = null;
    state.trace = null;
    renderDocuments();
    renderGraph();
    return;
  }
  state.selected = document;
  try {
    state.trace = await request(`/api/trace/${encodeURIComponent(id)}`);
    renderDocuments();
    renderGraph();
  } catch (error) {
    showToast(error.message);
  }
}

function renderGraph() {
  const document = state.selected;
  if (!document) {
    $("#graph").innerHTML = '<div class="graph-empty">Оберіть документ, щоб побачити його трасування</div>';
    return;
  }
  const docWidth = 215, keywordWidth = 250, actWidth = 330;
  const keywords = state.trace?.keywords || document.keywordsList || [];
  const acts = state.trace?.legalActs || (state.trace?.legalAct ? [state.trace.legalAct] : []);
  const width = 1040, height = Math.max(560, 180 + Math.max(keywords.length, acts.length) * 55);
  const nodeHeight = 88;
  const docId = "document";
  const keywordNodes = keywords.slice(0, 10).map((keyword, index) => ({
    id: `keyword-${index}`, label: keyword, kind: "keyword", width: keywordWidth,
    height: 34, x: 300, y: 32 + index * 46,
  }));
  const actNodes = acts.map((act, index) => ({
    id: `act-${index}`, label: act.title || act.label || "Правовий акт", kind: "act",
    width: actWidth, height: nodeHeight, x: 650, y: 70 + index * 118,
  }));
  const nodes = [
    { id: docId, label: document.name, secondary: titleFor(document), kind: "document",
      width: docWidth, height: nodeHeight, x: 18, y: Math.max(180, height / 2 - 44) },
    ...keywordNodes,
    ...actNodes,
  ];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (graphState.positions.documentId !== document.id) {
    graphState.positions = {};
    graphState.positions.documentId = document.id;
  }
  nodes.forEach((node) => {
    const position = graphState.positions[node.id];
    if (position) {
      node.x = position.x;
      node.y = position.y;
    }
  });
  const edges = [
    ...keywordNodes.map((node) => ({ source: docId, target: node.id, kind: "keyword" })),
    ...actNodes.map((node) => ({ source: docId, target: node.id, kind: "act" })),
  ];
  const shortText = (value, length = 28) => {
    const text = String(value || "");
    return escapeHtml(text.length > length ? `${text.slice(0, length - 1)}…` : text);
  };
  const nodeText = (node) => {
    if (node.kind === "document") {
      return `<text x="48" y="29">▤</text>${svgText(node.label, 48, 51, 20)}
        ${svgText(node.secondary, 48, 70, 18)}<text class="subtext" x="48" y="84">Документ</text>`;
    }
    if (node.kind === "act") {
      return `<text x="16" y="37" font-size="18">⚖</text>${svgText(node.label, 48, 37, 34)}
        <text class="subtext" x="48" y="61">Правовий акт</text>`;
    }
    return svgText(node.label, 14, 22, 28);
  };
  const svgText = (value, x, y, length = 28) => (
    `<text x="${x}" y="${y}">${shortText(value, length)}</text>`
  );
  const nodeMarkup = nodes.map((node) => {
    const fill = node.kind === "act" ? "#fff0dd" : "#e5f2ff";
    const stroke = node.kind === "act" ? "#f4a244" : node.kind === "document" ? "#67aef2" : "#82bdf2";
    return `<g class="node graph-node" data-node-id="${node.id}" transform="translate(${node.x},${node.y})">
      <rect width="${node.width}" height="${node.height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
      ${nodeText(node)}</g>`;
  }).join("");
  $("#graph").innerHTML = `<svg class="graph-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#72b3f0"/></marker>
    <marker id="arrow-act" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#f7a33d"/></marker></defs>
    <g class="graph-edges">${edges.map((edge, index) => `<path class="edge ${edge.kind === "act" ? "act" : ""}" data-edge-index="${index}"/>`).join("")}</g>
    ${nodeMarkup}
  </svg>`;
  const svg = $("#graph svg");
  const edgeElements = [...svg.querySelectorAll("[data-edge-index]")];
  const redrawEdges = () => edgeElements.forEach((element, index) => {
    const edge = edges[index];
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const start = anchorPoint(source, target);
    const end = anchorPoint(target, source);
    const bend = Math.max(45, Math.abs(end.x - start.x) * 0.42);
    element.setAttribute("d", `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`);
  });
  const updateNode = (node) => {
    svg.querySelector(`[data-node-id="${node.id}"]`).setAttribute("transform", `translate(${node.x},${node.y})`);
    graphState.positions[node.id] = { x: node.x, y: node.y };
    redrawEdges();
  };
  svg.querySelectorAll(".graph-node").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      const node = nodeById.get(element.dataset.nodeId);
      const point = svgPoint(svg, event);
      graphState.dragging = { node, offsetX: point.x - node.x, offsetY: point.y - node.y };
      element.setPointerCapture(event.pointerId);
      element.classList.add("dragging");
    });
    element.addEventListener("pointermove", (event) => {
      if (!graphState.dragging || graphState.dragging.node.id !== element.dataset.nodeId) return;
      const point = svgPoint(svg, event);
      const { node, offsetX, offsetY } = graphState.dragging;
      node.x = Math.max(0, Math.min(width - node.width, point.x - offsetX));
      node.y = Math.max(0, Math.min(height - node.height, point.y - offsetY));
      updateNode(node);
    });
    element.addEventListener("pointerup", (event) => {
      graphState.dragging = null;
      element.releasePointerCapture(event.pointerId);
      element.classList.remove("dragging");
    });
  });
  redrawEdges();
}

function svgPoint(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function anchorPoint(node, other) {
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const dx = other.x + other.width / 2 - center.x;
  const dy = other.y + other.height / 2 - center.y;
  const scale = 1 / Math.max(Math.abs(dx) / (node.width / 2), Math.abs(dy) / (node.height / 2), 1);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

async function load() {
  const graph = await request("/api/graph");
  state.documents = graph.documents;
  state.legalActs = graph.legalActs;
  renderDocuments();
  renderGraph();
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

$("#search").addEventListener("input", async (event) => {
  const result = await request(`/api/documents?q=${encodeURIComponent(event.target.value)}`);
  renderDocuments(result.documents);
});
$("#rdf-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append("file", file);
    await request("/api/upload", { method: "POST", body: form });
    showToast("RDF успішно завантажено");
    await load();
  } catch (error) { showToast(error.message); }
});
function showToast(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.add("visible"); setTimeout(() => toast.classList.remove("visible"), 3000); }
load().catch((error) => showToast(error.message));
