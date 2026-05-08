import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "ShowMe.CanvasAnnotations";
const STORE_KEY = "showme_annotations";
const LOCAL_CACHE_PREFIX = "showme:annotations:";
const PROVIDER_PREF_KEY = "showme:provider-prefs";
const PANEL_LAYOUT_KEY = "showme:panel-layout";
const DEBUG_KEY = "showme:debug";
const CSS_ID = "showme-stylesheet";
const CSS_URL = new URL("./showme.css", import.meta.url).href;
const MAX_HISTORY = 40;
const OVERLAY_Z_INDEX = "20";
const DEFAULT_ASK_FETCH_TIMEOUT_MS = 210000;
const DEFAULT_COLOR = "#ffcc4d";
const SWATCHES = ["#ffcc4d", "#59d7c7", "#ff6f61", "#8ec5ff", "#b68cff", "#f5f7fb"];
const ASK_COLORS = ["#59d7c7", "#ffcc4d", "#b68cff", "#8ec5ff", "#ff6f61", "#f5f7fb"];
const PLAN_COLORS = [
  "#59d7c7",
  "#ffcc4d",
  "#ff6f61",
  "#8ec5ff",
  "#b68cff",
  "#7ee787",
  "#ff9f43",
  "#e879f9",
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#fb7185",
];
const COMPACT_STEP_LABEL_THRESHOLD = 4;
const SELECTION_HIT_PIXELS = 18;
const SELECTION_STROKE_HIT_PIXELS = 22;
const SELECTION_LABEL_PAD_PIXELS = 10;
const SELECTION_MAX_GRAPH_RADIUS = 96;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function canvasScale() {
  return Math.max(0.1, Number(app.canvas?.ds?.scale) || 1);
}

function graphPixelSize(pixelValue, maxGraphValue = SELECTION_MAX_GRAPH_RADIUS) {
  return Math.min(maxGraphValue, Math.max(4, Number(pixelValue) / canvasScale()));
}

function selectionHitRadius(kind = "object") {
  if (kind === "stroke" || kind === "arrow") return graphPixelSize(SELECTION_STROKE_HIT_PIXELS);
  if (kind === "label") return graphPixelSize(SELECTION_LABEL_PAD_PIXELS, 64);
  return graphPixelSize(SELECTION_HIT_PIXELS);
}

function hexToRgb(hex) {
  const raw = String(hex || "").trim();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToHex(rgb) {
  const [r, g, b] = rgb.map((channel) => clamp(Math.round(channel), 0, 255));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function rgbToHsl(rgb) {
  const [r, g, b] = rgb.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / delta + 2) / 6;
    else h = ((r - g) / delta + 4) / 6;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1) + 1e-12);
  return [h, s, l];
}

function hslToRgb(hsl) {
  const [h, s, l] = hsl;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  const segment = h * 6;
  if (segment < 1) [rp, gp, bp] = [c, x, 0];
  else if (segment < 2) [rp, gp, bp] = [x, c, 0];
  else if (segment < 3) [rp, gp, bp] = [0, c, x];
  else if (segment < 4) [rp, gp, bp] = [0, x, c];
  else if (segment < 5) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
}

function askPlanToneColor(baseColor, toneIndex) {
  const rgb = hexToRgb(baseColor);
  if (!rgb) return baseColor;
  const hsl = rgbToHsl(rgb);
  const cycle = ((Number(toneIndex) || 0) % 5) - 2;
  const nextL = clamp(hsl[2] + cycle * 0.045, 0.12, 0.92);
  const nextS = clamp(hsl[1] + cycle * 0.02, 0.08, 0.95);
  return rgbToHex(hslToRgb([hsl[0], nextS, nextL]));
}

function planPaletteColor(seed, toneIndex = 0) {
  const numeric = Number.isFinite(Number(seed))
    ? Math.abs(Number(seed))
    : Number.parseInt(hashString(String(seed ?? "")), 36);
  const index = Math.abs(numeric || 0) % PLAN_COLORS.length;
  return askPlanToneColor(PLAN_COLORS[index], toneIndex);
}
const ASK_PRESETS = [
  { label: "Overview", prompt: "Create a high-level overview map of this workflow in 3-5 stages. Draw only the main generation path and skip helper, parameter, and duplicate nodes.", mode: "draw_steps" },
  { label: "Every node", prompt: "Explain every visible node one by one. Add a compact label to each node; do not summarize stages and do not skip helper or parameter nodes.", mode: "draw_all_nodes" },
  { label: "Build order", prompt: "Number the build and execution order from model, text, or image inputs through processing to final output. Prioritize dependency order over a high-level summary.", mode: "draw_steps" },
  { label: "Connect nodes", prompt: "How should I connect all nodes in this workflow? Draw arrows for the recommended links using existing node ids and exact slot names.", mode: "freeform" },
  { label: "Selected path", prompt: "Trace the path through the selected node, including key inputs and outputs.", mode: "draw_steps" },
  { label: "Output targets", prompt: "Show where the selected node outputs go.", mode: "draw_connections" },
  { label: "Input sources", prompt: "Show what feeds into the selected node.", mode: "draw_connections" },
  { label: "Prompt nodes", prompt: "Find the positive and negative prompt nodes and explain how they affect the output.", mode: "lookup_focus" },
  { label: "Diagnostics", prompt: "Find invalid, disconnected, redundant, or suspicious workflow settings.", mode: "diagnostics" },
  { label: "Selected node", prompt: "Explain the selected node, its role, and what would change if it were adjusted.", mode: "answer_only" },
];

const RENDER = {
  LABEL_FONT_BASE: 13,
  LABEL_FONT_MIN: 10,
  LABEL_FONT_MAX: 16,
  LABEL_BG: "rgba(12, 14, 18, 0.86)",
  LABEL_MAX_WIDTH: 390,
  BADGE_FONT_BASE: 14,
  BADGE_FONT_MIN: 12,
  BADGE_FONT_MAX: 18,
  NODE_HEADER_OFFSET: 28,
  HIGHLIGHT_OPACITY: 0.72,
  BADGE_OPACITY: 0.96,
  LABEL_OPACITY: 0.94,
  COMPACT_LABEL_MAX_CHARS: 28,
  COMPACT_LABEL_FONT_BASE: 11,
  COMPACT_LABEL_MAX_WIDTH: 250,
};
const AI_STYLE_DEFAULT_SIZE = 6;
const AI_STYLE_DEFAULT_OPACITY = 0.92;

const state = {
  toolbar: null,
  installed: false,
  open: false,
  active: false,
  visible: true,
  tool: "brush",
  color: DEFAULT_COLOR,
  size: 6,
  opacity: 0.92,
  pointerId: null,
  isDrawing: false,
  currentStroke: null,
  currentObject: null,
  shapeStart: null,
  undoStack: [],
  redoStack: [],
  gestureChanged: false,
  askBusy: false,
  askAbortController: null,
  askRunId: 0,
  askMessage: "",
  askColorIndex: 0,
  presetOpen: false,
  askMode: "freeform",
  askPresetPrompt: "",
  provider: "",
  model: "",
  providers: [],
  askFetchTimeoutMs: DEFAULT_ASK_FETCH_TIMEOUT_MS,
  overlayCanvas: null,
  installedListeners: [],
  restoreCanvasDrawForeground: null,
  toolbarRefs: null,
  panelPos: null,
  collapsed: false,
  askSectionOpen: false,
  dockObserver: null,
  hoverObjectId: "",
  pinnedObjectId: "",
  compactAiStepLabels: false,
  textEditor: null,
  selectedTarget: null,
  activeMove: null,
  hoverSelectable: false,
  suppressNextClick: false,
};

function trackListener(target, event, handler, options) {
  if (!target?.addEventListener) return;
  target.addEventListener(event, handler, options);
  state.installedListeners.push({ target, event, handler, options });
}

function clonePoint(point) {
  return [Number(point[0]) || 0, Number(point[1]) || 0];
}

function cloneStroke(stroke) {
  return {
    id: String(stroke.id || cryptoRandomId()),
    tool: "brush",
    color: String(stroke.color || DEFAULT_COLOR),
    size: Number(stroke.size) || 6,
    opacity: Number.isFinite(Number(stroke.opacity)) ? Number(stroke.opacity) : 1,
    points: Array.isArray(stroke.points) ? stroke.points.map(clonePoint) : [],
    bbox: Array.isArray(stroke.bbox) ? stroke.bbox.map((value) => Number(value) || 0) : null,
  };
}

function cloneStrokes(strokes) {
  return (Array.isArray(strokes) ? strokes : []).map(cloneStroke);
}

function cloneObject(object) {
  return JSON.parse(JSON.stringify(object));
}

function cloneObjects(objects) {
  return (Array.isArray(objects) ? objects : []).map(cloneObject);
}

function debugEnabled() {
  try {
    const stored = globalThis.localStorage?.getItem(DEBUG_KEY);
    return stored === "1" || stored === "true" || globalThis.__SHOWME_DEBUG === true;
  } catch (err) {
    console.debug("ShowMe: debug flag read failed", err);
    return globalThis.__SHOWME_DEBUG === true;
  }
}

function debugLog(label, details) {
  if (!debugEnabled()) return;
  const payload = typeof details === "function" ? details() : details;
  const consoleApi = globalThis.console;
  if (!consoleApi?.log) return;
  if (consoleApi.groupCollapsed) {
    consoleApi.groupCollapsed(`[ShowMe] ${label}`);
    consoleApi.log(payload);
    consoleApi.groupEnd?.();
  } else {
    consoleApi.log(`[ShowMe] ${label}`, payload);
  }
}

function cloneLayer(store) {
  return {
    strokes: cloneStrokes(store.strokes),
    objects: cloneObjects(store.objects),
  };
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `showme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getGraph() {
  return app.canvas?.graph || app.graph || null;
}

function computeBBox(points, size = 0) {
  if (!points?.length) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  const pad = Math.max(1, size);
  return [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
}

function unionBBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const minX = Math.min(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxX = Math.max(a[0] + a[2], b[0] + b[2]);
  const maxY = Math.max(a[1] + a[3], b[1] + b[3]);
  return [minX, minY, maxX - minX, maxY - minY];
}

function normalizeStroke(stroke) {
  const normalized = cloneStroke(stroke);
  normalized.points = normalized.points.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!normalized.points.length) return null;
  normalized.size = Math.max(1, Math.min(96, normalized.size));
  normalized.opacity = Math.max(0.05, Math.min(1, normalized.opacity));
  normalized.bbox = computeBBox(normalized.points, normalized.size);
  return normalized;
}

function normalizeRect(rect) {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  return rect.slice(0, 4).map((value) => Number(value) || 0);
}

function estimatedLabelWidth(text, options = {}) {
  const value = String(text || "");
  const lineLength = options.expanded ? 64 : options.compact ? 34 : 52;
  const longestLine = value
    .split(/\s+/)
    .reduce((line, word) => (line.length + word.length + 1 > lineLength ? word : `${line} ${word}`.trim()), "");
  const charWidth = options.compact && !options.expanded ? 6.2 : 7.4;
  const pad = options.expanded ? 32 : options.compact ? 18 : 28;
  const maxWidth = options.expanded ? 540 : options.compact ? RENDER.COMPACT_LABEL_MAX_WIDTH : 420;
  return Math.min(maxWidth, Math.max(42, Math.min(value.length, longestLine.length || value.length) * charWidth + pad));
}

function estimatedLabelHeight(text, options = {}) {
  const value = String(text || "").trim();
  if (!value) return options.compact && !options.expanded ? 24 : 34;
  const lineLength = options.expanded ? 64 : options.compact ? 34 : 52;
  const lineHeight = options.compact && !options.expanded ? 14 : 18;
  const maxLines = options.expanded ? 5 : options.compact ? 2 : 3;
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(value.length / lineLength)));
  return lineCount * lineHeight + (options.compact && !options.expanded ? 6 : 8);
}

function labelFontSize(options = {}) {
  const scale = Number(app.canvas?.ds?.scale) || 1;
  const baseFont = options.compact && !options.expanded ? RENDER.COMPACT_LABEL_FONT_BASE : RENDER.LABEL_FONT_BASE;
  return Math.max(RENDER.LABEL_FONT_MIN, Math.min(RENDER.LABEL_FONT_MAX, baseFont / Math.sqrt(scale)));
}

function labelMaxLines(options = {}) {
  return options.expanded ? 5 : options.compact ? 2 : 3;
}

function labelMaxWidth(options = {}) {
  return options.expanded
    ? Math.min(RENDER.LABEL_MAX_WIDTH + 120, 520)
    : options.compact ? RENDER.COMPACT_LABEL_MAX_WIDTH : RENDER.LABEL_MAX_WIDTH;
}

function measureLabelBox(text, options = {}, ctx = null) {
  const canvasCtx = ctx || measureLabelBox.ctx || (measureLabelBox.ctx = document.createElement("canvas").getContext("2d"));
  const fontSize = labelFontSize(options);
  canvasCtx.font = `${options.emphasis ? "700 " : ""}${fontSize}px Inter, system-ui, sans-serif`;
  const lineHeight = fontSize + (options.compact && !options.expanded ? 3 : 5);
  const maxWidth = labelMaxWidth(options);
  const lines = wrapCanvasText(canvasCtx, text, maxWidth, labelMaxLines(options));
  const padX = options.compact && !options.expanded ? 12 : 18;
  const padY = options.compact && !options.expanded ? 5 : 8;
  const measuredWidth = Math.max(...lines.map((line) => canvasCtx.measureText(line).width), 1);
  const boxWidth = Math.min(maxWidth + padX, measuredWidth + padX);
  const finalBoxWidth = options.expanded ? Math.min(maxWidth + 30, measuredWidth + 22) : boxWidth;
  const boxHeight = lines.length * lineHeight + padY;
  return { lines, lineHeight, boxWidth: finalBoxWidth, boxHeight, fontSize };
}

function labelBBox(pos, text, options = {}) {
  const box = measureLabelBox(text, options);
  return [pos[0], pos[1] - box.boxHeight * 0.5, box.boxWidth, box.boxHeight];
}

function pointInBBox(point, bbox, padding = 0) {
  if (!point || !bbox) return false;
  return (
    point[0] >= bbox[0] - padding
    && point[0] <= bbox[0] + bbox[2] + padding
    && point[1] >= bbox[1] - padding
    && point[1] <= bbox[1] + bbox[3] + padding
  );
}

function bboxCenterDistanceSq(point, bbox) {
  const dx = point[0] - (bbox[0] + bbox[2] * 0.5);
  const dy = point[1] - (bbox[1] + bbox[3] * 0.5);
  return dx * dx + dy * dy;
}

function compactLabelText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= RENDER.COMPACT_LABEL_MAX_CHARS) return value;
  return `${value.slice(0, RENDER.COMPACT_LABEL_MAX_CHARS - 1).trimEnd()}...`;
}

function expandedObjectIds() {
  return new Set([state.hoverObjectId, state.pinnedObjectId].filter(Boolean));
}

function isAiStepLabel(object) {
  return object?.source === "ai" && object.type === "label" && object.role === "step";
}

function labelIsCompact(object) {
  return Boolean(object?.compact || (state.compactAiStepLabels && isAiStepLabel(object)));
}

function correctedStepLabelText(object) {
  const text = String(object?.fullText || object?.text || "");
  const stepIndex = Number(object?.stepIndex);
  if (!Number.isFinite(stepIndex) || stepIndex <= 0 || object?.role !== "step") return text;
  const prefix = `${Math.floor(stepIndex)}.`;
  if (/^\s*\d{1,4}\.\s*/.test(text)) return text.replace(/^\s*\d{1,4}\.\s*/, `${prefix} `);
  return `${prefix} ${text}`;
}

function labelDisplayText(object, expanded) {
  const fullText = correctedStepLabelText(object);
  if (expanded) return fullText;
  return labelIsCompact(object) ? compactLabelText(fullText) : fullText;
}

function objectDisplayColor(object) {
  const stepIndex = Number(object?.stepIndex);
  if (object?.source === "ai" && object.role === "step" && Number.isFinite(stepIndex) && stepIndex > 0) {
    const ordinal = Math.floor(stepIndex) - 1;
    return planPaletteColor(ordinal, Math.floor(ordinal / PLAN_COLORS.length));
  }
  return object?.color || DEFAULT_COLOR;
}

function labelIsExpanded(object) {
  return (
    object?.id === state.hoverObjectId
    || object?.id === state.pinnedObjectId
    || sameTarget(state.selectedTarget, { kind: "object", id: object?.id })
  );
}

function rectFromPoints(a, b) {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

function normalizeObject(object) {
  if (!object || typeof object !== "object") return null;
  const type = String(object.type || "");
  const color = String(object.color || "#59d7c7");
  const opacity = Math.max(0.05, Math.min(1, Number(object.opacity) || 0.92));
  const base = {
    id: String(object.id || cryptoRandomId()),
    type,
    source: object.source === "ai" ? "ai" : "manual",
    color,
    opacity,
    label: String(object.label || "").slice(0, 140),
    text: String(object.text || "").slice(0, 220),
  };
  if (object.nodeId != null) base.nodeId = String(object.nodeId);
  if (object.widget != null) base.widget = String(object.widget || "").slice(0, 80);
  if (object.anchor != null) base.anchor = String(object.anchor || "").slice(0, 24);
  if (object.calloutSide != null) base.calloutSide = String(object.calloutSide || "").slice(0, 16);
  if (Number.isFinite(Number(object.stepIndex))) {
    base.stepIndex = Math.max(1, Math.floor(Number(object.stepIndex)));
  }
  if (object.role != null) base.role = String(object.role || "").slice(0, 40);
  if (type === "arrow") {
    const from = Array.isArray(object.from) ? clonePoint(object.from) : null;
    const to = Array.isArray(object.to) ? clonePoint(object.to) : null;
    if (!from || !to) return null;
    const points = Array.isArray(object.points) && object.points.length >= 2
      ? object.points.map(clonePoint)
      : [from, to];
    const labelPos = Array.isArray(object.labelPos) ? clonePoint(object.labelPos) : null;
    const lineBox = computeBBox(points, Number(object.width) || 5);
    const textBox = labelPos && base.label ? labelBBox(labelPos, base.label) : null;
    const routeMeta = {};
    if (object.fromNodeId != null) routeMeta.fromNodeId = String(object.fromNodeId);
    if (object.toNodeId != null) routeMeta.toNodeId = String(object.toNodeId);
    if (object.fromSlot != null) routeMeta.fromSlot = String(object.fromSlot).slice(0, 80);
    if (object.toSlot != null) routeMeta.toSlot = String(object.toSlot).slice(0, 80);
    if (object.routeGroup != null) routeMeta.routeGroup = String(object.routeGroup).slice(0, 32);
    if (Number.isFinite(Number(object.routeIndex))) {
      routeMeta.routeIndex = Math.max(0, Math.floor(Number(object.routeIndex)));
    }
    return {
      ...base,
      ...routeMeta,
      from,
      to,
      points,
      labelPos,
      width: Math.max(1, Math.min(20, Number(object.width) || 5)),
      bbox: unionBBox(lineBox, textBox),
    };
  }
  if (type === "highlight" || type === "rect") {
    const rect = normalizeRect(object.rect);
    if (!rect) return null;
    return {
      ...base,
      rect,
      width: Math.max(1, Math.min(18, Number(object.width) || 5)),
      bbox: rect,
    };
  }
  if (type === "ellipse") {
    const rect = normalizeRect(object.rect);
    if (!rect) return null;
    return {
      ...base,
      rect,
      width: Math.max(1, Math.min(18, Number(object.width) || 5)),
      bbox: rect,
    };
  }
  if (type === "label") {
    const pos = Array.isArray(object.pos) ? clonePoint(object.pos) : null;
    if (!pos || !base.text) return null;
    const compact = Boolean(object.compact);
    return {
      ...base,
      pos,
      fullText: String(object.fullText || object.text || "").slice(0, 520),
      compact,
      bbox: labelBBox(pos, base.text, { compact }),
    };
  }
  if (type === "badge") {
    const pos = Array.isArray(object.pos) ? clonePoint(object.pos) : null;
    if (!pos || !base.text) return null;
    const radius = Math.max(12, Math.min(28, Number(object.radius) || 16));
    return {
      ...base,
      pos,
      radius,
      bbox: [pos[0] - radius - 3, pos[1] - radius - 3, radius * 2 + 6, radius * 2 + 6],
    };
  }
  return null;
}

function normalizeStore(raw) {
  const store = raw && typeof raw === "object" ? raw : {};
  const settings = store.settings && typeof store.settings === "object" ? store.settings : {};
  return {
    version: 1,
    strokes: (Array.isArray(store.strokes) ? store.strokes : []).map(normalizeStroke).filter(Boolean),
    objects: (Array.isArray(store.objects) ? store.objects : []).map(normalizeObject).filter(Boolean),
    settings: {
      visible: settings.visible !== false,
    },
    updatedAt: Number(store.updatedAt) || Date.now(),
  };
}

function stableNodeSummary(node) {
  const pair = (raw, a, b) => {
    const arr = Array.isArray(raw)
      ? raw
      : raw != null && typeof raw === "object" && Symbol.iterator in raw && typeof raw !== "string"
        ? Array.from(raw)
        : null;
    if (!arr || arr.length < 2) return [a, b];
    return [Math.round(Number(arr[0]) || 0), Math.round(Number(arr[1]) || 0)];
  };
  return {
    id: node?.id,
    type: String(node?.type || ""),
    title: String(node?.title || ""),
    pos: pair(node?.pos, 0, 0),
    size: pair(node?.size, 180, 80),
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKeyFromNodes(nodes) {
  const summary = (Array.isArray(nodes) ? nodes : [])
    .map(stableNodeSummary)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!summary.length) return null;
  return `${LOCAL_CACHE_PREFIX}${hashString(JSON.stringify(summary))}`;
}

function cacheKeyFromGraph(graph = getGraph()) {
  const nodes = graph?._nodes || graph?.nodes || [];
  const summary = nodes.map(stableNodeSummary);
  return cacheKeyFromNodes(summary);
}

function saveLocalDraft(store) {
  try {
    const key = cacheKeyFromGraph();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify({ store: normalizeStore(store), savedAt: Date.now() }));
  } catch (err) {
    console.debug("ShowMe: localStorage save failed", err);
  }
}

function loadLocalDraft(graphData) {
  try {
    const key = cacheKeyFromNodes(graphData?.nodes);
    if (!key) return null;
    const payload = JSON.parse(localStorage.getItem(key) || "null");
    if (!payload?.store) return null;
    return normalizeStore(payload.store);
  } catch (err) {
    console.debug("ShowMe: localStorage load failed", err);
    return null;
  }
}

function getStore(create = true) {
  const graph = getGraph();
  if (!graph) return normalizeStore(null);
  if (create) graph.extra ||= {};
  if (!graph.extra) return normalizeStore(null);
  if (!create && graph.extra[STORE_KEY] == null) return normalizeStore(null);
  const normalized = normalizeStore(graph.extra[STORE_KEY]);
  graph.extra[STORE_KEY] = normalized;
  state.visible = normalized.settings.visible;
  return normalized;
}

function setStore(nextStore) {
  const graph = getGraph();
  if (!graph) return;
  emitWorkflowBeforeChange();
  graph.extra ||= {};
  graph.extra[STORE_KEY] = normalizeStore(nextStore);
  state.visible = graph.extra[STORE_KEY].settings.visible;
  saveLocalDraft(graph.extra[STORE_KEY]);
  markDirty(true);
}

function getActiveWorkflow() {
  return app.extensionManager?.workflowStore?.activeWorkflow
    || app.workflowManager?.activeWorkflow
    || app.workflowStore?.activeWorkflow
    || globalThis.comfyAPI?.workflowStore?.activeWorkflow
    || globalThis.comfyAPI?.workflow?.activeWorkflow
    || null;
}

function emitWorkflowBeforeChange() {
  try {
    app.canvas?.emitBeforeChange?.();
  } catch (err) {
    console.debug("ShowMe: optional ComfyUI hook unavailable (emitBeforeChange)", err);
  }
}

function emitWorkflowAfterChange() {
  try {
    app.canvas?.graph?.afterChange?.();
  } catch (err) {
    console.debug("ShowMe: optional ComfyUI hook unavailable (graph.afterChange)", err);
  }
  try {
    app.canvas?.emitAfterChange?.();
  } catch (err) {
    console.debug("ShowMe: optional ComfyUI hook unavailable (emitAfterChange)", err);
  }
  try {
    getActiveWorkflow()?.changeTracker?.checkState?.();
  } catch (err) {
    console.debug("ShowMe: optional ComfyUI hook unavailable (changeTracker.checkState)", err);
  }
}

function markDirty(changed = false) {
  const graph = getGraph();
  if (changed) {
    graph?.change?.();
    graph?.setDirtyCanvas?.(true, true);
  }
  app.canvas?.setDirty?.(true, true);
  if (changed) emitWorkflowAfterChange();
}

function pushHistory() {
  const store = getStore();
  state.undoStack.push(cloneLayer(store));
  if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  state.redoStack = [];
  updateHistoryButtons();
}

function restoreHistory(layer) {
  const store = getStore();
  store.strokes = cloneStrokes(layer?.strokes);
  store.objects = cloneObjects(layer?.objects);
  store.updatedAt = Date.now();
  setStore(store);
  updateHistoryButtons();
}

function undo() {
  if (!state.undoStack.length) return;
  const store = getStore();
  state.redoStack.push(cloneLayer(store));
  restoreHistory(state.undoStack.pop());
}

function redo() {
  if (!state.redoStack.length) return;
  const store = getStore();
  state.undoStack.push(cloneLayer(store));
  restoreHistory(state.redoStack.pop());
}

function clearLayer() {
  const store = getStore();
  if (!store.strokes.length && !store.objects.length) return;
  pushHistory();
  store.strokes = [];
  store.objects = [];
  store.updatedAt = Date.now();
  state.selectedTarget = null;
  state.activeMove = null;
  state.hoverSelectable = false;
  setStore(store);
}

function setVisible(visible) {
  if (!visible) closeTextEditor(false);
  const store = getStore();
  store.settings.visible = Boolean(visible);
  store.updatedAt = Date.now();
  setStore(store);
  updateToolbarState();
}

function eventToGraph(event) {
  const canvas = app.canvas?.canvas || app.canvasEl;
  const rect = canvas?.getBoundingClientRect?.();
  if (!rect) return [0, 0];
  const canvasPoint = [event.clientX - rect.left, event.clientY - rect.top];
  const ds = app.canvas?.ds;
  if (typeof ds?.convertCanvasToOffset === "function") {
    return clonePoint(ds.convertCanvasToOffset(canvasPoint, [0, 0]));
  }
  const scale = Number(ds?.scale) || 1;
  const offset = ds?.offset || [0, 0];
  return [canvasPoint[0] / scale - offset[0], canvasPoint[1] / scale - offset[1]];
}

function canvasPointToGraph(point) {
  const ds = app.canvas?.ds;
  if (typeof ds?.convertCanvasToOffset === "function") {
    return clonePoint(ds.convertCanvasToOffset(point, [0, 0]));
  }
  const scale = Number(ds?.scale) || 1;
  const offset = ds?.offset || [0, 0];
  return [point[0] / scale - offset[0], point[1] / scale - offset[1]];
}

function graphPointToCanvas(point) {
  const ds = app.canvas?.ds;
  if (typeof ds?.convertOffsetToCanvas === "function") {
    return clonePoint(ds.convertOffsetToCanvas(point, [0, 0]));
  }
  const scale = Number(ds?.scale) || 1;
  const offset = ds?.offset || [0, 0];
  return [(point[0] + offset[0]) * scale, (point[1] + offset[1]) * scale];
}

function graphPointToClient(point) {
  const canvas = app.canvas?.canvas || app.canvasEl;
  const rect = canvas?.getBoundingClientRect?.();
  const canvasPoint = graphPointToCanvas(point);
  return [(Number(rect?.left) || 0) + canvasPoint[0], (Number(rect?.top) || 0) + canvasPoint[1]];
}

function clientRectToGraph(rect) {
  const canvas = app.canvas?.canvas || app.canvasEl;
  const canvasRect = canvas?.getBoundingClientRect?.();
  if (!rect || !canvasRect || rect.width <= 0 || rect.height <= 0) return null;
  const topLeft = canvasPointToGraph([rect.left - canvasRect.left, rect.top - canvasRect.top]);
  const bottomRight = canvasPointToGraph([rect.right - canvasRect.left, rect.bottom - canvasRect.top]);
  return [
    Math.min(topLeft[0], bottomRight[0]),
    Math.min(topLeft[1], bottomRight[1]),
    Math.abs(bottomRight[0] - topLeft[0]),
    Math.abs(bottomRight[1] - topLeft[1]),
  ];
}

function distanceSq(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function distToSegmentSq(point, a, b) {
  const x = point[0];
  const y = point[1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return distanceSq(point, a);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return (x - px) * (x - px) + (y - py) * (y - py);
}

function distToPolylineSq(point, points) {
  if (!Array.isArray(points) || !points.length) return Infinity;
  if (points.length === 1) return distanceSq(point, points[0]);
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    best = Math.min(best, distToSegmentSq(point, points[index - 1], points[index]));
  }
  return best;
}

function bboxIntersects(a, b, pad = 0) {
  if (!a || !b) return true;
  return !(
    a[0] + a[2] < b[0] - pad ||
    b[0] + b[2] < a[0] - pad ||
    a[1] + a[3] < b[1] - pad ||
    b[1] + b[3] < a[1] - pad
  );
}

function rectHitScore(point, rect) {
  if (!rect) return Infinity;
  if (pointInBBox(point, rect, 0)) return 0;
  const dx = Math.max(rect[0] - point[0], 0, point[0] - (rect[0] + rect[2]));
  const dy = Math.max(rect[1] - point[1], 0, point[1] - (rect[1] + rect[3]));
  return dx * dx + dy * dy;
}

function ellipseHitScore(point, rect, radius) {
  if (!rect) return Infinity;
  if (!pointInBBox(point, rect, radius)) return Infinity;
  const rx = Math.max(0.5, rect[2] * 0.5);
  const ry = Math.max(0.5, rect[3] * 0.5);
  const cx = rect[0] + rx;
  const cy = rect[1] + ry;
  const nx = (point[0] - cx) / rx;
  const ny = (point[1] - cy) / ry;
  const normalized = Math.sqrt(nx * nx + ny * ny);
  if (normalized <= 1) return 0;
  const edgeDistance = (normalized - 1) * Math.min(rx, ry);
  return edgeDistance <= radius ? edgeDistance * edgeDistance : Infinity;
}

function strokeNearPoint(stroke, point, radius) {
  const padded = radius + stroke.size;
  const testBox = [point[0] - padded, point[1] - padded, padded * 2, padded * 2];
  if (!bboxIntersects(stroke.bbox, testBox)) return false;
  const limit = padded * padded;
  const points = stroke.points || [];
  if (points.length === 1) return distanceSq(points[0], point) <= limit;
  for (let i = 1; i < points.length; i += 1) {
    if (distToSegmentSq(point, points[i - 1], points[i]) <= limit) return true;
  }
  return false;
}

function objectNearPoint(object, point, radius) {
  const testBox = [point[0] - radius, point[1] - radius, radius * 2, radius * 2];
  if (!bboxIntersects(object.bbox, testBox, radius)) return false;
  if (object.type === "arrow") {
    const limit = radius + (Number(object.width) || 4);
    const points = Array.isArray(object.points) && object.points.length >= 2 ? object.points : [object.from, object.to];
    for (let i = 1; i < points.length; i += 1) {
      if (distToSegmentSq(point, points[i - 1], points[i]) <= limit * limit) return true;
    }
    return false;
  }
  if (object.type === "label") return bboxIntersects(object.bbox, testBox, radius);
  return true;
}

function objectHitCandidate(object, point, zIndex = 0) {
  if (!object) return null;
  if (object.type === "label") {
    const expanded = labelIsExpanded(object);
    const bbox = labelHitBBox(object, expanded);
    const radius = selectionHitRadius("label");
    if (!pointInBBox(point, bbox, radius)) return null;
    return {
      target: { kind: "object", id: object.id },
      priority: 0,
      score: bboxCenterDistanceSq(point, bbox),
      zIndex,
    };
  }
  if (object.type === "arrow") {
    const radius = selectionHitRadius("arrow");
    const testBox = [point[0] - radius, point[1] - radius, radius * 2, radius * 2];
    if (!bboxIntersects(object.bbox, testBox, radius)) return null;
    if (object.label && Array.isArray(object.labelPos)) {
      const labelBox = labelBBox(object.labelPos, object.label);
      if (pointInBBox(point, labelBox, selectionHitRadius("label"))) {
        return {
          target: { kind: "object", id: object.id },
          priority: 0.5,
          score: bboxCenterDistanceSq(point, labelBox),
          zIndex,
        };
      }
    }
    const points = Array.isArray(object.points) && object.points.length >= 2 ? object.points : [object.from, object.to];
    const score = distToPolylineSq(point, points);
    const limit = radius + (Number(object.width) || 4) * 0.5;
    if (score > limit * limit) return null;
    return {
      target: { kind: "object", id: object.id },
      priority: 1,
      score,
      zIndex,
    };
  }
  if (object.type === "badge") {
    const radius = (Number(object.radius) || 16) + selectionHitRadius("object");
    const score = distanceSq(point, object.pos);
    if (score > radius * radius) return null;
    return {
      target: { kind: "object", id: object.id },
      priority: 2,
      score,
      zIndex,
    };
  }
  if (object.type === "ellipse") {
    const radius = selectionHitRadius("object") + (Number(object.width) || 4) * 0.5;
    const score = ellipseHitScore(point, object.rect, radius);
    if (!Number.isFinite(score)) return null;
    return {
      target: { kind: "object", id: object.id },
      priority: object.source === "ai" ? 4 : 3,
      score,
      zIndex,
    };
  }
  if (object.type === "rect" || object.type === "highlight") {
    const radius = selectionHitRadius("object") + (Number(object.width) || 4) * 0.5;
    if (!pointInBBox(point, object.rect || object.bbox, radius)) return null;
    return {
      target: { kind: "object", id: object.id },
      priority: object.type === "highlight" ? 5 : 3,
      score: rectHitScore(point, object.rect || object.bbox),
      zIndex,
    };
  }
  if (!objectNearPoint(object, point, selectionHitRadius("object"))) return null;
  return {
    target: { kind: "object", id: object.id },
    priority: 6,
    score: 0,
    zIndex,
  };
}

function strokeHitCandidate(stroke, point, zIndex = 0) {
  if (!stroke) return null;
  const radius = selectionHitRadius("stroke");
  const padded = radius + (Number(stroke.size) || 6) * 0.5;
  const testBox = [point[0] - padded, point[1] - padded, padded * 2, padded * 2];
  if (!bboxIntersects(stroke.bbox, testBox)) return null;
  const score = distToPolylineSq(point, stroke.points || []);
  if (score > padded * padded) return null;
  return {
    target: { kind: "stroke", id: stroke.id },
    priority: 1,
    score,
    zIndex,
  };
}

function betterHitCandidate(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rankA = a.priority * 1_000_000_000 + a.score - a.zIndex * 0.001;
  const rankB = b.priority * 1_000_000_000 + b.score - b.zIndex * 0.001;
  return rankB < rankA ? b : a;
}

function targetKey(target) {
  if (!target) return "";
  return `${target.kind}:${target.id}`;
}

function sameTarget(a, b) {
  return targetKey(a) === targetKey(b);
}

function hitTestAnnotation(point) {
  const store = getStore(false);
  let best = null;
  let zIndex = 0;
  for (let index = store.objects.length - 1; index >= 0; index -= 1) {
    const object = store.objects[index];
    if (!object) continue;
    best = betterHitCandidate(best, objectHitCandidate(object, point, zIndex));
    zIndex += 1;
  }
  for (let index = store.strokes.length - 1; index >= 0; index -= 1) {
    const stroke = store.strokes[index];
    best = betterHitCandidate(best, strokeHitCandidate(stroke, point, zIndex));
    zIndex += 1;
  }
  return best?.target || null;
}

function selectedTargetObject(store = getStore(false)) {
  const target = state.selectedTarget;
  if (!target) return null;
  if (target.kind === "object") return store.objects.find((object) => object.id === target.id) || null;
  if (target.kind === "stroke") return store.strokes.find((stroke) => stroke.id === target.id) || null;
  return null;
}

function translateRect(rect, delta) {
  return [rect[0] + delta[0], rect[1] + delta[1], rect[2], rect[3]];
}

function translatePoint(point, delta) {
  return [point[0] + delta[0], point[1] + delta[1]];
}

function translateObject(object, delta) {
  const next = cloneObject(object);
  if (Array.isArray(next.pos)) next.pos = translatePoint(next.pos, delta);
  if (Array.isArray(next.from)) next.from = translatePoint(next.from, delta);
  if (Array.isArray(next.to)) next.to = translatePoint(next.to, delta);
  if (Array.isArray(next.labelPos)) next.labelPos = translatePoint(next.labelPos, delta);
  if (Array.isArray(next.rect)) next.rect = translateRect(next.rect, delta);
  if (Array.isArray(next.points)) next.points = next.points.map((point) => translatePoint(point, delta));
  return normalizeObject(next);
}

function translateStroke(stroke, delta) {
  return normalizeStroke({
    ...stroke,
    points: stroke.points.map((point) => translatePoint(point, delta)),
  });
}

function translateSelectedTarget(delta) {
  const target = state.selectedTarget;
  if (!target || (!delta[0] && !delta[1])) return false;
  const store = getStore();
  let changed = false;
  if (target.kind === "object") {
    store.objects = store.objects.map((object) => {
      if (object.id !== target.id) return object;
      const next = translateObject(object, delta);
      changed = Boolean(next);
      return next || object;
    });
  } else if (target.kind === "stroke") {
    store.strokes = store.strokes.map((stroke) => {
      if (stroke.id !== target.id) return stroke;
      const next = translateStroke(stroke, delta);
      changed = Boolean(next);
      return next || stroke;
    });
  }
  if (!changed) return false;
  store.updatedAt = Date.now();
  setStore(store);
  return true;
}

function drawSelectionBox(ctx, target) {
  if (!target?.bbox) return;
  const scale = Number(app.canvas?.ds?.scale) || 1;
  const rect = target.type === "label" ? labelHitBBox(target, labelIsExpanded(target)) : target.bbox;
  ctx.save();
  ctx.setLineDash([7 / scale, 5 / scale]);
  ctx.lineWidth = Math.max(1.5, 1.5 / scale);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
  drawRoundedRect(ctx, rect[0] - 5, rect[1] - 5, rect[2] + 10, rect[3] + 10, 7);
  ctx.stroke();
  ctx.restore();
}

function eraseAt(point) {
  const store = getStore();
  const radius = Math.max(8, state.size * 1.8);
  const next = store.strokes.filter((stroke) => !strokeNearPoint(stroke, point, radius));
  const nextObjects = store.objects.filter((object) => !objectNearPoint(object, point, radius));
  if (next.length === store.strokes.length && nextObjects.length === store.objects.length) return;
  const removedStrokes = store.strokes.length - next.length;
  const removedObjects = store.objects.length - nextObjects.length;
  store.strokes = next;
  store.objects = nextObjects;
  store.updatedAt = Date.now();
  state.gestureChanged = true;
  setStore(store);
  debugLog("erase", () => ({
    point,
    radius,
    removedStrokes,
    removedObjects,
    store: debugStoreSnapshot(),
  }));
}

function perpendicularDistance(point, a, b) {
  return Math.sqrt(distToSegmentSq(point, a, b));
}

function simplifyPoints(points, tolerance) {
  if (points.length <= 2) return points;
  let index = -1;
  let maxDistance = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points[end]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }
  if (maxDistance <= tolerance || index < 0) return [points[0], points[end]];
  const left = simplifyPoints(points.slice(0, index + 1), tolerance);
  const right = simplifyPoints(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function appendPoint(point) {
  const stroke = state.currentStroke;
  if (!stroke) return;
  const points = stroke.points;
  const last = points[points.length - 1];
  const scale = Number(app.canvas?.ds?.scale) || 1;
  const minDistance = Math.max(1, state.size * 0.18, 2 / scale);
  if (distanceSq(last, point) < minDistance * minDistance) return;
  points.push(point);
  stroke.bbox = computeBBox(points, stroke.size);
  markDirty(false);
}

function beginBrush(point) {
  pushHistory();
  state.currentStroke = {
    id: cryptoRandomId(),
    tool: "brush",
    color: state.color,
    size: state.size,
    opacity: state.opacity,
    points: [point],
    bbox: computeBBox([point], state.size),
  };
  state.gestureChanged = true;
}

function finishBrush() {
  const stroke = state.currentStroke;
  state.currentStroke = null;
  if (!stroke) return;
  stroke.points = simplifyPoints(stroke.points, Math.max(0.6, stroke.size * 0.08));
  stroke.bbox = computeBBox(stroke.points, stroke.size);
  const normalized = normalizeStroke(stroke);
  if (!normalized) return;
  const store = getStore();
  store.strokes.push(normalized);
  store.updatedAt = Date.now();
  setStore(store);
  debugLog("manual stroke saved", () => ({
    stroke: debugStrokeSnapshot(normalized, store.strokes.length - 1),
    store: debugStoreSnapshot(),
  }));
}

function buildDragObject(start, end) {
  const common = {
    color: state.color,
    width: Math.max(2, state.size),
    opacity: state.opacity,
  };
  if (state.tool === "arrow") {
    return normalizeObject({
      type: "arrow",
      from: start,
      to: end,
      ...common,
    });
  }
  if (state.tool === "rect") {
    return normalizeObject({
      type: "rect",
      rect: rectFromPoints(start, end),
      ...common,
    });
  }
  if (state.tool === "ellipse") {
    return normalizeObject({
      type: "ellipse",
      rect: rectFromPoints(start, end),
      ...common,
    });
  }
  return null;
}

function beginObject(point) {
  pushHistory();
  state.shapeStart = point;
  state.currentObject = buildDragObject(point, point);
  state.gestureChanged = true;
}

function updateObject(point) {
  if (!state.shapeStart) return;
  state.currentObject = buildDragObject(state.shapeStart, point);
  markDirty(false);
}

function finishObject() {
  const object = state.currentObject;
  state.currentObject = null;
  state.shapeStart = null;
  if (!object) return;
  const box = object.bbox || [0, 0, 0, 0];
  if (Math.max(box[2], box[3]) < 4) return;
  const store = getStore();
  store.objects.push(object);
  store.updatedAt = Date.now();
  setStore(store);
  debugLog("manual object saved", () => ({
    object: debugObjectSnapshot(object, store.objects.length - 1),
    store: debugStoreSnapshot(),
  }));
}

function positionTextEditor() {
  const editor = state.textEditor;
  if (!editor?.element || !editor.point) return;
  const [x, y] = graphPointToClient(editor.point);
  editor.element.style.left = `${Math.round(x)}px`;
  editor.element.style.top = `${Math.round(y)}px`;
}

function resizeTextEditor(element) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(140, Math.max(34, element.scrollHeight))}px`;
}

function closeTextEditor(save = false) {
  const editor = state.textEditor;
  if (!editor?.element) return;
  state.textEditor = null;
  const text = String(editor.element.value || "").trim();
  editor.element.remove();
  if (!save || !text) {
    markDirty(false);
    return;
  }
  if (editor.target?.kind === "object") {
    const store = getStore();
    const index = store.objects.findIndex((object) => object.id === editor.target.id && object.type === "label");
    if (index < 0) return;
    const current = store.objects[index];
    const previous = String(current.fullText || current.text || "").trim();
    if (previous === text) {
      markDirty(false);
      return;
    }
    const next = normalizeObject({
      ...current,
      text,
      fullText: text,
    });
    if (!next) return;
    pushHistory();
    store.objects[index] = next;
    store.updatedAt = Date.now();
    setStore(store);
    state.selectedTarget = { kind: "object", id: next.id };
    markDirty(false);
    return;
  }
  const object = normalizeObject({
    type: "label",
    source: "manual",
    pos: editor.point,
    color: state.color,
    text,
    fullText: text,
    opacity: state.opacity,
  });
  if (!object) return;
  pushHistory();
  const store = getStore();
  store.objects.push(object);
  store.settings.visible = true;
  store.updatedAt = Date.now();
  setStore(store);
  state.visible = true;
  updateToolbarState();
  markDirty(false);
}

function openTextEditor(point, options = {}) {
  closeTextEditor(false);
  const root = state.toolbar || document.body;
  const element = document.createElement("textarea");
  element.className = "showme-text-editor";
  element.maxLength = 220;
  element.rows = 1;
  element.spellcheck = false;
  element.placeholder = "Text";
  element.setAttribute("aria-label", "Text label");
  element.value = String(options.text || "");
  root.appendChild(element);
  state.textEditor = { element, point: clonePoint(point), target: options.target || null };
  positionTextEditor();
  const stop = (event) => event.stopPropagation();
  element.addEventListener("pointerdown", stop);
  element.addEventListener("click", stop);
  element.addEventListener("input", () => resizeTextEditor(element));
  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeTextEditor(false);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      closeTextEditor(true);
    }
  });
  element.addEventListener("blur", () => closeTextEditor(true));
  requestAnimationFrame(() => {
    resizeTextEditor(element);
    element.focus();
  });
  markDirty(false);
}

function swallow(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function onCanvasPointerDown(event) {
  if (!state.visible || event.button !== 0) return;
  const point = eventToGraph(event);
  if (!state.active) {
    const target = hitTestAnnotation(point);
    if (!target) {
      setHoverSelectable(false);
      if (state.selectedTarget) {
        state.selectedTarget = null;
        markDirty(false);
      }
      return;
    }
    state.selectedTarget = target;
    setHoverSelectable(true);
    state.activeMove = {
      target,
      pointerId: event.pointerId,
      startPoint: point,
      lastPoint: point,
      didPushHistory: false,
      moved: false,
    };
    state.suppressNextClick = true;
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch (err) {
      console.debug("ShowMe: selection pointer capture failed", err);
    }
    markDirty(false);
    swallow(event);
    return;
  }
  if (state.tool === "text") {
    const target = hitTestAnnotation(point);
    const store = getStore(false);
    const object = target?.kind === "object" ? store.objects.find((item) => item.id === target.id) : null;
    if (object?.type === "label") {
      state.selectedTarget = target;
      openTextEditor(object.pos, { target, text: labelDisplayText(object, true) });
    } else {
      openTextEditor(point);
    }
    swallow(event);
    return;
  }
  state.pointerId = event.pointerId;
  state.isDrawing = true;
  state.gestureChanged = false;
  if (state.tool === "eraser") {
    pushHistory();
    eraseAt(point);
  } else if (state.tool === "brush") {
    beginBrush(point);
  } else {
    beginObject(point);
  }
  try {
    event.currentTarget?.setPointerCapture?.(event.pointerId);
  } catch (err) {
    console.debug("ShowMe: pointer capture failed", err);
  }
  swallow(event);
}

function hitTestAiObject(point) {
  const store = getStore(false);
  const objects = store.objects || [];
  const labels = [];
  const others = [];
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object?.source !== "ai") continue;
    if (object.type === "label") labels.push(object);
    else others.push(object);
  }
  state.compactAiStepLabels = labels.filter(isAiStepLabel).length > COMPACT_STEP_LABEL_THRESHOLD;
  for (const object of labels) {
    if ((object.id === state.hoverObjectId || object.id === state.pinnedObjectId) && pointInBBox(point, labelHitBBox(object, true), 12)) {
      return object;
    }
  }
  let bestLabel = null;
  for (const object of labels) {
    const bbox = labelHitBBox(object, false);
    if (!pointInBBox(point, bbox, 10)) continue;
    const score = bboxCenterDistanceSq(point, bbox);
    if (!bestLabel || score < bestLabel.score) bestLabel = { object, score };
  }
  if (bestLabel) return bestLabel.object;
  for (const object of others) {
    const padding = object.type === "badge" ? 8 : object.type === "label" ? 10 : 0;
    if (pointInBBox(point, object.bbox, padding)) return object;
  }
  return null;
}

function labelHitBBox(object, expanded) {
  return labelBBox(object.pos, labelDisplayText(object, expanded), { compact: labelIsCompact(object), expanded });
}

function pairedLabelForObject(object) {
  if (!object || object.type === "label") return object;
  if (object.source !== "ai" || object.nodeId == null) return object;
  const store = getStore(false);
  return [...(store.objects || [])].reverse().find((candidate) => (
    candidate.source === "ai"
    && candidate.type === "label"
    && candidate.role === object.role
    && String(candidate.nodeId) === String(object.nodeId)
    && (!object.stepIndex || candidate.stepIndex === object.stepIndex)
  )) || object;
}

function setHoverObjectId(objectId) {
  const next = objectId || "";
  if (state.hoverObjectId === next) return;
  state.hoverObjectId = next;
  markDirty(false);
}

function setHoverSelectable(selectable) {
  const next = Boolean(selectable);
  if (state.hoverSelectable === next) return;
  state.hoverSelectable = next;
  updateCanvasCursor();
}

function onCanvasPointerMoveHover(event) {
  if (state.isDrawing || state.activeMove) return;
  const point = eventToGraph(event);
  const object = pairedLabelForObject(hitTestAiObject(point));
  setHoverSelectable(!state.active && Boolean(hitTestAnnotation(point)));
  setHoverObjectId(object?.id || "");
}

function onCanvasClickHover(event) {
  if (state.suppressNextClick) {
    state.suppressNextClick = false;
    return;
  }
  if (state.isDrawing || state.active || event.button !== 0) return;
  const point = eventToGraph(event);
  const object = pairedLabelForObject(hitTestAiObject(point));
  if (!object || object.source !== "ai") return;
  state.pinnedObjectId = state.pinnedObjectId === object.id ? "" : object.id;
  markDirty(false);
}

function onWindowPointerMove(event) {
  if (state.activeMove && event.pointerId === state.activeMove.pointerId) {
    const point = eventToGraph(event);
    const delta = [point[0] - state.activeMove.lastPoint[0], point[1] - state.activeMove.lastPoint[1]];
    if (!state.activeMove.didPushHistory && distanceSq(point, state.activeMove.startPoint) > 0.0001) {
      pushHistory();
      state.activeMove.didPushHistory = true;
    }
    if (translateSelectedTarget(delta)) {
      state.activeMove.lastPoint = point;
      state.activeMove.moved = true;
    }
    swallow(event);
    return;
  }
  if (!state.isDrawing || event.pointerId !== state.pointerId) return;
  const point = eventToGraph(event);
  if (state.tool === "eraser") eraseAt(point);
  else if (state.tool === "brush") appendPoint(point);
  else updateObject(point);
  swallow(event);
}

function onWindowPointerEnd(event) {
  if (state.activeMove && event.pointerId === state.activeMove.pointerId) {
    const moved = state.activeMove.moved;
    state.activeMove = null;
    updateHistoryButtons();
    markDirty(false);
    if (moved) state.suppressNextClick = true;
    swallow(event);
    return;
  }
  if (!state.isDrawing || event.pointerId !== state.pointerId) return;
  if (state.tool === "brush") finishBrush();
  else if (state.tool !== "eraser" && state.tool !== "text") finishObject();
  state.pointerId = null;
  state.isDrawing = false;
  state.gestureChanged = false;
  updateHistoryButtons();
  swallow(event);
}

function onKeyDown(event) {
  if (!state.open && !state.active) return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === "Escape") {
    setActive(false);
    event.preventDefault();
    return;
  }
  if (!mod) return;
  if (key === "z" && !event.shiftKey) {
    undo();
    event.preventDefault();
  } else if (key === "y" || (key === "z" && event.shiftKey)) {
    redo();
    event.preventDefault();
  }
}

function drawStroke(ctx, stroke) {
  const points = stroke.points || [];
  if (!points.length) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0][0], points[0][1], stroke.size * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  if (points.length === 2) {
    ctx.lineTo(points[1][0], points[1][1]);
  } else {
    for (let i = 1; i < points.length - 1; i += 1) {
      const current = points[i];
      const next = points[i + 1];
      ctx.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) * 0.5, (current[1] + next[1]) * 0.5);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function fitCanvasText(ctx, text, maxWidth) {
  const value = String(text || "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  const suffix = "...";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(value.slice(0, mid) + suffix).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low).trimEnd() + suffix;
}

function wrapCanvasText(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (lines.length >= maxLines - 1) {
        lines.push(fitCanvasText(ctx, words.slice(i).join(" "), maxWidth));
        return lines;
      }
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawTextLabel(ctx, text, x, y, color, options = {}) {
  if (!text) return;
  const scale = Number(app.canvas?.ds?.scale) || 1;
  ctx.save();
  if (Number.isFinite(Number(options.opacity))) {
    ctx.globalAlpha *= clamp(Number(options.opacity), 0.05, 1);
  }
  const layout = measureLabelBox(text, options, ctx);
  ctx.font = `${options.emphasis ? "700 " : ""}${layout.fontSize}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  drawRoundedRect(ctx, x, y - layout.boxHeight * 0.5, layout.boxWidth, layout.boxHeight, options.compact && !options.expanded ? 4 : 6);
  ctx.fillStyle = options.expanded ? "rgba(8, 10, 14, 0.97)" : RENDER.LABEL_BG;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5 / scale);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  const startY = y - (layout.lines.length - 1) * layout.lineHeight * 0.5;
  for (let i = 0; i < layout.lines.length; i++) {
    ctx.fillText(layout.lines[i], x + (options.compact && !options.expanded ? 6 : 9), startY + i * layout.lineHeight);
  }
  ctx.restore();
}

function drawBadgeObject(ctx, object) {
  const scale = Number(app.canvas?.ds?.scale) || 1;
  const radius = object.radius || 16;
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.fillStyle = object.color;
  ctx.strokeStyle = "rgba(8, 10, 12, 0.92)";
  ctx.lineWidth = Math.max(2, 2 / scale);
  ctx.beginPath();
  ctx.arc(object.pos[0], object.pos[1], radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#071012";
  ctx.font = `700 ${Math.max(RENDER.BADGE_FONT_MIN, Math.min(RENDER.BADGE_FONT_MAX, RENDER.BADGE_FONT_BASE / Math.sqrt(scale)))}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(object.text, object.pos[0], object.pos[1] + 0.5);
  ctx.restore();
}

function drawArrowObject(ctx, object) {
  const points = Array.isArray(object.points) && object.points.length >= 2 ? object.points : [object.from, object.to];
  const from = points[points.length - 2];
  const to = points[points.length - 1];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.max(12, object.width * 3.2);
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.lineTo(to[0] - ux * head, to[1] - uy * head);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - ux * head - uy * head * 0.45, to[1] - uy * head + ux * head * 0.45);
  ctx.lineTo(to[0] - ux * head + uy * head * 0.45, to[1] - uy * head - ux * head * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const labelPos = object.labelPos || [(from[0] + to[0]) * 0.5 + 10, (from[1] + to[1]) * 0.5 - 12];
  drawTextLabel(ctx, object.label, labelPos[0], labelPos[1], object.color, { opacity: object.opacity });
}

function drawHighlightObject(ctx, object) {
  const rect = object.rect;
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = object.width;
  drawRoundedRect(ctx, rect[0], rect[1], rect[2], rect[3], 12);
  ctx.stroke();
  ctx.globalAlpha = Math.min(object.source === "ai" ? 0.045 : 0.075, object.opacity * 0.08);
  ctx.fill();
  ctx.restore();
  drawTextLabel(ctx, object.label, rect[0], rect[1] - 16, object.color, { opacity: object.opacity });
}

function drawRectObject(ctx, object) {
  const rect = object.rect;
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.strokeStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawRoundedRect(ctx, rect[0], rect[1], rect[2], rect[3], 8);
  ctx.stroke();
  ctx.restore();
}

function drawEllipseObject(ctx, object) {
  const rect = object.rect;
  const rx = Math.max(0.5, rect[2] * 0.5);
  const ry = Math.max(0.5, rect[3] * 0.5);
  ctx.save();
  ctx.globalAlpha = object.opacity;
  ctx.strokeStyle = object.color;
  ctx.lineWidth = object.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.ellipse(rect[0] + rx, rect[1] + ry, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawLabelLeader(ctx, object, expanded) {
  if (object.source !== "ai" || object.nodeId == null) return;
  const node = getNodeById(object.nodeId);
  if (!node) return;
  const rect = object.widget ? widgetRect(node, object.widget) || nodeRect(node) : nodeRect(node);
  const labelBox = labelHitBBox(object, expanded);
  const targetCx = rect[0] + rect[2] * 0.5;
  const targetCy = rect[1] + rect[3] * 0.5;
  const labelCx = labelBox[0] + labelBox[2] * 0.5;
  const labelCy = labelBox[1] + labelBox[3] * 0.5;
  const dx = labelCx - targetCx;
  const dy = labelCy - targetCy;
  const distance = Math.hypot(dx, dy);
  if (distance < 12 || distance > 240) return;
  const labelEdgeX = clamp(targetCx, labelBox[0], labelBox[0] + labelBox[2]);
  const labelEdgeY = clamp(targetCy, labelBox[1], labelBox[1] + labelBox[3]);
  const nodeEdgeX = clamp(labelCx, rect[0], rect[0] + rect[2]);
  const nodeEdgeY = clamp(labelCy, rect[1], rect[1] + rect[3]);
  const scale = Number(app.canvas?.ds?.scale) || 1;
  ctx.save();
  const touching = bboxIntersects(labelBox, paddedRect(rect, 4), 0);
  ctx.globalAlpha *= clamp(Number(object.opacity) || 1, 0.05, 1) * (touching ? 0.22 : 0.42);
  ctx.strokeStyle = object.color;
  ctx.lineWidth = Math.max(0.9, 1.2 / scale);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(labelEdgeX, labelEdgeY);
  ctx.lineTo(nodeEdgeX, nodeEdgeY);
  ctx.stroke();
  ctx.restore();
}

function drawObject(ctx, object) {
  const renderObject = { ...object, color: objectDisplayColor(object) };
  if (renderObject.type === "arrow") {
    drawArrowObject(ctx, renderObject);
  } else if (renderObject.type === "highlight") {
    drawHighlightObject(ctx, renderObject);
  } else if (renderObject.type === "rect") {
    drawRectObject(ctx, renderObject);
  } else if (renderObject.type === "ellipse") {
    drawEllipseObject(ctx, renderObject);
  } else if (renderObject.type === "label") {
    const expanded = labelIsExpanded(renderObject);
    drawLabelLeader(ctx, renderObject, expanded);
    drawTextLabel(ctx, labelDisplayText(renderObject, expanded), renderObject.pos[0], renderObject.pos[1], renderObject.color, { compact: labelIsCompact(renderObject), expanded, emphasis: expanded, opacity: renderObject.opacity });
  } else if (renderObject.type === "badge") {
    drawBadgeObject(ctx, renderObject);
  }
}

function ensureOverlayCanvas() {
  const baseCanvas = app.canvas?.canvas || app.canvasEl;
  if (!baseCanvas || !baseCanvas.parentElement) return null;
  let overlay = state.overlayCanvas;
  if (!overlay || !overlay.isConnected) {
    overlay = document.createElement("canvas");
    overlay.id = "showme-overlay-canvas";
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = OVERLAY_Z_INDEX;
    baseCanvas.parentElement.appendChild(overlay);
    state.overlayCanvas = overlay;
  } else if (overlay.parentElement !== baseCanvas.parentElement) {
    baseCanvas.parentElement.appendChild(overlay);
  }
  if (overlay.style.zIndex !== OVERLAY_Z_INDEX) {
    overlay.style.zIndex = OVERLAY_Z_INDEX;
  }
  const dpr = globalThis.devicePixelRatio || 1;
  const width = baseCanvas.clientWidth || baseCanvas.width;
  const height = baseCanvas.clientHeight || baseCanvas.height;
  const targetWidth = Math.max(1, Math.round(width * dpr));
  const targetHeight = Math.max(1, Math.round(height * dpr));
  if (overlay.width !== targetWidth) overlay.width = targetWidth;
  if (overlay.height !== targetHeight) overlay.height = targetHeight;
  return overlay;
}

function visibleRectFromArg(visibleRect) {
  if (Array.isArray(visibleRect) && visibleRect.length >= 4) {
    return [visibleRect[0], visibleRect[1], visibleRect[2], visibleRect[3]];
  }
  const area = app.canvas?.ds?.visible_area;
  if (Array.isArray(area) && area.length >= 4) return [area[0], area[1], area[2] - area[0], area[3] - area[1]];
  return null;
}

function drawAnnotations(_ctx, visibleRect) {
  if (!state.installed) return;
  positionTextEditor();
  const overlay = ensureOverlayCanvas();
  if (!overlay) return;
  const store = getStore(false);
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (store.settings.visible === false && !state.currentStroke && !state.currentObject) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const ds = app.canvas?.ds;
  const scale = Number(ds?.scale) || 1;
  const offset = ds?.offset || [0, 0];
  ctx.scale(dpr, dpr);
  ctx.scale(scale, scale);
  ctx.translate(offset[0], offset[1]);
  const rect = visibleRectFromArg(visibleRect);
  if (store.settings.visible !== false) {
    state.compactAiStepLabels = store.objects.filter(isAiStepLabel).length > COMPACT_STEP_LABEL_THRESHOLD;
    const expandedIds = expandedObjectIds();
    const regularObjects = [];
    const raisedObjects = [];
    for (const object of store.objects) {
      if (expandedIds.has(object.id)) raisedObjects.push(object);
      else regularObjects.push(object);
    }
    for (const object of regularObjects) {
      if (rect && !bboxIntersects(object.bbox, rect, 80)) continue;
      drawObject(ctx, object);
    }
    for (const stroke of store.strokes) {
      if (rect && !bboxIntersects(stroke.bbox, rect, 60)) continue;
      drawStroke(ctx, stroke);
    }
    for (const object of raisedObjects) {
      if (rect && !bboxIntersects(object.bbox, rect, 220)) continue;
      drawObject(ctx, object);
    }
    drawSelectionBox(ctx, selectedTargetObject(store));
  }
  if (state.currentStroke) drawStroke(ctx, state.currentStroke);
  if (state.currentObject) drawObject(ctx, state.currentObject);
}

function chainCallback(object, property, callback) {
  if (!object) return null;
  const original = object?.[property];
  const wrapped = function showmeChainedCallback(...args) {
    const result = original?.apply(this, args);
    const next = callback.apply(this, args);
    return next === undefined ? result : next;
  };
  object[property] = wrapped;
  return () => {
    if (object[property] === wrapped) {
      object[property] = original;
    }
  };
}

function getNodeById(nodeId) {
  const graph = getGraph();
  if (!graph || nodeId == null) return null;
  return graph.getNodeById?.(nodeId)
    || graph.getNodeById?.(Number(nodeId))
    || (graph._nodes || []).find((node) => String(node.id) === String(nodeId))
    || null;
}

function slotIndex(node, io, slotName) {
  const slots = io === "input" ? node?.inputs : node?.outputs;
  if (!Array.isArray(slots) || !slots.length) return 0;
  const wanted = String(slotName || "").toLowerCase();
  if (!wanted) return 0;
  const exact = slots.findIndex((slot) => String(slot?.name || "").toLowerCase() === wanted);
  if (exact >= 0) return exact;
  const typed = slots.findIndex((slot) => String(slot?.type || "").toLowerCase() === wanted);
  return typed >= 0 ? typed : 0;
}

function nodeSlotPosition(node, isInput, index, slotCount) {
  if (typeof node.getConnectionPos === "function") {
    const out = [0, 0];
    try {
      node.getConnectionPos(isInput, index, out);
      return clonePoint(out);
    } catch (err) {
      console.debug("ShowMe: node.getConnectionPos fallback", err);
    }
  }
  const pos = node.pos || [0, 0];
  const size = node.size || [180, 80];
  const y = pos[1] + RENDER.NODE_HEADER_OFFSET + ((index + 0.5) / slotCount) * Math.max(RENDER.NODE_HEADER_OFFSET, size[1] - RENDER.NODE_HEADER_OFFSET);
  return [pos[0] + (isInput ? 0 : size[0]), y];
}

function slotPosition(ref) {
  if (Array.isArray(ref)) return clonePoint(ref);
  const node = getNodeById(ref?.nodeId ?? ref?.node);
  if (!node) return null;
  const io = ref?.io === "output" ? "output" : "input";
  const index = slotIndex(node, io, ref?.slot);
  const isInput = io === "input";
  const slots = isInput ? node.inputs : node.outputs;
  const slotCount = Math.max(1, Array.isArray(slots) ? slots.length : 1);
  return nodeSlotPosition(node, isInput, index, slotCount);
}

function slotPositionByIndex(node, io, rawIndex) {
  if (!node) return null;
  const isInput = io !== "output";
  const slots = isInput ? node.inputs : node.outputs;
  const slotCount = Math.max(1, Array.isArray(slots) ? slots.length : 1);
  const index = Math.max(0, Math.min(slotCount - 1, Math.floor(Number(rawIndex) || 0)));
  return nodeSlotPosition(node, isInput, index, slotCount);
}

function graphCableSegments(graph = getGraph()) {
  return compactGraphLinks(graph)
    .map((link) => {
      const source = getNodeById(link?.origin_id);
      const target = getNodeById(link?.target_id);
      const from = slotPositionByIndex(source, "output", link?.origin_slot);
      const to = slotPositionByIndex(target, "input", link?.target_slot);
      return from && to ? [from, to] : null;
    })
    .filter(Boolean);
}

function nodeRect(node) {
  const pos = node?.pos || [0, 0];
  const size = node?.size || [180, 80];
  const title = globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 24;
  return [pos[0] - 12, pos[1] - title - 10, size[0] + 24, size[1] + title + 22];
}

function widgetIndex(node, widgetName) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const wanted = String(widgetName || "").toLowerCase();
  if (!wanted) return -1;
  return widgets.findIndex((widget) => {
    const name = String(widget?.name || widget?.label || widget?.type || "").toLowerCase();
    return name === wanted;
  });
}

function widgetRect(node, widgetName) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const index = widgetIndex(node, widgetName);
  if (index < 0) return null;
  const widget = widgets[index] || {};
  const pos = node?.pos || [0, 0];
  const size = node?.size || [180, 80];
  const nodeWidth = Math.max(80, Number(size[0]) || 180);
  const widgetHeight = Math.max(18, Number(widget?.height) || globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 20);
  const nodeTitleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 24;
  const left = pos[0] + 8;
  const width = Math.max(64, nodeWidth - 16);
  const isCustomText = String(widget?.type || "").toLowerCase() === "customtext";
  if (Number.isFinite(Number(widget?.y))) {
    const y = pos[1] + Number(widget.y) - 2;
    if (isCustomText) {
      const nextWidget = widgets.slice(index + 1).find((item) => Number.isFinite(Number(item?.y)));
      const nextY = nextWidget ? pos[1] + Number(nextWidget.y) - 6 : pos[1] + Math.max(70, Number(size[1]) || 80) - 8;
      return [left, y, width, Math.max(widgetHeight + 4, nextY - y)];
    }
    return [left, y, width, widgetHeight + 4];
  }
  const y = pos[1] + nodeTitleHeight + 8 + index * (widgetHeight + 4);
  return [left, y, width, widgetHeight + 4];
}

function widgetIsCustomText(node, widgetName) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const index = widgetIndex(node, widgetName);
  if (index < 0) return false;
  const widget = widgets[index] || {};
  return String(widget?.type || "").toLowerCase() === "customtext";
}

function widgetDomGraphRect(widget) {
  const element = widget?.element || widget?.inputEl;
  const rect = element?.getBoundingClientRect?.();
  return clientRectToGraph(rect);
}

function customTextBlockerRects() {
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  const blockers = [];
  nodes.forEach((node) => {
    (node?.widgets || []).forEach((widget) => {
      if (String(widget?.type || "").toLowerCase() !== "customtext") return;
      const name = String(widget?.name || widget?.label || widget?.type || "");
      const rect = widgetDomGraphRect(widget) || (name ? widgetRect(node, name) : null);
      if (rect) blockers.push(paddedRect(rect, 3));
    });
  });
  return blockers;
}

function uiBlockerRects() {
  const blockers = [];
  const panel = state.toolbar?.querySelector(".showme-panel");
  if (panel && state.open) {
    const rect = clientRectToGraph(panel.getBoundingClientRect?.());
    if (rect) blockers.push(paddedRect(rect, 8));
  }
  return blockers;
}

function debugSlotSnapshot(slot, index) {
  return {
    index,
    name: String(slot?.name || "").slice(0, 80),
    type: String(slot?.type || "").slice(0, 80),
    link: slot?.link ?? null,
    links: Array.isArray(slot?.links) ? slot.links.slice(0, 20) : [],
  };
}

function widgetStoredValue(node, widget, index) {
  if (widget && widget.value != null && String(widget.value) !== "") return widget.value;
  const values = Array.isArray(node?.widgets_values)
    ? node.widgets_values
    : (Array.isArray(node?.widgetsValues) ? node.widgetsValues : []);
  return index >= 0 && index < values.length ? values[index] : "";
}

function debugWidgetSnapshot(node, widget, index) {
  const name = String(widget?.name || widget?.label || widget?.type || "").slice(0, 80);
  return {
    index,
    name,
    type: String(widget?.type || "").slice(0, 80),
    value: String(widgetStoredValue(node, widget, index) ?? "").slice(0, 180),
    y: Number.isFinite(Number(widget?.y)) ? Number(widget.y) : null,
    height: Number.isFinite(Number(widget?.height)) ? Number(widget.height) : null,
    rect: name ? widgetRect(node, name) : null,
  };
}

function debugNodeSnapshot(node) {
  return {
    id: node?.id,
    type: String(node?.type || ""),
    title: String(node?.title || ""),
    pos: Array.from(node?.pos || [0, 0]),
    size: Array.from(node?.size || [180, 80]),
    rect: nodeRect(node),
    selected: Boolean(app.canvas?.selected_nodes?.[node?.id]),
    inputs: (node?.inputs || []).map(debugSlotSnapshot),
    outputs: (node?.outputs || []).map(debugSlotSnapshot),
    widgets: (node?.widgets || []).map((widget, index) => debugWidgetSnapshot(node, widget, index)),
  };
}

function debugObjectSnapshot(object, index) {
  return {
    index,
    type: object?.type,
    source: object?.source,
    role: object?.role,
    nodeId: object?.nodeId,
    stepIndex: object?.stepIndex,
    color: object?.color,
    opacity: object?.opacity,
    width: object?.width,
    label: object?.label || "",
    text: object?.text || "",
    from: object?.from,
    to: object?.to,
    points: object?.points,
    pos: object?.pos,
    rect: object?.rect,
    bbox: object?.bbox,
    radius: object?.radius,
  };
}

function debugStrokeSnapshot(stroke, index) {
  return {
    index,
    id: stroke?.id,
    color: stroke?.color,
    size: stroke?.size,
    opacity: stroke?.opacity,
    pointCount: Array.isArray(stroke?.points) ? stroke.points.length : 0,
    firstPoint: stroke?.points?.[0],
    lastPoint: stroke?.points?.[stroke.points.length - 1],
    bbox: stroke?.bbox,
  };
}

function debugGraphSnapshot() {
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  return {
    selectedNodeIds: getSelectedNodeIds(),
    nodeCount: nodes.length,
    linkCount: compactGraphLinks(graph).length,
    nodes: nodes.map(debugNodeSnapshot),
  };
}

function debugStoreSnapshot() {
  const store = getStore(false);
  return {
    visible: store.settings.visible,
    objects: store.objects.map(debugObjectSnapshot),
    strokes: store.strokes.map(debugStrokeSnapshot),
  };
}

function installDebugApi() {
  const debugApi = {
    enable() {
      try {
        globalThis.localStorage?.setItem(DEBUG_KEY, "1");
      } catch (err) {
        console.debug("ShowMe: debug flag persist failed, falling back to in-memory", err);
        globalThis.__SHOWME_DEBUG = true;
      }
      globalThis.__SHOWME_DEBUG = true;
      debugLog("debug enabled", { key: DEBUG_KEY });
    },
    disable() {
      try {
        globalThis.localStorage?.removeItem(DEBUG_KEY);
      } catch (err) {
        console.debug("ShowMe: debug flag clear failed", err);
      }
      globalThis.__SHOWME_DEBUG = false;
      globalThis.console?.info?.("[ShowMe] debug disabled");
    },
    snapshot() {
      const snapshot = {
        graph: debugGraphSnapshot(),
        store: debugStoreSnapshot(),
      };
      globalThis.console?.log?.("[ShowMe] snapshot", snapshot);
      return snapshot;
    },
    uninstall,
    listenerCount() {
      return state.installedListeners.length;
    },
  };
  globalThis.ShowMeDebug = debugApi;
}

function stepDisplayIndex(step, index) {
  return Number.isFinite(Number(step?.stepIndex)) ? Math.max(1, Math.floor(Number(step.stepIndex))) : index + 1;
}

function stepColorOrdinal(step, index) {
  const explicit = Number(step?.stepIndex);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit) - 1;
  const nodeId = Number(step?.nodeId);
  if (Number.isFinite(nodeId)) return Math.abs(Math.floor(nodeId));
  return index;
}

function stepCalloutText(step, index) {
  const title = String(step?.title || "").trim();
  const note = String(step?.note || "").trim();
  const prefix = `${stepDisplayIndex(step, index)}.`;
  if (title && note) return `${prefix} ${title} - ${note}`;
  if (title) return `${prefix} ${title}`;
  return note ? `${prefix} ${note}` : `${prefix} Step`;
}

function aiStyleFromState() {
  const rawSize = Math.max(1, Number(state.size) || AI_STYLE_DEFAULT_SIZE);
  const rawOpacity = clamp(Number(state.opacity) || AI_STYLE_DEFAULT_OPACITY, 0.1, 1);
  return {
    sizeScale: clamp(rawSize / AI_STYLE_DEFAULT_SIZE, 0.65, 2.2),
    opacityScale: clamp(rawOpacity / AI_STYLE_DEFAULT_OPACITY, 0.12, 1.1),
  };
}

function aiStyledWidth(baseWidth, style = aiStyleFromState()) {
  return Math.max(1, Math.min(22, Number(baseWidth) * style.sizeScale));
}

function aiStyledBadgeRadius(baseRadius, style = aiStyleFromState()) {
  const badgeScale = clamp(0.78 + (style.sizeScale - 1) * 0.38, 0.78, 1.36);
  return Math.max(10, Math.min(30, Number(baseRadius) * badgeScale));
}

function aiStyledOpacity(baseOpacity, style = aiStyleFromState()) {
  return clamp(Number(baseOpacity) * style.opacityScale, 0.06, 1);
}

function paddedRect(rect, pad) {
  return [rect[0] - pad, rect[1] - pad, rect[2] + pad * 2, rect[3] + pad * 2];
}

function rectIntersectionArea(a, b, pad = 0) {
  const expanded = pad ? paddedRect(b, pad) : b;
  const x1 = Math.max(a[0], expanded[0]);
  const y1 = Math.max(a[1], expanded[1]);
  const x2 = Math.min(a[0] + a[2], expanded[0] + expanded[2]);
  const y2 = Math.min(a[1] + a[3], expanded[1] + expanded[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function labelOverlapScore(box, occupied, pad = 4) {
  return occupied.reduce((score, rect) => {
    const area = rectIntersectionArea(box, rect, pad);
    return area > 0 ? score + 1000 + area : score;
  }, 0);
}

function labelCableScore(box, cables = []) {
  return cables.reduce((score, cable) => {
    const from = cable?.[0];
    const to = cable?.[1];
    if (!Array.isArray(from) || !Array.isArray(to)) return score;
    if (segmentIntersectsRect(from, to, box, 10)) return score + 60_000;
    if (segmentIntersectsRect(from, to, paddedRect(box, 42), 0)) return score + 2_000;
    return score;
  }, 0);
}

function labelOverlapDetails(box, occupied, pad = 4) {
  return occupied.reduce((details, rect) => {
    const area = rectIntersectionArea(box, rect, pad);
    if (area <= 0) return details;
    details.total += 1000 + area;
    if (!details.worst || area > details.worst.area) details.worst = { rect, area };
    return details;
  }, { total: 0, worst: null });
}

function labelBoxCenter(box) {
  return [box[0] + box[2] * 0.5, box[1] + box[3] * 0.5];
}

function labelDistanceToAnchor(box, anchor) {
  const center = labelBoxCenter(box);
  return Math.hypot(center[0] - anchor[0], center[1] - anchor[1]);
}

function boxToLabelPos(box) {
  return [box[0], box[1] + box[3] * 0.5];
}

function rectArea(rect) {
  return Math.max(0, Number(rect?.[2]) || 0) * Math.max(0, Number(rect?.[3]) || 0);
}

function rectOverlapRatio(a, b) {
  const area = rectIntersectionArea(a, b);
  const base = Math.min(rectArea(a), rectArea(b));
  return base > 0 ? area / base : 0;
}

function calloutOverlapScore(box, occupied, softRects = []) {
  return occupied.reduce((score, rect) => {
    const area = rectIntersectionArea(box, rect, 2);
    if (area <= 0) return score;
    const isSoft = softRects.some((softRect) => softRect && rectOverlapRatio(rect, softRect) > 0.42);
    return score + (isSoft ? area * 1.25 : 1800 + area * 14);
  }, 0);
}

function calloutStackForNode(options, nodeId) {
  const stacks = options.calloutStacks || (options.calloutStacks = new Map());
  const key = String(nodeId ?? "");
  if (!stacks.has(key)) stacks.set(key, { left: 0, right: 0, top: 0, bottom: 0, preferred: "" });
  return stacks.get(key);
}

function reserveNodeCalloutPosition(node, text, occupied, options = {}) {
  const nodeBox = options.nodeBox || nodeRect(node);
  const targetRect = options.targetRect || nodeBox;
  const compact = Boolean(options.compact);
  const measureOptions = { compact };
  const layout = measureLabelBox(text, measureOptions);
  const width = layout.boxWidth;
  const height = layout.boxHeight;
  const gap = compact ? 8 : 10;
  const stepY = height + 5;
  const graphBox = options.graphBox || computeGraphBoundingBox() || nodeBox;
  const graphCx = graphBox[0] + graphBox[2] * 0.5;
  const nodeCx = nodeBox[0] + nodeBox[2] * 0.5;
  const outward = nodeCx >= graphCx ? "right" : "left";
  const inward = outward === "right" ? "left" : "right";
  const anchorY = targetRect[1] + targetRect[3] * 0.5;
  const headerY = nodeBox[1] + Math.min(RENDER.NODE_HEADER_OFFSET * 0.55, Math.max(12, nodeBox[3] * 0.22));
  const anchor = options.anchor === "widget"
    ? [targetRect[0] + targetRect[2] * 0.5, anchorY]
    : [nodeCx, headerY];
  const stack = calloutStackForNode(options, node?.id ?? options.nodeId);
  const preferredSide = stack.preferred || outward;
  const sidePriority = (side) => {
    if (side === preferredSide) return 0;
    if (side === outward) return stack.preferred ? 1 : 0;
    if (side === "top") return 2;
    if (side === "bottom") return 3;
    if (side === inward) return 4;
    return 5;
  };
  const candidates = [];
  const add = (side, x, y, level = 0, variant = 0) => {
    const baseCount = stack[side] || 0;
    const count = baseCount + level;
    const rank = sidePriority(side) * 120 + count * 52 + variant;
    candidates.push({ side, pos: [x, y], rank, count, level });
  };

  for (let level = 0; level < 4; level += 1) {
    const rightY = anchorY + (stack.right + level) * stepY;
    const leftY = anchorY + (stack.left + level) * stepY;
    const topY = nodeBox[1] - height * 0.5 - gap - (stack.top + level) * stepY;
    const bottomY = nodeBox[1] + nodeBox[3] + height * 0.5 + gap + (stack.bottom + level) * stepY;
    add("right", nodeBox[0] + nodeBox[2] + gap, rightY, level);
    add("left", nodeBox[0] - width - gap, leftY, level);
    add("top", nodeBox[0] + 8, topY, level);
    add("top", nodeBox[0] + nodeBox[2] - width - 8, topY, level, 8);
    add("bottom", nodeBox[0] + 8, bottomY, level);
    add("bottom", nodeBox[0] + nodeBox[2] - width - 8, bottomY, level, 8);
  }

  let best = null;
  const softRects = [nodeBox, targetRect, badgeBBoxForRect(nodeBox)];
  for (const candidate of candidates) {
    const box = labelBBox(candidate.pos, text, measureOptions);
    const overlap = calloutOverlapScore(box, occupied, softRects);
    const cable = labelCableScore(box, options.cables) * 0.22;
    const distance = labelDistanceToAnchor(box, anchor);
    const score = overlap + cable + distance * 5.5 + candidate.rank;
    if (!best || score < best.score) best = { ...candidate, box, score };
  }

  if (!best) {
    const pos = [nodeBox[0] + 8, nodeBox[1] - height * 0.5 - gap];
    const box = labelBBox(pos, text, measureOptions);
    occupied.push(paddedRect(box, 4));
    return { pos, side: "top" };
  }
  stack[best.side] = Math.max(stack[best.side] || 0, best.count + 1);
  stack.preferred = best.side;
  occupied.push(paddedRect(best.box, 4));
  return { pos: best.pos, side: best.side };
}

function repelLabelBox(box, occupied, options = {}) {
  const next = box.slice();
  const maxMove = Number(options.maxMove) || 140;
  const start = labelBoxCenter(box);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const detail = labelOverlapDetails(next, occupied, 4);
    if (!detail.worst) break;
    const block = paddedRect(detail.worst.rect, 4);
    const center = labelBoxCenter(next);
    const blockCenter = labelBoxCenter(block);
    const overlapX = Math.min(next[0] + next[2], block[0] + block[2]) - Math.max(next[0], block[0]);
    const overlapY = Math.min(next[1] + next[3], block[1] + block[3]) - Math.max(next[1], block[1]);
    if (overlapX <= 0 || overlapY <= 0) break;
    if (overlapX < overlapY) {
      next[0] += (center[0] < blockCenter[0] ? -1 : 1) * (overlapX + 6);
    } else {
      next[1] += (center[1] < blockCenter[1] ? -1 : 1) * (overlapY + 6);
    }
    const moved = labelBoxCenter(next);
    const moveDistance = Math.hypot(moved[0] - start[0], moved[1] - start[1]);
    if (moveDistance > maxMove) {
      const ratio = maxMove / Math.max(moveDistance, 1);
      const constrained = [
        start[0] + (moved[0] - start[0]) * ratio,
        start[1] + (moved[1] - start[1]) * ratio,
      ];
      next[0] = constrained[0] - next[2] * 0.5;
      next[1] = constrained[1] - next[3] * 0.5;
      break;
    }
  }
  return next;
}

function orderedLabelDirections(anchor, graphBox) {
  if (!graphBox) return ["top", "left", "bottom", "right"];
  const graphCx = graphBox[0] + graphBox[2] * 0.5;
  const graphCy = graphBox[1] + graphBox[3] * 0.5;
  const dx = anchor[0] - graphCx;
  const dy = anchor[1] - graphCy;
  const horizontal = dx >= 0 ? "right" : "left";
  const vertical = dy >= 0 ? "bottom" : "top";
  const oppositeHorizontal = horizontal === "right" ? "left" : "right";
  const oppositeVertical = vertical === "bottom" ? "top" : "bottom";
  return Math.abs(dx) >= Math.abs(dy)
    ? [horizontal, vertical, oppositeVertical, oppositeHorizontal]
    : [vertical, horizontal, oppositeHorizontal, oppositeVertical];
}

function computeGraphBoundingBox() {
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  let box = null;
  for (const node of nodes) {
    if (!node) continue;
    const r = nodeRect(node);
    box = box ? unionBBox(box, r) : r.slice();
  }
  return box;
}

function reserveAnchoredLabelPosition(rect, text, occupied, options = {}) {
  const width = estimatedLabelWidth(text);
  const height = estimatedLabelHeight(text);
  const gap = 16;
  const anchor = [rect[0] + rect[2] * 0.5, rect[1] + rect[3] * 0.5];
  if (!options.graphBox) options.graphBox = computeGraphBoundingBox();
  const graphBox = options.graphBox || rect;
  const directions = orderedLabelDirections(anchor, graphBox);
  const allCandidates = [];
  const seenCandidates = new Set();
  const addCandidate = (pos) => {
    const normalized = [Number(pos[0]) || 0, Number(pos[1]) || 0];
    const key = `${Math.round(normalized[0] * 2) / 2}:${Math.round(normalized[1] * 2) / 2}`;
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    allCandidates.push(normalized);
  };

  const sideCandidates = (direction) => {
    const list = [];
    const stepH = height + 6;
    const stepW = Math.max(48, width * 0.45);
    if (direction === "top" || direction === "bottom") {
      const y = direction === "top"
        ? rect[1] - height * 0.5 - gap
        : rect[1] + rect[3] + height * 0.5 + gap;
      const baseX = rect[0] + rect[2] * 0.5 - width * 0.5;
      const xs = [
        baseX,
        rect[0] + 8,
        rect[0] + rect[2] - width - 8,
        baseX - stepW,
        baseX + stepW,
        baseX - stepW * 2,
        baseX + stepW * 2,
        baseX - stepW * 3,
        baseX + stepW * 3,
      ];
      for (const x of xs) list.push([x, y]);
    } else {
      const x = direction === "left"
        ? rect[0] - width - gap
        : rect[0] + rect[2] + gap;
      const baseY = rect[1] + Math.min(Math.max(rect[3], 0) * 0.5, 42);
      const lowerY = rect[1] + rect[3] - Math.min(Math.max(rect[3], 0) * 0.25, 58);
      const ys = [
        baseY,
        baseY - stepH,
        baseY + stepH,
        baseY - stepH * 1.8,
        baseY + stepH * 1.8,
        baseY - stepH * 2.6,
        baseY + stepH * 2.6,
        lowerY,
        lowerY - stepH,
        lowerY + stepH,
      ];
      for (const y of ys) list.push([x, y]);
    }
    list.forEach(addCandidate);
    return list;
  };

  for (const direction of directions) {
    let bestClean = null;
    for (const pos of sideCandidates(direction)) {
      const box = labelBBox(pos, text);
      if (labelOverlapScore(box, occupied) !== 0) continue;
      if (labelCableScore(box, options.cables) > 0) continue;
      const dx = (box[0] + box[2] * 0.5) - anchor[0];
      const dy = (box[1] + box[3] * 0.5) - anchor[1];
      const distance = Math.hypot(dx, dy);
      if (!bestClean || distance < bestClean.distance) bestClean = { pos, box, distance };
    }
    if (bestClean) {
      occupied.push(paddedRect(bestClean.box, 6));
      return bestClean.pos;
    }
  }

  let bestLocal = null;
  const localMaxMove = Math.max(72, Math.min(180, Math.max(width, height) * 0.55));
  for (const pos of allCandidates) {
    const originalBox = labelBBox(pos, text);
    const box = repelLabelBox(originalBox, occupied, { maxMove: localMaxMove });
    const overlap = labelOverlapDetails(box, occupied).total;
    const cable = labelCableScore(box, options.cables);
    const distance = labelDistanceToAnchor(box, anchor);
    const originalCenter = labelBoxCenter(originalBox);
    const center = labelBoxCenter(box);
    const drift = Math.hypot(center[0] - originalCenter[0], center[1] - originalCenter[1]);
    const score = overlap * 1.4 + cable + distance * 7 + drift * 2.5;
    if (!bestLocal || score < bestLocal.score) bestLocal = { pos: boxToLabelPos(box), box, score };
  }
  if (bestLocal) {
    occupied.push(paddedRect(bestLocal.box, 6));
    return bestLocal.pos;
  }
  return clonePoint(anchor);
}

function warningLabelText(item) {
  return item?.message || item?.label || "Check this setting.";
}

function reservePointLabelPosition(point, text, occupied, options = {}) {
  return reserveAnchoredLabelPosition([point[0] - 1, point[1] - 1, 2, 2], text, occupied, options);
}

function pointOnPolyline(points, ratio) {
  const safePoints = (Array.isArray(points) ? points : []).filter(Array.isArray);
  if (!safePoints.length) return { point: [0, 0], normal: [0, -1] };
  if (safePoints.length === 1) return { point: clonePoint(safePoints[0]), normal: [0, -1] };
  const lengths = [];
  let total = 0;
  for (let index = 1; index < safePoints.length; index += 1) {
    const a = safePoints[index - 1];
    const b = safePoints[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(length);
    total += length;
  }
  if (total <= 0) return { point: clonePoint(safePoints[0]), normal: [0, -1] };
  let remaining = clamp(Number(ratio) || 0, 0, 1) * total;
  for (let index = 1; index < safePoints.length; index += 1) {
    const segmentLength = lengths[index - 1];
    const a = safePoints[index - 1];
    const b = safePoints[index];
    if (remaining > segmentLength && index < safePoints.length - 1) {
      remaining -= segmentLength;
      continue;
    }
    const t = segmentLength > 0 ? clamp(remaining / segmentLength, 0, 1) : 0;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.max(1, segmentLength);
    return {
      point: [a[0] + dx * t, a[1] + dy * t],
      normal: [-dy / length, dx / length],
    };
  }
  const last = safePoints[safePoints.length - 1];
  return { point: clonePoint(last), normal: [0, -1] };
}

function reserveConnectionLabelPosition(points, text, occupied, options = {}) {
  if (!text) return null;
  const lane = Number(options.lane) || 0;
  const absLane = Math.min(5, Math.abs(lane));
  const direction = lane < 0 ? -1 : 1;
  const layout = measureLabelBox(text);
  const anchors = [0.34, 0.66, 0.5, 0.22, 0.78];
  const baseOffset = 20 + absLane * 7;
  const offsets = [
    direction * baseOffset,
    -direction * baseOffset,
    direction * (baseOffset + 22),
    -direction * (baseOffset + 22),
  ];
  let best = null;
  for (const anchor of anchors) {
    const { point, normal } = pointOnPolyline(points, anchor);
    const perpendicular = Math.hypot(normal[0], normal[1]) > 0.01 ? normal : [0, -1];
    for (const offset of offsets) {
      const pos = [
        point[0] + perpendicular[0] * offset - layout.boxWidth * 0.5,
        point[1] + perpendicular[1] * offset,
      ];
      const box = labelBBox(pos, text);
      const overlap = labelOverlapScore(box, occupied, 8);
      const distancePenalty = Math.abs(anchor - 0.5) * 18 + Math.abs(offset) * 0.04;
      const score = overlap + distancePenalty;
      if (!best || score < best.score) best = { pos, box, score };
      if (overlap <= 0) {
        occupied.push(box);
        return pos;
      }
    }
  }
  if (!best) return reservePointLabelPosition(points?.[0] || [0, 0], text, occupied);
  occupied.push(best.box);
  return best.pos;
}

function badgePositionForRect(rect) {
  return [rect[0] - 2, rect[1] - 2];
}

function badgeBBoxForRect(rect, radius = 16) {
  const pos = badgePositionForRect(rect);
  return [pos[0] - radius - 3, pos[1] - radius - 3, radius * 2 + 6, radius * 2 + 6];
}

function annotationOccupancyRects(objects = []) {
  const rects = [];
  for (const object of objects || []) {
    if (!object) continue;
    if (object.type === "label" && Array.isArray(object.pos)) {
      rects.push(labelHitBBox(object, labelIsExpanded(object)));
    } else if (object.type === "badge" && Array.isArray(object.bbox)) {
      rects.push(object.bbox);
    } else if (object.type === "arrow" && object.label && Array.isArray(object.labelPos)) {
      rects.push(labelBBox(object.labelPos, object.label));
    }
  }
  return rects.filter(Boolean);
}

function reservePlanNodeRects(plan, existingObjects = []) {
  const occupied = [];
  const seen = new Set();
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  nodes.forEach((node) => {
    if (node) occupied.push(paddedRect(nodeRect(node), 4));
  });
  customTextBlockerRects().forEach((rect) => occupied.push(rect));
  uiBlockerRects().forEach((rect) => occupied.push(rect));
  const addNode = (nodeId, widget) => {
    const key = `${nodeId ?? ""}:${widget || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const node = getNodeById(nodeId);
    if (!node) return;
    const rect = widget ? widgetRect(node, widget) || nodeRect(node) : nodeRect(node);
    occupied.push(paddedRect(rect, 2));
  };
  (Array.isArray(plan?.steps) ? plan.steps : []).forEach((step) => {
    addNode(step?.nodeId);
    const node = getNodeById(step?.nodeId);
    if (node) occupied.push(badgeBBoxForRect(nodeRect(node)));
  });
  (Array.isArray(plan?.focus) ? plan.focus : []).forEach((item) => addNode(item?.nodeId, item?.widget));
  (Array.isArray(plan?.warnings) ? plan.warnings : []).forEach((item) => addNode(item?.nodeId, item?.widget));
  annotationOccupancyRects(existingObjects).forEach((rect) => occupied.push(paddedRect(rect, 6)));
  return occupied;
}

function outsideNodePort(point, node, io) {
  if (!node) return point;
  const rect = nodeRect(node);
  const outward = 18;
  const x = io === "output" ? rect[0] + rect[2] + outward : rect[0] - outward;
  return [x, point[1]];
}

const METRO_ROUTE = {
  nodePad: 18,
  portStub: 24,
  fanGap: 8,
  maxFanRank: 9,
};

const ROUTE_GROUPS = ["model", "clip", "conditioning", "latent", "vae", "image", "flow"];

function rectLeft(rect) {
  return rect ? rect[0] : 0;
}

function rectRight(rect) {
  return rect ? rect[0] + rect[2] : 0;
}

function routeGroupForConnection(connection) {
  if (connection?.routeGroup) return String(connection.routeGroup).toLowerCase();
  const text = [
    connection?.fromSlot,
    connection?.toSlot,
    connection?.label,
    connection?.type,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  if (/\bmodel\b|checkpoint|ckpt/.test(text)) return "model";
  if (/\bclip\b|text.?encoder|prompt/.test(text)) return "clip";
  if (/conditioning|positive|negative|cond\b/.test(text)) return "conditioning";
  if (/latent|samples?/.test(text)) return "latent";
  if (/\bvae\b/.test(text)) return "vae";
  if (/image|save|preview/.test(text)) return "image";
  return "flow";
}

function routeGroupIndex(group) {
  const index = ROUTE_GROUPS.indexOf(String(group || "flow"));
  return index >= 0 ? index : ROUTE_GROUPS.length - 1;
}

function routeEndpoint(connection, io) {
  const isOutput = io === "output";
  const nodeId = isOutput ? connection?.fromNodeId : connection?.toNodeId;
  const slot = isOutput ? connection?.fromSlot : connection?.toSlot;
  const node = getNodeById(nodeId);
  const point = slotPosition({ nodeId, slot, io })
    || (Array.isArray(isOutput ? connection?.from : connection?.to)
      ? clonePoint(isOutput ? connection.from : connection.to)
      : null);
  if (!point) return null;
  return {
    node,
    nodeId: nodeId != null ? String(nodeId) : "",
    slot: slot != null ? String(slot) : "",
    point,
    rect: node ? nodeRect(node) : null,
    slotRank: slotIndex(node, io === "input" ? "input" : "output", slot),
  };
}

function routeExcludedNodeIds(item) {
  return new Set([item.fromNodeId, item.toNodeId].filter(Boolean).map(String));
}

function segmentIntersectsRect(a, b, rect, pad = 0) {
  if (!rect) return false;
  const left = rect[0] - pad;
  const top = rect[1] - pad;
  const right = rect[0] + rect[2] + pad;
  const bottom = rect[1] + rect[3] + pad;
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  if (maxX < left || minX > right || maxY < top || minY > bottom) return false;
  if (Math.abs(a[1] - b[1]) < 0.01) return a[1] >= top && a[1] <= bottom;
  if (Math.abs(a[0] - b[0]) < 0.01) return a[0] >= left && a[0] <= right;
  return true;
}

function routeSegmentCrossesNodes(a, b, excludedIds = new Set(), pad = 4) {
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  return nodes.some((node) => {
    if (!node || excludedIds.has(String(node.id))) return false;
    return segmentIntersectsRect(a, b, nodeRect(node), pad);
  });
}

function routeCrossesNodes(points, excludedIds = new Set(), pad = 4) {
  for (let index = 1; index < points.length; index += 1) {
    if (routeSegmentCrossesNodes(points[index - 1], points[index], excludedIds, pad)) return true;
  }
  return false;
}

function simplifyRoutePoints(points) {
  const filtered = [];
  for (const point of points) {
    if (!Array.isArray(point)) continue;
    const next = clonePoint(point);
    const prev = filtered[filtered.length - 1];
    if (prev && Math.abs(prev[0] - next[0]) < 0.01 && Math.abs(prev[1] - next[1]) < 0.01) continue;
    filtered.push(next);
  }
  const simplified = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const prev = simplified[simplified.length - 1];
    const point = filtered[index];
    const next = filtered[index + 1];
    if (prev && next) {
      const sameX = Math.abs(prev[0] - point[0]) < 0.01 && Math.abs(point[0] - next[0]) < 0.01;
      const sameY = Math.abs(prev[1] - point[1]) < 0.01 && Math.abs(point[1] - next[1]) < 0.01;
      if (sameX || sameY) continue;
    }
    simplified.push(point);
  }
  return simplified.length >= 2 ? simplified : filtered;
}

function prepareConnectionRouteItem(connection, index, lane = {}) {
  const source = routeEndpoint(connection, "output");
  const target = routeEndpoint(connection, "input");
  if (!source || !target) return null;
  const sourceRank = Number.isFinite(Number(lane.sourceRank)) ? Number(lane.sourceRank) : 0;
  const targetRank = Number.isFinite(Number(lane.targetRank)) ? Number(lane.targetRank) : 0;
  return {
    index,
    connection,
    fromNode: source.node,
    toNode: target.node,
    fromNodeId: source.nodeId,
    toNodeId: target.nodeId,
    fromSlot: source.slot,
    toSlot: target.slot,
    from: source.point,
    to: target.point,
    start: outsideNodePort(source.point, source.node, "output"),
    end: outsideNodePort(target.point, target.node, "input"),
    fromRect: source.rect,
    toRect: target.rect,
    sourceSlotRank: source.slotRank,
    targetSlotRank: target.slotRank,
    sourceRank,
    targetRank,
    sourceLane: Number(lane.sourceLane) || 0,
    targetLane: Number(lane.targetLane) || 0,
    routeLane: Number(lane.lane) || 0,
    group: routeGroupForConnection(connection),
  };
}

function assignRouteRanks(items) {
  const sourceGroups = new Map();
  const targetGroups = new Map();
  items.forEach((item) => {
    const sourceKey = item.fromNodeId || `source:${item.index}`;
    const targetKey = item.toNodeId || `target:${item.index}`;
    if (!sourceGroups.has(sourceKey)) sourceGroups.set(sourceKey, []);
    if (!targetGroups.has(targetKey)) targetGroups.set(targetKey, []);
    sourceGroups.get(sourceKey).push(item);
    targetGroups.get(targetKey).push(item);
  });
  const assign = (groups, rankKey, laneKey, sorter) => {
    for (const groupItems of groups.values()) {
      groupItems.sort(sorter);
      const center = (groupItems.length - 1) * 0.5;
      groupItems.forEach((item, ordinal) => {
        item[rankKey] = ordinal;
        item[laneKey] = ordinal - center;
      });
    }
  };
  assign(sourceGroups, "sourceRank", "sourceLane", (a, b) => (
    a.sourceSlotRank - b.sourceSlotRank || a.to[1] - b.to[1] || a.index - b.index
  ));
  assign(targetGroups, "targetRank", "targetLane", (a, b) => (
    a.targetSlotRank - b.targetSlotRank || a.from[1] - b.from[1] || a.index - b.index
  ));
  items.forEach((item) => {
    const groupOffset = (routeGroupIndex(item.group) - 3) * 0.18;
    item.routeLane = clamp((item.sourceLane + item.targetLane) * 0.5 + groupOffset, -5, 5);
  });
}

function routeFanRank(rank) {
  return Math.max(0, Math.min(METRO_ROUTE.maxFanRank, Math.floor(Number(rank) || 0)));
}

function sourceRailX(item) {
  const base = item.fromRect ? rectRight(item.fromRect) : item.start[0];
  return base + METRO_ROUTE.portStub + Math.min(2, routeFanRank(item.sourceRank)) * METRO_ROUTE.fanGap;
}

function targetRailX(item) {
  const base = item.toRect ? rectLeft(item.toRect) : item.end[0];
  return base - METRO_ROUTE.portStub - Math.min(2, routeFanRank(item.targetRank)) * METRO_ROUTE.fanGap;
}

function compactMetroRoutePoints(item) {
  if (!item.fromRect || !item.toRect) return null;
  const gapLeft = rectRight(item.fromRect) + METRO_ROUTE.nodePad;
  const gapRight = rectLeft(item.toRect) - METRO_ROUTE.nodePad;
  if (item.start[0] >= item.end[0] || gapRight - gapLeft < 44) return null;
  const preferred = (gapLeft + gapRight) * 0.5 + item.routeLane * METRO_ROUTE.fanGap;
  const midX = clamp(preferred, gapLeft, gapRight);
  const points = simplifyRoutePoints([
    item.from,
    item.start,
    [midX, item.start[1]],
    [midX, item.end[1]],
    item.end,
    item.to,
  ]);
  return routeCrossesNodes(points, routeExcludedNodeIds(item), 3) ? null : points;
}

function simpleDoglegRoutePoints(item) {
  const sourceX = sourceRailX(item);
  const targetX = targetRailX(item);
  const hasForwardGap = sourceX + 24 < targetX;
  const midX = hasForwardGap
    ? clamp((sourceX + targetX) * 0.5 + item.routeLane * METRO_ROUTE.fanGap, sourceX, targetX)
    : (item.start[0] <= item.end[0]
      ? Math.max(sourceX, targetX) + METRO_ROUTE.portStub
      : Math.min(sourceX, targetX) - METRO_ROUTE.portStub);
  return simplifyRoutePoints([
    item.from,
    item.start,
    [midX, item.start[1]],
    [midX, item.end[1]],
    item.end,
    item.to,
  ]);
}

function routeMetroConnectionItem(item) {
  const points = compactMetroRoutePoints(item) || simpleDoglegRoutePoints(item);
  return {
    from: clonePoint(item.from),
    to: clonePoint(item.to),
    points,
    group: item.group,
    routeLane: item.routeLane,
    sourceRank: item.sourceRank,
    targetRank: item.targetRank,
  };
}

function buildConnectionRouteContext(connections) {
  const routes = new Map();
  const lanes = connectionLaneMap(connections);
  const items = [];
  connections.forEach((connection, index) => {
    const item = prepareConnectionRouteItem(connection, index, lanes.get(index) || {});
    if (item) items.push(item);
  });
  assignRouteRanks(items);
  items.forEach((item) => {
    routes.set(item.index, routeMetroConnectionItem(item));
  });
  return { routes, items };
}

function routeConnectionPoints(from, to, fromNode, toNode, options = {}) {
  if (options.route?.points) return options.route.points.map(clonePoint);
  const item = {
    index: Number(options.index) || 0,
    connection: options,
    fromNode,
    toNode,
    fromNodeId: fromNode?.id != null ? String(fromNode.id) : "",
    toNodeId: toNode?.id != null ? String(toNode.id) : "",
    fromSlot: "",
    toSlot: "",
    from: clonePoint(from),
    to: clonePoint(to),
    start: outsideNodePort(from, fromNode, "output"),
    end: outsideNodePort(to, toNode, "input"),
    fromRect: fromNode ? nodeRect(fromNode) : null,
    toRect: toNode ? nodeRect(toNode) : null,
    sourceRank: Number(options.sourceRank) || 0,
    targetRank: Number(options.targetRank) || 0,
    sourceLane: Number(options.sourceLane) || 0,
    targetLane: Number(options.targetLane) || 0,
    routeLane: Number(options.lane ?? options.targetLane ?? options.sourceLane) || 0,
    group: routeGroupForConnection(options),
  };
  return routeMetroConnectionItem(item).points;
}

function planStepObjects(step, index, color, occupied = [], mode = "freeform", stepCount = 0, style = aiStyleFromState(), labelOptions = {}) {
  const node = getNodeById(step?.nodeId);
  if (!node) return [];
  const rect = nodeRect(node);
  const displayIndex = stepDisplayIndex(step, index);
  const text = stepCalloutText(step, index);
  const compact = stepCount > COMPACT_STEP_LABEL_THRESHOLD;
  const labelText = compact ? compactLabelText(text) : text;
  const labelPlacement = reserveNodeCalloutPosition(node, labelText, occupied, {
    ...labelOptions,
    compact,
    role: "step",
    nodeBox: rect,
    targetRect: rect,
    anchor: "node",
  });
  const stepMeta = {
    role: "step",
    nodeId: step.nodeId,
    stepIndex: displayIndex,
  };
  const objects = [
    normalizeObject({
      type: "highlight",
      source: "ai",
      ...stepMeta,
      rect,
      color,
      width: aiStyledWidth(4, style),
      label: "",
      opacity: aiStyledOpacity(compact ? 0.42 : RENDER.HIGHLIGHT_OPACITY, style),
    }),
    normalizeObject({
      type: "badge",
      source: "ai",
      ...stepMeta,
      pos: badgePositionForRect(rect),
      color,
      text: String(displayIndex),
      opacity: aiStyledOpacity(RENDER.BADGE_OPACITY, style),
      radius: aiStyledBadgeRadius(16, style),
    }),
  ];
  objects.push(normalizeObject({
    type: "label",
    source: "ai",
    ...stepMeta,
    pos: labelPlacement.pos,
    anchor: "node",
    calloutSide: labelPlacement.side,
    color,
    text: labelText,
    fullText: text,
    compact,
    opacity: aiStyledOpacity(compact ? 0.86 : RENDER.LABEL_OPACITY, style),
  }));
  return objects.filter(Boolean);
}

function planConnectionObject(connection, color, mode = "freeform", occupied = [], showLabel = true, options = {}) {
  const fromNode = getNodeById(connection?.fromNodeId);
  const toNode = getNodeById(connection?.toNodeId);
  const route = options.route || null;
  const from = route?.from ? clonePoint(route.from) : slotPosition({
    nodeId: connection?.fromNodeId,
    slot: connection?.fromSlot,
    io: "output",
  });
  const to = route?.to ? clonePoint(route.to) : slotPosition({
    nodeId: connection?.toNodeId,
    slot: connection?.toSlot,
    io: "input",
  });
  if (!from || !to) return null;
  const sourceSlotRank = slotIndex(fromNode, "output", connection?.fromSlot);
  const targetSlotRank = slotIndex(toNode, "input", connection?.toSlot);
  const points = route?.points ? route.points.map(clonePoint) : routeConnectionPoints(from, to, fromNode, toNode, {
    lane: options.lane,
    sourceLane: options.sourceLane,
    sourceRank: Math.max(Number(options.sourceRank) || 0, sourceSlotRank),
    targetLane: options.targetLane,
    targetRank: Math.max(Number(options.targetRank) || 0, targetSlotRank),
    routeGroup: routeGroupForConnection(connection),
  });
  const deepConnection = mode === "deep_explain" || mode === "draw_all_nodes";
  const quietConnection = mode === "tutorial_flow" || mode === "draw_steps" || deepConnection;
  const label = quietConnection || !showLabel ? "" : connection?.label || "";
  const style = options.style || aiStyleFromState();
  return normalizeObject({
    type: "arrow",
    source: "ai",
    from,
    to,
    points,
    fromNodeId: connection?.fromNodeId,
    fromSlot: connection?.fromSlot,
    toNodeId: connection?.toNodeId,
    toSlot: connection?.toSlot,
    routeGroup: route?.group || routeGroupForConnection(connection),
    routeIndex: options.index,
    color,
    width: aiStyledWidth(deepConnection ? 2.5 : quietConnection ? 2.25 : 3.5, style),
    label,
    labelPos: label ? reserveConnectionLabelPosition(points, label, occupied, options) : null,
    opacity: aiStyledOpacity(deepConnection ? 0.42 : mode === "tutorial_flow" ? 0.36 : 0.7, style),
  });
}

function planFocusObjects(item, color, occupied = [], style = aiStyleFromState(), labelOptions = {}) {
  const node = getNodeById(item?.nodeId);
  if (!node) return [];
  const customTextWidget = item?.widget && widgetIsCustomText(node, item.widget);
  const nodeBox = nodeRect(node);
  const widgetBox = item?.widget ? widgetRect(node, item.widget) : null;
  const rect = customTextWidget ? nodeBox : widgetBox || nodeBox;
  const text = item?.label || item?.widget || node.title || node.type || "";
  const labelText = compactLabelText(text);
  const anchor = widgetBox ? "widget" : "node";
  const labelPlacement = reserveNodeCalloutPosition(node, labelText, occupied, {
    ...labelOptions,
    compact: true,
    role: item?.role || "focus",
    nodeBox,
    targetRect: widgetBox || nodeBox,
    anchor,
  });
  return [
    normalizeObject({
      type: "highlight",
      source: "ai",
      role: item?.role || "focus",
      nodeId: item?.nodeId,
      rect,
      color,
      width: aiStyledWidth(4, style),
      label: "",
      opacity: aiStyledOpacity(0.78, style),
    }),
    normalizeObject({
      type: "label",
      source: "ai",
      role: item?.role || "focus",
      nodeId: item?.nodeId,
      widget: item?.widget,
      anchor,
      calloutSide: labelPlacement.side,
      pos: labelPlacement.pos,
      color,
      text: labelText,
      fullText: text,
      compact: true,
      opacity: aiStyledOpacity(0.94, style),
    }),
  ].filter(Boolean);
}

function planWarningObjects(item, color, occupied = [], style = aiStyleFromState(), labelOptions = {}) {
  const node = getNodeById(item?.nodeId);
  if (!node) return [];
  const nodeBox = nodeRect(node);
  const widgetBox = item?.widget ? widgetRect(node, item.widget) : null;
  const rect = widgetBox || nodeBox;
  const text = warningLabelText(item);
  const labelText = compactLabelText(text);
  const anchor = widgetBox ? "widget" : "node";
  const labelPlacement = reserveNodeCalloutPosition(node, labelText, occupied, {
    ...labelOptions,
    compact: true,
    role: item?.role || "warning",
    nodeBox,
    targetRect: widgetBox || nodeBox,
    anchor,
  });
  return [
    normalizeObject({
      type: "highlight",
      source: "ai",
      role: item?.role || "warning",
      nodeId: item?.nodeId,
      rect,
      color,
      width: aiStyledWidth(5, style),
      label: "",
      opacity: aiStyledOpacity(0.86, style),
    }),
    normalizeObject({
      type: "label",
      source: "ai",
      role: item?.role || "warning",
      nodeId: item?.nodeId,
      widget: item?.widget,
      anchor,
      calloutSide: labelPlacement.side,
      pos: labelPlacement.pos,
      color,
      text: labelText,
      fullText: text,
      compact: true,
      opacity: aiStyledOpacity(0.94, style),
    }),
  ].filter(Boolean);
}

function connectionLaneMap(connections) {
  const lanes = new Map();
  const sourceGroups = new Map();
  const targetGroups = new Map();
  connections.forEach((connection, index) => {
    const sourceKey = String(connection?.fromNodeId ?? "source");
    const targetKey = String(connection?.toNodeId ?? "target");
    if (!sourceGroups.has(sourceKey)) sourceGroups.set(sourceKey, []);
    if (!targetGroups.has(targetKey)) targetGroups.set(targetKey, []);
    sourceGroups.get(sourceKey).push(index);
    targetGroups.get(targetKey).push(index);
  });
  const assignGroup = (groups, laneKey, rankKey) => {
    for (const indexes of groups.values()) {
      const center = (indexes.length - 1) * 0.5;
      indexes.forEach((connectionIndex, ordinal) => {
        const lane = lanes.get(connectionIndex) || {};
        lane[laneKey] = ordinal - center;
        lane[rankKey] = ordinal;
        lanes.set(connectionIndex, lane);
      });
    }
  };
  assignGroup(sourceGroups, "sourceLane", "sourceRank");
  assignGroup(targetGroups, "targetLane", "targetRank");
  for (const [index, lane] of lanes) {
    lane.lane = lane.targetLane ?? lane.sourceLane ?? 0;
    lanes.set(index, lane);
  }
  return lanes;
}

function planItemNodeKey(item) {
  return item?.nodeId == null ? "" : String(item.nodeId);
}

function renderPlan(plan, color, mode = "freeform", options = {}) {
  const background = [];
  const connectors = [];
  const foreground = [];
  const safePlan = plan && typeof plan === "object" ? plan : {};
  const steps = Array.isArray(safePlan.steps) ? safePlan.steps : [];
  const connections = Array.isArray(safePlan.connections) ? safePlan.connections : [];
  const warnings = Array.isArray(safePlan.warnings) ? safePlan.warnings : [];
  const warningNodeKeys = new Set(warnings.map(planItemNodeKey).filter(Boolean));
  const focusItems = (Array.isArray(safePlan.focus) ? safePlan.focus : []).filter((item) => (
    !warningNodeKeys.has(planItemNodeKey(item))
  ));
  const totalSteps = Math.max(steps.length, Number(options.totalSteps) || 0);
  const style = options.style || aiStyleFromState();
  const hasSteps = steps.length > 0;
  const hasFocus = focusItems.length > 0;
  const hasWarnings = warnings.length > 0;
  const shouldDrawConnections = (
    mode === "connections"
    || mode === "draw_connections"
    || mode === "deep_explain"
    || mode === "draw_all_nodes"
    || mode === "draw_steps"
    || mode === "tutorial_flow"
    || (!hasSteps && !hasFocus && !hasWarnings)
  );
  const stepColorByNode = new Map();
  steps.forEach((step, index) => {
    if (step?.nodeId == null) return;
    const ordinal = stepColorOrdinal(step, index);
    stepColorByNode.set(String(step.nodeId), planPaletteColor(ordinal, Math.floor(ordinal / PLAN_COLORS.length)));
  });
  const colorForNode = (nodeId, fallback) => (
    stepColorByNode.get(String(nodeId)) || planPaletteColor(String(nodeId ?? fallback), 0)
  );
  const colorForConnection = (connection, index) => (
    stepColorByNode.get(String(connection?.fromNodeId))
    || stepColorByNode.get(String(connection?.toNodeId))
    || planPaletteColor(`${connection?.fromNodeId ?? ""}->${connection?.toNodeId ?? ""}`, index)
  );
  const occupied = reservePlanNodeRects(safePlan, options.avoidObjects || []);
  const labelOptions = { cables: graphCableSegments(), graphBox: computeGraphBoundingBox(), calloutStacks: new Map() };
  const routeContext = shouldDrawConnections ? buildConnectionRouteContext(connections) : { routes: new Map() };
  const showConnectionLabels = !hasSteps && connections.length <= 2 && mode === "freeform";
  let toneSeq = 0;
  const addObject = (object) => {
    if (!object) return;
    if (object.type === "label" || object.type === "badge") foreground.push(object);
    else if (object.type === "arrow") connectors.push(object);
    else background.push(object);
  };
  if (shouldDrawConnections) {
    connections.forEach((connection, index) => {
      const tone = colorForConnection(connection, index);
      const route = routeContext.routes.get(index) || null;
      toneSeq += 1;
      addObject(planConnectionObject(connection, tone, mode, occupied, showConnectionLabels, { route, index, style }));
    });
  }
  steps.forEach((step, index) => {
    const tone = colorForNode(step?.nodeId, index);
    toneSeq += 1;
    planStepObjects(step, index, tone, occupied, mode, totalSteps, style, labelOptions).forEach(addObject);
  });
  focusItems.forEach((item) => {
    const tone = colorForNode(item?.nodeId, toneSeq);
    toneSeq += 1;
    planFocusObjects(item, tone, occupied, style, labelOptions).forEach(addObject);
  });
  warnings.forEach((item) => {
    planWarningObjects(item, "#ff6f61", occupied, style, labelOptions).forEach(addObject);
  });
  const objects = background.concat(connectors, foreground).filter(Boolean);
  debugLog("rendered plan objects", () => ({
    mode,
    plan: safePlan,
    objects: objects.map(debugObjectSnapshot),
  }));
  return objects;
}

function routeableAiConnectionObject(object) {
  return object?.source === "ai"
    && object.type === "arrow"
    && object.fromNodeId != null
    && object.toNodeId != null;
}

function connectionFromAiArrowObject(object) {
  return {
    fromNodeId: object.fromNodeId,
    fromSlot: object.fromSlot,
    toNodeId: object.toNodeId,
    toSlot: object.toSlot,
    routeGroup: object.routeGroup,
    label: object.label,
    from: object.from,
    to: object.to,
  };
}

function aiObjectLayerRank(object) {
  if (object.type === "highlight" || object.type === "rect" || object.type === "ellipse") return 10;
  if (object.type === "arrow") return 20;
  if (object.type === "badge" || object.type === "label") return 30;
  return 25;
}

function orderAiObjectsForDraw(objects) {
  const aiItems = [];
  objects.forEach((object, index) => {
    if (object?.source === "ai") aiItems.push({ object, index });
  });
  if (!aiItems.length) return objects;
  aiItems.sort((a, b) => aiObjectLayerRank(a.object) - aiObjectLayerRank(b.object) || a.index - b.index);
  const sortedAi = aiItems.map((item) => item.object);
  const result = [];
  let insertedAi = false;
  for (const object of objects) {
    if (object?.source === "ai") {
      if (!insertedAi) {
        result.push(...sortedAi);
        insertedAi = true;
      }
      continue;
    }
    result.push(object);
  }
  return result;
}

function routeAiConnectionObjects(objects) {
  const routeEntries = [];
  const connections = [];
  objects.forEach((object, objectIndex) => {
    if (!routeableAiConnectionObject(object)) return;
    routeEntries.push({ object, objectIndex, routeIndex: connections.length });
    connections.push(connectionFromAiArrowObject(object));
  });
  if (!routeEntries.length) return orderAiObjectsForDraw(objects);
  const routeContext = buildConnectionRouteContext(connections);
  const routeableIndexes = new Set(routeEntries.map((entry) => entry.objectIndex));
  const occupied = [];
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  nodes.forEach((node) => {
    if (node) occupied.push(paddedRect(nodeRect(node), 4));
  });
  objects.forEach((object, index) => {
    if (!object?.bbox || routeableIndexes.has(index)) return;
    occupied.push(paddedRect(object.bbox, 4));
  });
  const next = objects.slice();
  routeEntries.forEach((entry) => {
    const route = routeContext.routes.get(entry.routeIndex);
    if (!route) return;
    const object = entry.object;
    const labelPos = object.label
      ? reserveConnectionLabelPosition(route.points, object.label, occupied, { lane: route.routeLane })
      : null;
    const normalized = normalizeObject({
      ...object,
      from: route.from,
      to: route.to,
      points: route.points,
      labelPos,
      routeGroup: route.group,
      routeIndex: Number.isFinite(Number(object.routeIndex)) ? object.routeIndex : entry.routeIndex,
    });
    if (normalized) next[entry.objectIndex] = normalized;
  });
  return orderAiObjectsForDraw(next.filter(Boolean));
}

function replaceAiObjects(objects, options = {}) {
  const store = getStore();
  const manualObjects = store.objects.filter((object) => object.source !== "ai");
  if (!objects.length && manualObjects.length === store.objects.length) return false;
  if (!options.skipHistory) pushHistory();
  store.objects = routeAiConnectionObjects(manualObjects.concat(objects));
  store.settings.visible = true;
  store.updatedAt = Date.now();
  setStore(store);
  state.visible = true;
  updateToolbarState();
  debugLog("ai objects replaced", () => ({
    manualObjectCount: manualObjects.length,
    aiObjectCount: objects.length,
    objects: objects.map(debugObjectSnapshot),
    store: debugStoreSnapshot(),
  }));
  return true;
}

function overlayAiObjects(objects, options = {}) {
  const store = getStore();
  const replaceRole = options.replaceRole || "";
  const keptObjects = replaceRole
    ? store.objects.filter((object) => !(object.source === "ai" && object.role === replaceRole))
    : store.objects.slice();
  if (!objects.length) return false;
  if (!options.skipHistory) pushHistory();
  store.objects = routeAiConnectionObjects(keptObjects.concat(objects));
  store.settings.visible = true;
  store.updatedAt = Date.now();
  setStore(store);
  state.visible = true;
  updateToolbarState();
  debugLog("ai objects overlaid", () => ({
    replaceRole,
    addedObjectCount: objects.length,
    objects: objects.map(debugObjectSnapshot),
    store: debugStoreSnapshot(),
  }));
  return true;
}

function applyAskPlan(payload, mode = state.askMode, options = {}) {
  const drawPolicy = String(payload?.drawPolicy || "final");
  if (drawPolicy === "none") {
    debugLog("ask answer-only response", () => ({ mode, payload }));
    return { drawn: false, suppressedStepCount: 0, drawPolicy };
  }
  const color = ASK_COLORS[state.askColorIndex % ASK_COLORS.length];
  state.askColorIndex += 1;
  const renderMode = payload?.intent || mode;
  const style = aiStyleFromState();
  const currentObjects = getStore(false).objects || [];
  const overlayLookup = renderMode === "lookup_focus" || drawPolicy === "overlay";
  const batchIndex = drawPolicy === "append_batch" ? Math.max(1, Math.floor(Number(payload?.batchIndex) || 1)) : 0;
  const avoidObjects = drawPolicy === "append_batch"
    ? (batchIndex === 1 ? currentObjects.filter((object) => object.source !== "ai") : currentObjects)
    : (overlayLookup
      ? currentObjects.filter((object) => !(object.source === "ai" && object.role === "lookup"))
      : currentObjects.filter((object) => object.source !== "ai"));
  const objects = renderPlan(payload?.plan, color, renderMode, { totalSteps: payload?.totalNodes, style, avoidObjects });
  if (!objects.length) {
    setAskStatus(payload?.answer || "No drawing returned");
    debugLog("ask produced no drawable objects", () => ({
      mode,
      drawPolicy,
      payload,
      objects: objects.map(debugObjectSnapshot),
    }));
    return { drawn: false, suppressedStepCount: 0, drawPolicy };
  }
  debugLog("ask drawing resolved", () => ({
    mode,
    renderMode,
    drawPolicy,
    provider: payload?.provider,
    answer: payload?.answer,
    style,
    chosenObjects: objects.map(debugObjectSnapshot),
  }));
  if (drawPolicy === "append_batch") {
    if (batchIndex === 1) replaceAiObjects(objects);
    else overlayAiObjects(objects, { skipHistory: true });
    return { drawn: true, suppressedStepCount: 0, drawPolicy, batchIndex };
  }
  if (overlayLookup) overlayAiObjects(objects, { replaceRole: "lookup" });
  else replaceAiObjects(objects);
  return { drawn: true, suppressedStepCount: 0, drawPolicy, overlay: overlayLookup };
}

function askCompletionStatus(payload, result, fallback = "Drawn") {
  if (result && !result.drawn) return payload?.answer || "No drawing returned";
  return payload?.answer || fallback;
}

function compactSlot(slot, index) {
  return {
    name: String(slot?.name || slot?.type || "").slice(0, 80),
    type: String(slot?.type || "").slice(0, 80),
    index,
    link: slot?.link ?? null,
    links: Array.isArray(slot?.links) ? slot.links.slice(0, 80) : [],
  };
}

function compactWidget(node, widget, index) {
  return {
    name: String(widget?.name || widget?.label || widget?.type || "").slice(0, 80),
    type: String(widget?.type || "").slice(0, 80),
    value: String(widgetStoredValue(node, widget, index) ?? "").slice(0, 120),
  };
}

function getSelectedNodeIds() {
  return Object.keys(app.canvas?.selected_nodes || {});
}

function compactLink(link, fallbackId = "") {
  if (Array.isArray(link)) {
    return {
      id: link[0],
      origin_id: link[1],
      origin_slot: link[2],
      target_id: link[3],
      target_slot: link[4],
      type: String(link[5] || "").slice(0, 80),
    };
  }
  return {
    id: link?.id ?? fallbackId,
    origin_id: link?.origin_id,
    origin_slot: link?.origin_slot,
    target_id: link?.target_id,
    target_slot: link?.target_slot,
    type: String(link?.type || "").slice(0, 80),
  };
}

function compactGraphLinks(graph) {
  const links = graph?.links;
  if (Array.isArray(links)) return links.map((link) => compactLink(link)).slice(0, 1000);
  if (links && typeof links === "object") {
    return Object.entries(links).map(([id, link]) => compactLink(link, id)).slice(0, 1000);
  }
  return [];
}

function elementIsVisible(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const style = globalThis.getComputedStyle?.(element);
  return style?.visibility !== "hidden" && style?.display !== "none" && Number(style?.opacity || 1) > 0;
}

function compactUiAlerts() {
  const alertPattern = /missing nodes?|show missing|error|failed|exception|traceback|invalid|alert|warning|legacy comfyui-manager|backup/i;
  const selectors = [
    '[role="alert"]',
    '[aria-live]',
    '.comfyui-toast',
    '.comfyui-alert',
    '.comfy-toast',
    '.p-toast',
    '.p-message',
    '[class*="alert" i]',
    '[class*="toast" i]',
    '[class*="error" i]',
  ].join(",");
  const texts = [];
  const addText = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || !alertPattern.test(text)) return;
    if (texts.some((existing) => existing === text || existing.includes(text) || text.includes(existing))) return;
    texts.push(text.slice(0, 260));
  };
  document.querySelectorAll(selectors).forEach((element) => {
    if (state.toolbar?.contains(element) || !elementIsVisible(element)) return;
    addText(element.textContent);
  });
  document.querySelectorAll("button").forEach((button) => {
    if (state.toolbar?.contains(button) || !elementIsVisible(button)) return;
    const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
    if (!alertPattern.test(text)) return;
    const container = button.closest('[role="alert"], [aria-live], [class*="alert" i], [class*="toast" i], [class*="error" i]') || button.parentElement;
    addText(container?.textContent || text);
  });
  return texts.slice(0, 12);
}

function objectAnchorPoint(object) {
  if (Array.isArray(object?.pos)) return object.pos;
  if (Array.isArray(object?.rect)) {
    return [object.rect[0] + object.rect[2] / 2, object.rect[1] + object.rect[3] / 2];
  }
  if (Array.isArray(object?.bbox)) {
    return [object.bbox[0] + object.bbox[2] / 2, object.bbox[1] + object.bbox[3] / 2];
  }
  return null;
}

function pointToRectDistance(point, rect) {
  const dx = Math.max(rect[0] - point[0], 0, point[0] - (rect[0] + rect[2]));
  const dy = Math.max(rect[1] - point[1], 0, point[1] - (rect[1] + rect[3]));
  return Math.sqrt(dx * dx + dy * dy);
}

function inferAnnotationNodeId(object) {
  if (object?.nodeId != null) return object.nodeId;
  const point = objectAnchorPoint(object);
  if (!point) return undefined;
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    const rect = nodeRect(node);
    const distance = pointToRectDistance(point, rect);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= 180 ? best.id : undefined;
}

function inferAnnotationStepIndex(object) {
  const explicit = Number(object?.stepIndex);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const text = String(object?.text || object?.label || "").trim();
  const match = text.match(/^(\d{1,4})(?:\.|\b)/);
  return match ? Math.max(1, Math.floor(Number(match[1]))) : undefined;
}

function compactAiAnnotations() {
  return getStore(false).objects
    .filter((object) => object.source === "ai")
    .map((object) => {
      const nodeId = inferAnnotationNodeId(object);
      const stepIndex = inferAnnotationStepIndex(object);
      return {
        type: object.type,
        role: object.role || "",
        nodeId,
        stepIndex,
        text: object.text || object.label || "",
      };
    })
    .filter((object) => object.nodeId != null || object.stepIndex != null || object.text)
    .slice(0, 1200);
}

function graphSummary() {
  const graph = getGraph();
  const nodes = graph?._nodes || graph?.nodes || [];
  const selected = new Set(getSelectedNodeIds().map(String));
  return {
    selectedNodeIds: Array.from(selected),
    links: compactGraphLinks(graph),
    annotations: compactAiAnnotations(),
    uiAlerts: compactUiAlerts(),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type || "",
      title: node.title || "",
      pos: Array.from(node.pos || [0, 0]),
      size: Array.from(node.size || [180, 80]),
      selected: selected.has(String(node.id)),
      inputs: (node.inputs || []).map(compactSlot),
      outputs: (node.outputs || []).map(compactSlot),
      widgets: (node.widgets || []).map((widget, index) => compactWidget(node, widget, index)),
    })),
  };
}

function setAskStatus(message, options = {}) {
  state.askMessage = message || "";
  const status = state.toolbar?.querySelector("[data-showme-status]");
  if (status) {
    status.textContent = state.askMessage;
    status.dataset.busy = options.busy ? "true" : "false";
    status.scrollTop = 0;
  }
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { type: event, data: JSON.parse(dataLines.join("\n")) };
  } catch (err) {
    console.debug("ShowMe: SSE block parse failed", err);
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function currentProvider() {
  return state.providers.find((item) => item.id === state.provider) || null;
}

function providerPrefs() {
  try {
    const prefs = JSON.parse(globalThis.localStorage?.getItem(PROVIDER_PREF_KEY) || "null");
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch (err) {
    console.debug("ShowMe: provider prefs load failed", err);
    return {};
  }
}

function saveProviderPrefs() {
  try {
    globalThis.localStorage?.setItem(PROVIDER_PREF_KEY, JSON.stringify({
      provider: state.provider || "",
      model: state.model || "",
    }));
  } catch (err) {
    console.debug("ShowMe: provider prefs save failed", err);
  }
}

function loadPanelLayout() {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_LAYOUT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (Number.isFinite(x) && Number.isFinite(y)) state.panelPos = { x, y };
      state.collapsed = Boolean(parsed.collapsed);
      if ("askOpen" in parsed) state.askSectionOpen = Boolean(parsed.askOpen);
    }
  } catch (err) {
    console.debug("ShowMe: panel layout load failed", err);
  }
}

function savePanelLayout() {
  try {
    globalThis.localStorage?.setItem(PANEL_LAYOUT_KEY, JSON.stringify({
      x: state.panelPos?.x ?? null,
      y: state.panelPos?.y ?? null,
      collapsed: Boolean(state.collapsed),
      askOpen: Boolean(state.askSectionOpen),
    }));
  } catch (err) {
    console.debug("ShowMe: panel layout save failed", err);
  }
}

function findCanvasMenuToolbar() {
  const anchor = document.querySelector('[data-testid="toggle-minimap-button"], [data-testid="zoom-controls-button"]');
  return anchor?.closest('[role="toolbar"]') || null;
}

function onLauncherClick(event) {
  event.preventDefault();
  event.stopPropagation();
  hideLauncherTooltip();
  state.open = !state.open;
  state.presetOpen = false;
  updateToolbarState();
  markDirty(false);
}

function positionLauncherTooltip() {
  const refs = state.toolbarRefs;
  const launcher = refs?.launcher;
  const tooltip = refs?.launcherTooltip;
  if (!launcher || !tooltip || tooltip.hidden) return;
  const rect = launcher.getBoundingClientRect();
  const width = tooltip.offsetWidth || 58;
  const height = tooltip.offsetHeight || 24;
  const margin = 8;
  const centerX = clamp(rect.left + rect.width * 0.5, margin + width * 0.5, window.innerWidth - margin - width * 0.5);
  const placeAbove = rect.top >= height + 12;
  tooltip.dataset.placement = placeAbove ? "top" : "bottom";
  tooltip.style.left = `${centerX}px`;
  tooltip.style.top = `${placeAbove ? rect.top - 7 : rect.bottom + 7}px`;
}

function showLauncherTooltip() {
  const tooltip = state.toolbarRefs?.launcherTooltip;
  if (!tooltip) return;
  tooltip.hidden = false;
  positionLauncherTooltip();
}

function hideLauncherTooltip() {
  const tooltip = state.toolbarRefs?.launcherTooltip;
  if (!tooltip) return;
  tooltip.hidden = true;
}

function installLauncherTooltip(launcher) {
  if (!launcher || launcher.dataset.showmeTooltipBound === "true") return;
  launcher.removeAttribute("title");
  launcher.addEventListener("pointerenter", showLauncherTooltip);
  launcher.addEventListener("pointerleave", hideLauncherTooltip);
  launcher.addEventListener("focus", showLauncherTooltip);
  launcher.addEventListener("blur", hideLauncherTooltip);
  launcher.addEventListener("pointerdown", hideLauncherTooltip);
  launcher.dataset.showmeTooltipBound = "true";
}

function dockLauncherIntoCanvasMenu() {
  const root = state.toolbar;
  if (!root) return;
  const launcher = root.querySelector(".showme-main") || document.querySelector(".showme-button.showme-main");
  if (!launcher) return;
  const host = findCanvasMenuToolbar();
  if (host) {
    const desiredIndex = 1;
    const currentIndex = Array.from(host.children).indexOf(launcher);
    if (launcher.parentElement !== host || currentIndex !== desiredIndex) {
      const reference = host.children[desiredIndex] || null;
      host.insertBefore(launcher, reference);
      launcher.classList.add("is-docked");
    }
  } else if (launcher.classList.contains("is-docked")) {
    launcher.classList.remove("is-docked");
    root.insertBefore(launcher, root.firstChild);
  }
  positionLauncherTooltip();
}

function setupLauncherDocking() {
  const launcher = state.toolbar?.querySelector(".showme-main") || document.querySelector(".showme-button.showme-main");
  installLauncherTooltip(launcher);
  if (launcher && launcher.dataset.showmeClickBound !== "true") {
    launcher.addEventListener("click", onLauncherClick);
    launcher.dataset.showmeClickBound = "true";
  }
  dockLauncherIntoCanvasMenu();
  if (state.dockObserver) return;
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      dockLauncherIntoCanvasMenu();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  state.dockObserver = observer;
}

function applyPanelLayout() {
  const root = state.toolbar;
  if (!root) return;
  const panel = root.querySelector(".showme-panel");
  const pos = state.panelPos;
  if (panel && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const margin = 8;
    const width = panel.offsetWidth || 312;
    const height = panel.offsetHeight || 200;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    const x = clamp(pos.x, margin, maxX);
    const y = clamp(pos.y, margin, maxY);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = "auto";
    panel.style.transform = "none";
    root.dataset.dragged = "true";
  } else if (panel) {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.transform = "";
    root.dataset.dragged = "false";
  }
  root.dataset.collapsed = String(Boolean(state.collapsed));
}

function restoreProviderPrefs() {
  const prefs = providerPrefs();
  const providerId = String(prefs.provider || "");
  const modelId = String(prefs.model || "");
  if (providerId && state.providers.some((provider) => provider.id === providerId && provider.available)) {
    state.provider = providerId;
  }
  if (modelId) {
    state.model = modelId;
  }
}

function modelsForProvider(provider = currentProvider()) {
  return Array.isArray(provider?.models) ? provider.models : [];
}

function syncModelSelection() {
  const provider = currentProvider();
  const models = modelsForProvider(provider);
  if (!provider?.modelRequired && !models.length) {
    state.model = "";
    return;
  }
  if (!models.some((model) => model.id === state.model)) {
    state.model = provider?.defaultModel || models[0]?.id || "";
  }
}

function updateModelOptions() {
  const row = state.toolbar?.querySelector("[data-model-row]");
  const select = state.toolbar?.querySelector('[data-input="model"]');
  if (!row || !select) return;
  const provider = currentProvider();
  const models = modelsForProvider(provider);
  const show = Boolean(provider?.modelRequired || models.length);
  row.hidden = !show;
  if (!show) {
    state.model = "";
    return;
  }
  syncModelSelection();
  select.disabled = !models.length;
  select.innerHTML = models.length
    ? models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`).join("")
    : `<option value="">No models available</option>`;
  select.value = state.model;
}

function updateProviderOptions() {
  const usable = state.providers.filter((provider) => provider.available);
  const picks = state.toolbar?.querySelector("[data-provider-picks]");
  if (picks) {
    picks.innerHTML = usable
      .map((provider) => `<button class="showme-provider-pick" data-provider-id="${escapeHtml(provider.id)}" title="${escapeHtml(provider.label)}">${escapeHtml(shortProviderLabel(provider))}</button>`)
      .join("");
  }
  if (!usable.some((provider) => provider.id === state.provider)) {
    state.provider = usable[0]?.id || "";
  }
  updateModelOptions();
}

function currentProviderLabel() {
  const provider = currentProvider();
  return provider?.label || state.provider || "ShowMe";
}

function shortProviderLabel(provider) {
  if (provider.id === "ollama") return "Ollama";
  if (provider.id === "claude") return "Claude";
  if (provider.id === "codex") return "Codex";
  if (provider.id === "cli") return "CLI";
  return String(provider.label || provider.id || "AI").replace(/\s+Code$/i, "").slice(0, 12);
}

function setProvider(providerId) {
  state.provider = providerId || "";
  syncModelSelection();
  updateModelOptions();
  saveProviderPrefs();
}

function applyPreset(index) {
  const preset = ASK_PRESETS[index];
  const askInput = state.toolbar?.querySelector('[data-input="ask"]');
  if (!preset || !askInput) return;
  askInput.value = preset.prompt;
  state.askMode = preset.mode || "freeform";
  state.askPresetPrompt = preset.prompt;
  askInput.focus();
  state.presetOpen = false;
}

async function loadProviders() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(api.apiURL?.("/showme/providers") || "/showme/providers", {
      signal: controller.signal,
    });
    if (!response.ok) {
      debugLog("loadProviders non-ok", { status: response.status });
      state.askMessage = "Provider list unavailable";
      return;
    }
    const payload = await response.json();
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    state.providers = providers;
    restoreProviderPrefs();
    const askMs = Number(payload.askTimeoutMs);
    if (Number.isFinite(askMs) && askMs >= 30000) {
      state.askFetchTimeoutMs = Math.round(askMs);
    }
    updateProviderOptions();
  } catch (error) {
    debugLog("loadProviders failed", error);
    state.askMessage = "Provider list unavailable";
  } finally {
    clearTimeout(timeoutId);
    updateToolbarState();
  }
}

async function ensureProviderReady() {
  if (!state.provider || !currentProvider()) {
    await loadProviders();
  }
  let provider = currentProvider();
  if (!provider) {
    const available = state.providers.find((item) => item.available);
    if (available) {
      setProvider(available.id);
      provider = currentProvider();
    }
  }
  if (provider?.modelRequired && !state.model) {
    syncModelSelection();
  }
  return currentProvider();
}

function inferredAskMode(question) {
  if (state.askPresetPrompt && String(question || "") === state.askPresetPrompt) {
    return state.askMode || "freeform";
  }
  return "freeform";
}

async function askShowMe() {
  if (state.askBusy) {
    const input = state.toolbar?.querySelector('[data-input="ask"]');
    const shouldRestart = Boolean(String(input?.value || "").trim());
    state.askRunId += 1;
    const controller = state.askAbortController;
    state.askAbortController = null;
    state.askBusy = false;
    controller?.abort();
    setAskStatus(shouldRestart ? "Restarting ask..." : "Ask stopped", { busy: shouldRestart });
    updateToolbarState();
    if (shouldRestart) queueMicrotask(() => askShowMe());
    return;
  }
  const input = state.toolbar?.querySelector('[data-input="ask"]');
  const question = String(input?.value || "").trim();
  if (!question) {
    setAskStatus("Enter a question first");
    return;
  }
  state.askBusy = true;
  const runId = state.askRunId + 1;
  state.askRunId = runId;
  const isCurrentRun = () => state.askRunId === runId;
  const askMode = inferredAskMode(question);
  const localMode = ["connections", "draw_connections"].includes(askMode);
  const provider = localMode ? currentProvider() : await ensureProviderReady();
  if (!localMode && !provider) {
    state.askBusy = false;
    setAskStatus("No AI provider available");
    updateToolbarState();
    return;
  }
  const providerLabel = provider ? currentProviderLabel() : "ShowMe";
  const graph = graphSummary();
  debugLog("ask stream request", () => ({
    question,
    mode: askMode,
    provider: state.provider,
    model: state.model,
    graph: debugGraphSnapshot(),
    graphPayload: graph,
  }));
  setAskStatus(localMode ? "Drawing from workflow graph..." : `Asking ${providerLabel}...`, { busy: true });
  updateToolbarState();

  let finalPayload = null;
  let sawBatchPayload = false;

  const controller = new AbortController();
  state.askAbortController = controller;
  const askTimeoutMs = Number(state.askFetchTimeoutMs);
  const fetchTimeoutMs = Number.isFinite(askTimeoutMs) && askTimeoutMs >= 60000 ? askTimeoutMs : DEFAULT_ASK_FETCH_TIMEOUT_MS;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, fetchTimeoutMs);
  try {
    const response = await fetch(api.apiURL?.("/showme/ask/stream") || "/showme/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({
        question,
        mode: askMode,
        provider: state.provider,
        model: state.model,
        graph,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let errPayload = null;
      try { errPayload = await response.json(); } catch (err) { console.debug("ShowMe: error response not JSON", err); }
      throw new Error(errPayload?.error || `HTTP ${response.status}`);
    }
    if (!response.body || !response.body.getReader) {
      throw new Error("Streaming not supported by this browser");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (!isCurrentRun()) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let separatorIdx;
      while ((separatorIdx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        const event = parseSseBlock(block);
        if (!event) continue;
        if (!isCurrentRun()) break;
        if (event.type === "status") {
          setAskStatus(event.data?.message || "Drawing...", { busy: true });
        } else if (event.type === "batch") {
          const batchPayload = event.data || null;
          if (!batchPayload) continue;
          const result = applyAskPlan(batchPayload, askMode, { question });
          sawBatchPayload = sawBatchPayload || Boolean(result?.drawn);
          const nodeEnd = Number(batchPayload.nodeEnd);
          const totalNodes = Number(batchPayload.totalNodes);
          if (Number.isFinite(nodeEnd) && Number.isFinite(totalNodes)) {
            setAskStatus(`Explained ${Math.min(nodeEnd, totalNodes)}/${totalNodes} nodes...`, { busy: true });
          }
        } else if (event.type === "done") {
          finalPayload = event.data || null;
        } else if (event.type === "error") {
          streamError = new Error(event.data?.error || "Provider failed");
        }
      }
      if (!isCurrentRun()) break;
      if (done) break;
    }
    if (!isCurrentRun()) return;
    if (streamError) throw streamError;
    debugLog("ask stream response", () => ({ mode: askMode, finalPayload }));
    if (finalPayload) {
      const result = applyAskPlan(finalPayload, askMode, { question });
      setAskStatus(askCompletionStatus(finalPayload, result), { busy: false });
    } else if (sawBatchPayload) {
      setAskStatus("Every-node explanation stopped before final summary", { busy: false });
    } else {
      setAskStatus("Provider stream ended without a final response", { busy: false });
    }
  } catch (error) {
    if (!isCurrentRun()) return;
    if (error?.name === "AbortError") {
      setAskStatus(timedOut ? "Ask timed out" : "Ask stopped", { busy: false });
    } else {
      setAskStatus(`Ask failed: ${error.message || error}`, { busy: false });
    }
  } finally {
    clearTimeout(timeoutId);
    const ownsController = state.askAbortController === controller;
    if (ownsController) state.askAbortController = null;
    if (isCurrentRun() || ownsController) {
      state.askBusy = false;
      updateToolbarState();
    }
  }
}

function loadCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = CSS_URL;
  document.head.appendChild(link);
}

function icon(name) {
  return `<i class="mdi mdi-${name}" aria-hidden="true"></i>`;
}

function ensureLauncherTooltipElement(root) {
  const launcher = root.querySelector(".showme-main") || document.querySelector(".showme-button.showme-main");
  launcher?.removeAttribute("title");
  launcher?.setAttribute("aria-describedby", "showme-launcher-tooltip");
  if (root.querySelector("#showme-launcher-tooltip")) return;
  const tooltip = document.createElement("div");
  tooltip.id = "showme-launcher-tooltip";
  tooltip.className = "showme-launcher-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  tooltip.textContent = "ShowMe";
  root.insertBefore(tooltip, root.querySelector(".showme-panel") || null);
}

function buildToolbar() {
  const existing = document.getElementById("showme-toolbar");
  if (existing) {
    ensureLauncherTooltipElement(existing);
    return existing;
  }
  const root = document.createElement("div");
  root.id = "showme-toolbar";
  root.dataset.open = "false";
  root.dataset.active = "false";
  root.innerHTML = `
    <button class="showme-button showme-main" data-action="toggle-panel" aria-label="ShowMe" aria-describedby="showme-launcher-tooltip">${icon("pencil-outline")}</button>
    <div id="showme-launcher-tooltip" class="showme-launcher-tooltip" role="tooltip" hidden>ShowMe</div>
    <section class="showme-panel" aria-label="ShowMe annotation tools">
      <header class="showme-header" data-drag-handle>
        <div class="showme-brand">
          <span class="showme-grip" aria-hidden="true">${icon("drag-horizontal-variant")}</span>
          <span class="showme-title">ShowMe</span>
        </div>
        <div class="showme-header-actions">
          <button class="showme-icon-button showme-ask-toggle" type="button" data-action="toggle-ask-section" title="Ask AI" aria-label="Ask AI" aria-pressed="false">${icon("chat-question-outline")}</button>
          <button class="showme-icon-button" type="button" data-action="toggle-collapsed" title="Minimize" aria-label="Minimize">${icon("chevron-up")}</button>
        </div>
      </header>
      <div class="showme-body">
        <div class="showme-section">
          <span class="showme-label">Tools</span>
          <div class="showme-row showme-tools">
            <button class="showme-button" data-tool="brush" title="Brush" aria-label="Brush">${icon("pencil")}</button>
            <button class="showme-button" data-tool="eraser" title="Eraser" aria-label="Eraser">${icon("eraser")}</button>
            <button class="showme-button" data-tool="arrow" title="Arrow" aria-label="Arrow">${icon("arrow-top-right")}</button>
            <button class="showme-button" data-tool="rect" title="Rectangle" aria-label="Rectangle">${icon("rectangle-outline")}</button>
            <button class="showme-button" data-tool="ellipse" title="Circle" aria-label="Circle">${icon("circle-outline")}</button>
            <button class="showme-button" data-tool="text" title="Text" aria-label="Text">${icon("format-text")}</button>
          </div>
          <div class="showme-row showme-modes">
            <button class="showme-button" data-action="toggle-active" title="Enable drawing" aria-label="Enable drawing" aria-pressed="true">${icon("cursor-default-outline")}</button>
            <button class="showme-button" data-action="toggle-visible" title="Show or hide" aria-label="Show or hide">${icon("eye-outline")}</button>
          </div>
        </div>
        <div class="showme-section">
          <span class="showme-label">Style</span>
          <div class="showme-swatches">
            ${SWATCHES.map((color) => `<button class="showme-swatch" data-color="${color}" style="--showme-swatch:${color}" aria-label="${color}"></button>`).join("")}
            <input class="showme-color-input" type="color" data-input="color" value="${DEFAULT_COLOR}" title="Custom color" aria-label="Custom color">
          </div>
          <div class="showme-slider-row">
            <span class="showme-slider-name">Size</span>
            <input class="showme-input" type="range" min="1" max="40" step="1" value="6" data-input="size" title="Size" aria-label="Size">
            <span class="showme-chip" data-value="size">6</span>
          </div>
          <div class="showme-slider-row">
            <span class="showme-slider-name">Opacity</span>
            <input class="showme-input" type="range" min="10" max="100" step="1" value="92" data-input="opacity" title="Opacity" aria-label="Opacity">
            <span class="showme-chip" data-value="opacity">92%</span>
          </div>
        </div>
        <div class="showme-section showme-ai">
          <span class="showme-label">Ask AI</span>
          <div class="showme-provider-picks" data-provider-picks></div>
          <div class="showme-model-row" data-model-row hidden>
            <select class="showme-select showme-model" data-input="model" aria-label="AI model">
              <option value="">No models available</option>
            </select>
          </div>
          <div class="showme-preset" data-preset-menu-root>
            <button class="showme-preset-trigger" type="button" data-action="toggle-preset" aria-haspopup="listbox" aria-expanded="false">
              <span>Presets</span>${icon("chevron-down")}
            </button>
            <div class="showme-preset-menu" role="listbox" aria-label="AI presets">
              ${ASK_PRESETS.map((preset, index) => `<button class="showme-preset-option" type="button" data-preset-id="${index}" role="option">${escapeHtml(preset.label)}</button>`).join("")}
            </div>
          </div>
          <div class="showme-ask">
            <input class="showme-ask-input" type="text" data-input="ask" placeholder="Ask anything about this workflow..." aria-label="Ask AI prompt">
            <button class="showme-button showme-send" data-action="ask" title="Send" aria-label="Send to AI">${icon("arrow-up")}</button>
          </div>
          <div class="showme-status" data-showme-status></div>
        </div>
        <footer class="showme-footer">
          <div class="showme-row">
            <button class="showme-icon-button" data-action="undo" title="Undo" aria-label="Undo">${icon("undo")}</button>
            <button class="showme-icon-button" data-action="redo" title="Redo" aria-label="Redo">${icon("redo")}</button>
          </div>
          <button class="showme-icon-button is-danger" data-action="clear" title="Clear" aria-label="Clear">${icon("delete-outline")}</button>
        </footer>
      </div>
    </section>
  `;
  document.body.appendChild(root);
  ensureLauncherTooltipElement(root);
  return root;
}

function updateCanvasCursor() {
  const canvas = app.canvas?.canvas || app.canvasEl;
  if (!canvas) return;
  canvas.classList.toggle("showme-canvas-active", state.active && !["eraser", "text"].includes(state.tool));
  canvas.classList.toggle("showme-canvas-eraser", state.active && state.tool === "eraser");
  canvas.classList.toggle("showme-canvas-text", state.active && state.tool === "text");
  canvas.classList.toggle("showme-canvas-selectable", !state.active && state.visible && state.hoverSelectable);
}

function updateHistoryButtons() {
  const root = state.toolbar;
  if (!root) return;
  root.querySelector('[data-action="undo"]')?.toggleAttribute("disabled", !state.undoStack.length);
  root.querySelector('[data-action="redo"]')?.toggleAttribute("disabled", !state.redoStack.length);
}

function cacheToolbarRefs(root) {
  return {
    tools: Array.from(root.querySelectorAll("[data-tool]")),
    colors: Array.from(root.querySelectorAll("[data-color]")),
    activeButton: root.querySelector('[data-action="toggle-active"]'),
    visibleButton: root.querySelector('[data-action="toggle-visible"]'),
    sizeValue: root.querySelector('[data-value="size"]'),
    opacityValue: root.querySelector('[data-value="opacity"]'),
    askButton: root.querySelector('[data-action="ask"]'),
    presetRoot: root.querySelector("[data-preset-menu-root]"),
    presetTrigger: root.querySelector('[data-action="toggle-preset"]'),
    statusEl: root.querySelector("[data-showme-status]"),
    providerPicks: root.querySelector("[data-provider-picks]"),
    askToggle: root.querySelector('[data-action="toggle-ask-section"]'),
    launcher: root.querySelector(".showme-main") || document.querySelector(".showme-button.showme-main"),
    launcherTooltip: root.querySelector("[data-showme-launcher-tooltip], #showme-launcher-tooltip"),
  };
}

function updateToolbarState() {
  const root = state.toolbar;
  const refs = state.toolbarRefs;
  if (!root || !refs) return;
  root.dataset.open = String(state.open);
  root.dataset.active = String(state.active);
  root.dataset.askOpen = String(Boolean(state.askSectionOpen));
  for (const button of refs.tools) {
    button.classList.toggle("is-active", state.active && button.dataset.tool === state.tool);
  }
  for (const button of refs.colors) {
    button.classList.toggle("is-active", button.dataset.color.toLowerCase() === state.color.toLowerCase());
  }
  refs.activeButton?.classList.toggle("is-active", !state.active);
  refs.activeButton?.setAttribute("aria-pressed", String(!state.active));
  refs.activeButton?.setAttribute("title", state.active ? "Switch to mouse mode" : "Enable drawing");
  refs.activeButton?.setAttribute("aria-label", state.active ? "Switch to mouse mode" : "Enable drawing");
  refs.visibleButton?.classList.toggle("is-active", state.visible);
  if (refs.sizeValue) refs.sizeValue.textContent = String(state.size);
  if (refs.opacityValue) refs.opacityValue.textContent = `${Math.round(state.opacity * 100)}%`;
  const provider = currentProvider();
  refs.askButton?.toggleAttribute("disabled", Boolean(provider?.modelRequired && !state.model));
  refs.askButton?.setAttribute("title", state.askBusy ? "Stop current ask and restart" : "Send");
  refs.askButton?.setAttribute("aria-label", state.askBusy ? "Stop current ask and restart" : "Send to AI");
  if (refs.presetRoot) refs.presetRoot.dataset.open = String(state.presetOpen);
  refs.presetTrigger?.setAttribute("aria-expanded", String(state.presetOpen));
  refs.askToggle?.classList.toggle("is-active", Boolean(state.askSectionOpen));
  refs.askToggle?.setAttribute("aria-pressed", String(Boolean(state.askSectionOpen)));
  updateModelOptions();
  refs.providerPicks?.querySelectorAll("[data-provider-id]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.providerId === state.provider);
  });
  if (refs.statusEl) refs.statusEl.textContent = state.askMessage;
  for (const input of root.querySelectorAll('.showme-input[type="range"]')) {
    syncSliderProgress(input);
  }
  updateHistoryButtons();
  updateCanvasCursor();
  applyPanelLayout();
}

function syncSliderProgress(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--showme-progress", `${clamp(percent, 0, 100)}%`);
}

function setActive(active) {
  state.active = Boolean(active);
  if (!state.active) {
    closeTextEditor(false);
  } else {
    state.hoverSelectable = false;
  }
  updateToolbarState();
}

function setTool(tool) {
  if (!["brush", "eraser", "arrow", "rect", "ellipse", "text"].includes(tool)) return;
  state.tool = tool;
  setActive(true);
}

function installPanelDragEvents(root) {
  const handle = root.querySelector("[data-drag-handle]");
  const panel = root.querySelector(".showme-panel");
  if (!handle || !panel) return;
  let active = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    active = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    handle.dataset.dragging = "true";
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (err) {
      console.debug("ShowMe: drag pointer capture failed", err);
    }
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    state.panelPos = {
      x: event.clientX - active.offsetX,
      y: event.clientY - active.offsetY,
    };
    applyPanelLayout();
  });
  const finish = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    active = null;
    delete handle.dataset.dragging;
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch (err) {
      console.debug("ShowMe: drag pointer release failed", err);
    }
    savePanelLayout();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function installToolbarEvents(root) {
  root.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  root.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.action;
    if (target.dataset.tool) {
      setTool(target.dataset.tool);
    } else if (target.dataset.color) {
      state.color = target.dataset.color;
      const colorInput = root.querySelector('[data-input="color"]');
      if (colorInput) colorInput.value = state.color;
    } else if (target.dataset.presetId) {
      applyPreset(Number(target.dataset.presetId));
    } else if (target.dataset.providerId) {
      setProvider(target.dataset.providerId);
      setAskStatus(`${currentProviderLabel()} selected`);
      state.presetOpen = false;
    } else if (action === "toggle-panel") {
      state.open = !state.open;
      state.presetOpen = false;
    } else if (action === "toggle-ask-section") {
      state.askSectionOpen = !state.askSectionOpen;
      state.presetOpen = false;
      savePanelLayout();
    } else if (action === "toggle-collapsed") {
      state.collapsed = !state.collapsed;
      state.presetOpen = false;
      savePanelLayout();
    } else if (action === "toggle-preset") {
      state.presetOpen = !state.presetOpen;
    } else if (action === "toggle-active") {
      setActive(!state.active);
      state.presetOpen = false;
    } else if (action === "toggle-visible") {
      setVisible(!state.visible);
      state.presetOpen = false;
    } else if (action === "undo") {
      undo();
      state.presetOpen = false;
    } else if (action === "redo") {
      redo();
      state.presetOpen = false;
    } else if (action === "clear") {
      clearLayer();
      state.presetOpen = false;
    } else if (action === "ask") {
      state.presetOpen = false;
      askShowMe();
    }
    updateToolbarState();
    markDirty(false);
  });
  trackListener(document, "pointerdown", (event) => {
    if (!root.contains(event.target)) {
      state.presetOpen = false;
      updateToolbarState();
    }
  });
  root.addEventListener("keydown", (event) => {
    const input = event.target;
    event.stopPropagation();
    if (event.key === "Escape") {
      state.presetOpen = false;
      updateToolbarState();
      return;
    }
    if (input instanceof HTMLInputElement && input.dataset.input === "ask" && event.key === "Enter") {
      askShowMe();
      event.preventDefault();
    }
  });
  root.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLSelectElement)) return;
    if (input.dataset.input === "ask") {
      state.askMode = "freeform";
      state.askPresetPrompt = "";
    } else if (input.dataset.input === "size") {
      state.size = Number(input.value) || state.size;
      syncSliderProgress(input);
    } else if (input.dataset.input === "opacity") {
      state.opacity = Math.max(0.1, Math.min(1, Number(input.value) / 100));
      syncSliderProgress(input);
    } else if (input.dataset.input === "color") {
      state.color = input.value || state.color;
    } else if (input.dataset.input === "provider") {
      setProvider(input.value || "");
    } else if (input.dataset.input === "model") {
      state.model = input.value || "";
      saveProviderPrefs();
    }
    updateToolbarState();
  });
}

function installCanvasEvents() {
  const canvas = app.canvas?.canvas || app.canvasEl;
  if (!canvas || canvas.dataset.showmeInstalled === "true") return false;
  canvas.dataset.showmeInstalled = "true";
  trackListener(canvas, "pointerdown", onCanvasPointerDown, { capture: true });
  trackListener(canvas, "pointermove", onCanvasPointerMoveHover, { capture: false });
  trackListener(canvas, "click", onCanvasClickHover, { capture: false });
  trackListener(window, "pointermove", onCanvasPointerMoveHover, { capture: true });
  trackListener(window, "pointermove", onWindowPointerMove, { capture: true });
  trackListener(window, "pointerup", onWindowPointerEnd, { capture: true });
  trackListener(window, "pointercancel", onWindowPointerEnd, { capture: true });
  trackListener(window, "keydown", onKeyDown, { capture: true });
  state.restoreCanvasDrawForeground = chainCallback(app.canvas, "onDrawForeground", drawAnnotations);
  return true;
}

function uninstall() {
  closeTextEditor(false);
  state.restoreCanvasDrawForeground?.();
  state.restoreCanvasDrawForeground = null;
  for (const { target, event, handler, options } of state.installedListeners) {
    target.removeEventListener(event, handler, options);
  }
  state.installedListeners = [];
  if (state.dockObserver) {
    state.dockObserver.disconnect();
    state.dockObserver = null;
  }
  const dockedLauncher = document.querySelector(".showme-button.showme-main.is-docked");
  if (dockedLauncher) dockedLauncher.remove();
  if (state.overlayCanvas) {
    state.overlayCanvas.remove();
    state.overlayCanvas = null;
  }
  if (state.toolbar) {
    state.toolbar.remove();
    state.toolbar = null;
  }
  state.toolbarRefs = null;
  const canvas = app.canvas?.canvas || app.canvasEl;
  if (canvas?.dataset?.showmeInstalled) {
    delete canvas.dataset.showmeInstalled;
  }
  state.installed = false;
  state.open = false;
  state.active = false;
  state.presetOpen = false;
  state.hoverObjectId = "";
  state.pinnedObjectId = "";
  state.selectedTarget = null;
  state.activeMove = null;
  state.hoverSelectable = false;
}

function install() {
  if (state.installed) {
    return true;
  }
  if (!app.canvas?.canvas && !app.canvasEl) return false;
  loadCss();
  loadPanelLayout();
  state.toolbar = buildToolbar();
  state.toolbarRefs = cacheToolbarRefs(state.toolbar);
  installDebugApi();
  installToolbarEvents(state.toolbar);
  installPanelDragEvents(state.toolbar);
  applyPanelLayout();
  setupLauncherDocking();
  trackListener(window, "resize", applyPanelLayout);
  trackListener(window, "resize", positionLauncherTooltip);
  state.visible = getStore(false).settings.visible;
  if (!installCanvasEvents()) return false;
  state.installed = true;
  updateProviderOptions();
  loadProviders();
  updateToolbarState();
  markDirty(false);
  return true;
}

function bootWhenReady() {
  if (install()) return;
  setTimeout(bootWhenReady, 200);
}

app.registerExtension({
  name: EXTENSION_NAME,
  init() {
    bootWhenReady();
  },
  async setup() {
    bootWhenReady();
  },
  async beforeConfigureGraph(graphData) {
    if (!graphData || typeof graphData !== "object") return;
    if (graphData.extra?.[STORE_KEY] != null) {
      graphData.extra[STORE_KEY] = normalizeStore(graphData.extra[STORE_KEY]);
      return;
    }
    const draft = loadLocalDraft(graphData);
    if (draft && (draft.strokes.length || draft.objects.length)) {
      graphData.extra ||= {};
      graphData.extra[STORE_KEY] = draft;
    }
  },
  async afterConfigureGraph() {
    state.currentStroke = null;
    state.currentObject = null;
    state.shapeStart = null;
    closeTextEditor(false);
    state.isDrawing = false;
    state.selectedTarget = null;
    state.activeMove = null;
    state.hoverSelectable = false;
    state.undoStack = [];
    state.redoStack = [];
    state.askMessage = "";
    state.visible = getStore(false).settings.visible;
    updateToolbarState();
    markDirty(false);
  },
  getCanvasMenuItems() {
    return [
      {
        content: state.active ? "ShowMe: Switch to mouse mode" : "ShowMe: Enable drawing",
        callback: () => {
          state.open = true;
          setActive(!state.active);
        },
      },
      {
        content: state.visible ? "ShowMe: Hide annotations" : "ShowMe: Show annotations",
        callback: () => setVisible(!state.visible),
      },
      {
        content: "ShowMe: Clear annotations",
        callback: () => clearLayer(),
      },
    ];
  },
});
