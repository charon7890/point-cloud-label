import {
  MAX_POINTS,
  filesFromInput,
  formatSize,
  toCloudItems,
  unpackCloud,
  walkEntry,
} from "./format.js?v=25";
import { asInstanceList, leafCss, LeafBook, LabelHistory } from "./labels.js?v=28";
import { PointCloudViewer } from "./viewer.js?v=27";
import {
  HOTKEY_DEFS,
  PAN_INTERNAL,
  assignHotkey,
  bindingFromEvent,
  cloneHotkeyMap,
  formatBinding,
  loadHotkeys,
  matchHotkeyAction,
  saveHotkeys,
} from "./hotkeys.js?v=26";

const dropScreen = document.getElementById("drop-screen");
const dropZone = document.getElementById("drop-zone");
const dropStatus = document.getElementById("drop-status");
const folderInput = document.getElementById("folder-input");
const btnBrowse = document.getElementById("btn-browse");
const btnLocal = document.getElementById("btn-local");
const pathForm = document.getElementById("path-form");
const pathInput = document.getElementById("path-input");
const appEl = document.getElementById("app");
const cloudList = document.getElementById("cloud-list");
const folderTitle = document.getElementById("folder-title");
const folderMeta = document.getElementById("folder-meta");
const currentName = document.getElementById("current-name");
const currentMeta = document.getElementById("current-meta");
const loadOverlay = document.getElementById("load-overlay");
const loadText = document.getElementById("load-text");
const loadBar = document.getElementById("load-bar");
const viewport = document.getElementById("viewport");
const pointSizeInput = document.getElementById("point-size");
const colorModeSelect = document.getElementById("color-mode");
const btnReset = document.getElementById("btn-reset");
const btnReimport = document.getElementById("btn-reimport");
const pickBadge = document.getElementById("pick-badge");
const leafList = document.getElementById("leaf-list");
const leafMeta = document.getElementById("leaf-meta");
const btnAddLeaf = document.getElementById("btn-add-leaf");
const btnUndo = document.getElementById("btn-undo");
const btnRedo = document.getElementById("btn-redo");
const gapSummary = document.getElementById("gap-summary");
const gapList = document.getElementById("gap-list");
const btnFinish = document.getElementById("btn-finish");
const finishModal = document.getElementById("finish-modal");
const finishSummary = document.getElementById("finish-summary");
const finishSave = document.getElementById("finish-save");
const finishActionsSave = document.getElementById("finish-actions-save");
const finishActionsDone = document.getElementById("finish-actions-done");
const btnSave = document.getElementById("btn-save");
const btnSaveAs = document.getElementById("btn-save-as");
const btnExit = document.getElementById("btn-exit");
const btnImportNew = document.getElementById("btn-import-new");
const btnFinishCancel = document.getElementById("btn-finish-cancel");
const hint = document.getElementById("hint");
const btnHotkeys = document.getElementById("btn-hotkeys");
const hotkeyPanel = document.getElementById("hotkey-panel");
const hotkeyList = document.getElementById("hotkey-list");
const btnHotkeysClose = document.getElementById("btn-hotkeys-close");
const btnHotkeysReset = document.getElementById("btn-hotkeys-reset");

const viewer = new PointCloudViewer(viewport);
const book = new LeafBook();
const history = new LabelHistory();
let hotkeys = loadHotkeys();
let capturingHotkey = null;
let mergeLeafId = null;
const cache = new Map();
const inflight = new Map();
let clouds = [];
let activeId = null;
let loadingId = null;
let folderKey = "";
let folderRoot = "";
let prefetchToken = 0;
const LAST_FOLDER_KEY = "pc-label:last-folder";

function setStatus(message) {
  dropStatus.hidden = !message;
  dropStatus.textContent = message || "";
}

function readLastFolder() {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) || "";
  } catch {
    return "";
  }
}

function writeLastFolder(path) {
  if (!path) return;
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    /* ignore quota */
  }
}

function isAbsPath(value) {
  const text = String(value || "");
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

function commonDir(paths) {
  const dirs = paths
    .map((value) => String(value).replace(/\//g, "\\").replace(/\\+$/, "").split("\\"))
    .map((parts) => parts.slice(0, -1));
  if (!dirs.length || !dirs[0].length) return "";
  let index = 0;
  while (
    dirs[0][index] &&
    dirs.every((parts) => (parts[index] || "").toLowerCase() === dirs[0][index].toLowerCase())
  ) {
    index += 1;
  }
  return index ? dirs[0].slice(0, index).join("\\") : "";
}

function storageKeysForFolder() {
  const keys = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text && !keys.includes(text)) keys.push(text);
  };
  add(folderKey);
  add(folderRoot);
  add(String(folderRoot || folderKey).split(/[/\\]/).filter(Boolean).pop());
  return keys;
}

function remapBookToClouds() {
  const byName = new Map();
  const byRel = new Map();
  for (const item of clouds) {
    byName.set(item.fileName, item.id);
    byRel.set(String(item.relativePath || "").replace(/\\/g, "/"), item.id);
    byRel.set(String(item.id || "").replace(/\\/g, "/"), item.id);
  }
  for (const leaf of book.leaves) {
    const next = {};
    for (const [cloudId, instanceId] of Object.entries(leaf.assignments || {})) {
      const rel = String(cloudId).replace(/\\/g, "/");
      const name = rel.split("/").pop();
      const mapped = byRel.get(rel) || byName.get(name) || cloudId;
      const merged = asInstanceList(next[mapped]);
      for (const id of asInstanceList(instanceId)) {
        if (!merged.includes(id)) merged.push(id);
      }
      if (merged.length) next[mapped] = merged;
    }
    leaf.assignments = next;
  }
}

function persist() {
  if (!folderKey && !folderRoot) return;
  try {
    const json = JSON.stringify(book.toJSON());
    for (const key of storageKeysForFolder()) {
      localStorage.setItem(`pc-label:${key}`, json);
    }
  } catch {
    /* ignore quota */
  }
}

function restoreBook() {
  try {
    for (const key of storageKeysForFolder()) {
      const raw = localStorage.getItem(`pc-label:${key}`);
      if (!raw) continue;
      book.fromJSON(JSON.parse(raw));
      remapBookToClouds();
      if (book.leaves.length) return;
    }
    book.reset();
  } catch {
    book.reset();
  }
}

function inferFolderFromClouds() {
  const abs = clouds.map((item) => item.id).filter(isAbsPath);
  if (abs.length && abs.length === clouds.length) return commonDir(abs);
  return "";
}

function applyLocatedFolder(data) {
  if (!data?.root) return;
  folderRoot = data.root;
  folderKey = data.root || folderKey;
  writeLastFolder(data.root);
  const files = data.files || [];
  const byRel = new Map(
    files.map((item) => [String(item.relative || "").replace(/\\/g, "/"), item])
  );
  const byName = new Map(
    files.map((item) => [String(item.id || "").split(/[/\\]/).pop(), item])
  );
  const nextCache = new Map();
  let nextActive = activeId;
  clouds = clouds.map((item) => {
    const rel = String(item.relativePath || item.id || "").replace(/\\/g, "/");
    const hit =
      byRel.get(rel) ||
      byRel.get(String(item.id).replace(/\\/g, "/")) ||
      byName.get(item.fileName);
    const next = hit
      ? { ...item, id: hit.id, relativePath: hit.relativePath, source: "server" }
      : item;
    delete next.file;
    if (cache.has(item.id)) nextCache.set(next.id, cache.get(item.id));
    if (item.id === activeId) nextActive = next.id;
    return next;
  });
  activeId = nextActive;
  cache.clear();
  for (const [key, value] of nextCache) cache.set(key, value);
  remapBookToClouds();
  persist();
  history.reset(book);
  updateUndoButtons();
  renderList();
}

async function locateFolderOnDisk(items = clouds) {
  const relativePaths = items
    .map((item) => item.relativePath || item.id)
    .filter(Boolean);
  const sizes = items.map((item) => item.sizeBytes || 0);
  const hints = [folderRoot, readLastFolder(), pathInput.value.trim()].filter(Boolean);
  if (!relativePaths.length || !hints.length) return "";
  const response = await fetch("/api/locate_folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relativePaths, sizes, hints }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.root) return "";
  if (items === clouds) applyLocatedFolder(data);
  return data.root;
}

async function resolveOriginalFolder() {
  const known = folderRoot || inferFolderFromClouds();
  if (known) {
    folderRoot = known;
    writeLastFolder(known);
    return known;
  }
  return locateFolderOnDisk();
}

function assignedCount(cloudId) {
  return book.leaves.filter((leaf) => book.instancesOf(leaf.id, cloudId).length > 0).length;
}

function updateUndoButtons() {
  if (!btnUndo || !btnRedo) return;
  btnUndo.disabled = !history.canUndo;
  btnRedo.disabled = !history.canRedo;
}

function cloudLabel(item) {
  return `${item.dateLabel} ${item.fileName}`;
}

function firstAssignedIndex(leaf) {
  return clouds.findIndex((item) => book.instancesOf(leaf.id, item.id).length > 0);
}

function firstLabeledCloudIndex() {
  return clouds.findIndex((item) => assignedCount(item.id) > 0);
}

function missingAfterStart(leaf) {
  const start = firstAssignedIndex(leaf);
  if (start < 0) return [];
  return clouds.filter((item, index) => index > start && book.instancesOf(leaf.id, item.id).length === 0);
}

function unlabeledAfterStart() {
  const start = firstLabeledCloudIndex();
  if (start < 0) return clouds.filter((item) => assignedCount(item.id) === 0);
  return clouds.filter((item, index) => index > start && assignedCount(item.id) === 0);
}

function gapReport() {
  return {
    unlabeled: unlabeledAfterStart(),
    leafGaps: book.leaves
      .map((leaf) => ({ leaf, missing: missingAfterStart(leaf) }))
      .filter((row) => row.missing.length),
  };
}

function renderGaps() {
  if (!gapSummary || !gapList) return;
  gapList.innerHTML = "";
  if (!clouds.length) {
    gapSummary.className = "muted";
    gapSummary.textContent = "导入点云后显示缺标情况";
    return;
  }
  if (!book.leaves.length) {
    gapSummary.className = "muted";
    gapSummary.textContent = `共 ${clouds.length} 个点云，尚未创建叶片`;
    return;
  }
  const { unlabeled, leafGaps } = gapReport();
  if (!unlabeled.length && !leafGaps.length) {
    gapSummary.className = "muted ok";
    gapSummary.textContent = firstLabeledCloudIndex() < 0
      ? "尚未对应任何日期"
      : "从各叶片首次对应起，后面没有缺天";
    return;
  }
  gapSummary.className = "muted";
  const bits = [];
  if (unlabeled.length) bits.push(`${unlabeled.length} 个文件在开始对应之后仍未标`);
  if (leafGaps.length) bits.push(`${leafGaps.length} 个叶片后面有缺天`);
  gapSummary.textContent = bits.join("；");

  if (unlabeled.length) {
    const li = document.createElement("li");
    const preview = unlabeled
      .slice(0, 4)
      .map((item) => item.dateLabel)
      .join("、");
    const more = unlabeled.length > 4 ? ` 等 ${unlabeled.length} 天` : "";
    li.innerHTML = `<span class="gap-title">开始对应之后仍有 ${unlabeled.length} 个文件未标</span><span class="gap-sub">${preview}${more}</span>`;
    li.addEventListener("click", () => selectCloud(unlabeled[0].id));
    gapList.appendChild(li);
  }
  for (const row of leafGaps) {
    const li = document.createElement("li");
    const preview = row.missing
      .slice(0, 4)
      .map((item) => item.dateLabel)
      .join("、");
    const more = row.missing.length > 4 ? ` 等 ${row.missing.length} 天` : "";
    li.innerHTML = `<span class="gap-title">${row.leaf.name}后面缺 ${row.missing.length} 天</span><span class="gap-sub">${preview}${more}</span>`;
    li.addEventListener("click", () => {
      book.activeId = row.leaf.id;
      selectCloud(row.missing[0].id);
      renderLeaves();
    });
    gapList.appendChild(li);
  }
}

function highlightActiveLeaf() {
  if (activeId == null || book.activeId == null) {
    viewer.highlightInstance(null);
    return;
  }
  viewer.highlightInstance(book.instancesOf(book.activeId, activeId));
}

function syncMergeMode() {
  if (mergeLeafId != null && mergeLeafId !== book.activeId) mergeLeafId = null;
}

function setMergeMode(on, leafId = book.activeId) {
  mergeLeafId = on && leafId != null ? leafId : null;
  if (mergeLeafId != null) book.activeId = mergeLeafId;
}

function commitLabelChange() {
  history.push(book);
  persist();
  applyLabelsToViewer();
  renderLeaves();
  renderList();
  updateUndoButtons();
  highlightActiveLeaf();
}

function undoLabels() {
  if (!history.undo(book)) return;
  persist();
  applyLabelsToViewer();
  renderLeaves();
  renderList();
  updateUndoButtons();
  highlightActiveLeaf();
}

function redoLabels() {
  if (!history.redo(book)) return;
  persist();
  applyLabelsToViewer();
  renderLeaves();
  renderList();
  updateUndoButtons();
  highlightActiveLeaf();
}

function shortcutText(id) {
  return formatBinding(hotkeys[id]);
}

function updateShortcutLabels() {
  if (btnAddLeaf) btnAddLeaf.textContent = `新增叶片 (${shortcutText("addLeaf")})`;
  if (btnUndo) btnUndo.title = shortcutText("undo");
  if (btnRedo) btnRedo.title = shortcutText("redo");
  updateHint();
}

function renderHotkeyList() {
  if (!hotkeyList) return;
  hotkeyList.innerHTML = "";
  for (const def of HOTKEY_DEFS) {
    const li = document.createElement("li");
    const bind = document.createElement("button");
    bind.type = "button";
    bind.className = "btn hotkey-bind";
    bind.dataset.id = def.id;
    if (capturingHotkey === def.id) {
      bind.classList.add("listening");
      bind.textContent = "按下新键…";
    } else {
      bind.textContent = shortcutText(def.id);
    }
    li.innerHTML = `<span class="hotkey-label">${def.label}</span>`;
    li.appendChild(bind);
    bind.addEventListener("click", (event) => {
      event.stopPropagation();
      capturingHotkey = def.id;
      renderHotkeyList();
    });
    hotkeyList.appendChild(li);
  }
}

function openHotkeyPanel() {
  hotkeyPanel.hidden = false;
  capturingHotkey = null;
  renderHotkeyList();
}

function closeHotkeyPanel() {
  hotkeyPanel.hidden = true;
  capturingHotkey = null;
}

function applyCapturedHotkey(event) {
  if (!capturingHotkey) return;
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
  if (event.key === "Escape" && capturingHotkey !== "exitDrag") {
    capturingHotkey = null;
    renderHotkeyList();
    return;
  }
  hotkeys = assignHotkey(hotkeys, capturingHotkey, bindingFromEvent(event));
  saveHotkeys(hotkeys);
  capturingHotkey = null;
  renderHotkeyList();
  updateShortcutLabels();
  renderLeaves();
}

function runHotkey(action, event) {
  switch (action) {
    case "undo":
      undoLabels();
      return;
    case "redo":
      redoLabels();
      return;
    case "exitDrag":
      viewer.setViewDragMode(false);
      viewer.clearPanKeys();
      if (mergeLeafId != null) {
        setMergeMode(false);
        renderLeaves();
        updateHint();
      }
      return;
    case "panUp":
    case "panDown":
    case "panLeft":
    case "panRight":
      viewer.setPanKey(PAN_INTERNAL[action], true);
      return;
    case "unassign":
      handleDeleteKey(false);
      return;
    case "deleteLeaf":
      handleDeleteKey(true);
      return;
    case "addLeaf":
      if (!event.repeat) addNewLeaf();
      return;
    case "prevCloud":
      stepCloud(-1);
      return;
    case "nextCloud":
      stepCloud(1);
      return;
    case "prevLeaf":
      stepLeaf(-1);
      return;
    case "nextLeaf":
      stepLeaf(1);
      return;
    default:
  }
}

function updateHint() {
  const active = book.get(book.activeId);
  const pan = `${shortcutText("panUp")}上 ${shortcutText("panLeft")}左 ${shortcutText("panDown")}下 ${shortcutText("panRight")}右`;
  if (active) {
    const merging = mergeLeafId === active.id;
    hint.textContent = merging
      ? `合并到 ${active.name}：单击未对应实例接到本片，再点已合并的块可去掉 · ${shortcutText("exitDrag")} 结束`
      : `已选 ${active.name}：点 + 可合并本文件分割块 · ${pan} · ${shortcutText("undo")} 撤销 · ${shortcutText("addLeaf")} 新增`;
    pickBadge.hidden = false;
    pickBadge.textContent = merging
      ? `合并到 ${active.name}（再点 + 或 ${shortcutText("exitDrag")} 结束）`
      : `将标注为 ${active.name}（+ 合并分割块 · ${shortcutText("unassign")} 取消当前文件对应）`;
    return;
  }
  pickBadge.hidden = true;
  hint.textContent = `${pan} · ${shortcutText("undo")} 撤销 / ${shortcutText("redo")} 重做 · ${shortcutText("prevCloud")}/${shortcutText("nextCloud")}点云 · ${shortcutText("prevLeaf")}/${shortcutText("nextLeaf")}叶片 · ${shortcutText("addLeaf")} 新增`;
}

function applyLabelsToViewer() {
  if (!activeId) {
    viewer.setLabeledInstances(new Map());
    return;
  }
  viewer.setLabeledInstances(book.labeledMap(activeId));
}

function renderLeaves() {
  syncMergeMode();
  leafList.innerHTML = "";
  if (!book.leaves.length) {
    leafMeta.textContent = `单击点云中的实例，或按 ${shortcutText("addLeaf")} 新增叶片`;
  } else {
    const currentAssigned = activeId ? assignedCount(activeId) : 0;
    const extra = book.activeId != null ? `；${shortcutText("unassign")} 只取消当前文件对应` : "";
    leafMeta.textContent = `共 ${book.leaves.length} 个叶片；当前文件已对应 ${currentAssigned} 个${extra}`;
  }
  for (const leaf of book.leaves) {
    const li = document.createElement("li");
    const partsHere = activeId != null ? book.instancesOf(leaf.id, activeId) : [];
    const assignedHere = partsHere.length > 0;
    const fileCount = Object.keys(leaf.assignments).length;
    const merging = mergeLeafId === leaf.id;
    if (leaf.id === book.activeId) li.classList.add("active");
    if (merging) li.classList.add("merging");
    const hereText = assignedHere
      ? partsHere.length > 1
        ? `当前文件已对应 ${partsHere.length} 块`
        : "当前文件已对应"
      : "当前文件未对应";
    const left = document.createElement("span");
    left.className = "left";
    left.innerHTML = `
      <span class="swatch" style="background:${leafCss(leaf.id)}"></span>
      <span>
        <span class="name-row">
          <span class="inst-id">${leaf.name}</span>
        </span>
        <span class="sub">${hereText} · ${fileCount} 个点云</span>
      </span>`;
    if (leaf.id === book.activeId) {
      const mergeBtn = document.createElement("button");
      mergeBtn.type = "button";
      mergeBtn.className = `btn ghost leaf-merge${merging ? " on" : ""}`;
      mergeBtn.textContent = "+";
      mergeBtn.title = merging
        ? "结束合并。单击未对应实例接到本叶片，再点已合并的块可去掉"
        : "在本文件追加分割块，合成一整片叶片";
      mergeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        book.activeId = leaf.id;
        setMergeMode(mergeLeafId !== leaf.id, leaf.id);
        highlightActiveLeaf();
        renderLeaves();
        updateHint();
        viewport.focus({ preventScroll: true });
      });
      left.querySelector(".name-row").appendChild(mergeBtn);
    }
    li.appendChild(left);
    li.addEventListener("click", () => {
      const next = book.toggleActive(leaf.id);
      if (next !== leaf.id) setMergeMode(false);
      else if (mergeLeafId !== leaf.id) setMergeMode(false);
      highlightActiveLeaf();
      renderLeaves();
      updateHint();
    });
    if (leaf.id === book.activeId) {
      const actions = document.createElement("span");
      actions.className = "actions";
      if (assignedHere) {
        const unassignBtn = document.createElement("button");
        unassignBtn.type = "button";
        unassignBtn.className = "btn ghost";
        unassignBtn.textContent = "取消对应";
        unassignBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          book.activeId = leaf.id;
          unassignCurrentFile();
        });
        actions.appendChild(unassignBtn);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn ghost";
      del.textContent = "删除叶片";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        book.activeId = leaf.id;
        deleteEntireLeaf();
      });
      actions.appendChild(del);
      li.appendChild(actions);
    }
    leafList.appendChild(li);
  }
  updateHint();
  renderGaps();
}

function updateFolderMeta() {
  const ready = clouds.filter((item) => cache.has(item.id)).length;
  folderMeta.textContent = `共 ${clouds.length} 个点云，已按时间排序 · 已载入 ${ready}/${clouds.length}`;
}

function renderList() {
  updateFolderMeta();
  cloudList.innerHTML = "";
  for (const item of clouds) {
    const li = document.createElement("li");
    li.dataset.id = item.id;
    if (item.id === activeId) li.classList.add("active");
    const n = assignedCount(item.id);
    let state = "";
    if (cache.has(item.id)) state = " · 已就绪";
    else if (inflight.has(item.id)) state = " · 加载中";
    const mark = n ? ` · 已对应 ${n} 片` : "";
    li.innerHTML = `<span class="name">${item.dateLabel}</span><span class="sub">${item.fileName} · ${formatSize(item.sizeBytes)}${state}${mark}</span>`;
    li.addEventListener("click", () => selectCloud(item.id));
    cloudList.appendChild(li);
  }
}

function handleInstanceClick(instanceId) {
  if (!activeId) return;
  if (instanceId == null) return;
  const existing = book.leafForInstance(activeId, instanceId);
  const merging = mergeLeafId != null && book.activeId === mergeLeafId;
  if (existing) {
    if (merging && existing.id === mergeLeafId) {
      if (!book.removeInstance(activeId, instanceId, mergeLeafId)) return;
      commitLabelChange();
      return;
    }
    book.activeId = existing.id;
    if (mergeLeafId !== existing.id) setMergeMode(false);
    highlightActiveLeaf();
    renderLeaves();
    return;
  }
  if (merging) {
    if (!book.assign(activeId, instanceId, { append: true })) return;
    commitLabelChange();
    return;
  }
  const wasExplicit = book.activeId != null;
  const leaf = book.assign(activeId, instanceId);
  if (!leaf) return;
  if (!wasExplicit) book.activeId = null;
  commitLabelChange();
}

function refreshAfterLabelChange() {
  commitLabelChange();
}

function unassignCurrentFile() {
  if (book.activeId == null || !activeId) return false;
  if (!book.unassign(activeId, book.activeId)) return false;
  setMergeMode(false);
  refreshAfterLabelChange();
  return true;
}

function deleteEntireLeaf() {
  if (book.activeId == null) return;
  book.remove(book.activeId);
  setMergeMode(false);
  refreshAfterLabelChange();
}

function handleDeleteKey(shift) {
  if (shift) {
    deleteEntireLeaf();
    return;
  }
  unassignCurrentFile();
}

function stepCloud(delta) {
  if (!clouds.length) return;
  const index = clouds.findIndex((item) => item.id === activeId);
  const current = index < 0 ? 0 : index;
  const next = Math.max(0, Math.min(clouds.length - 1, current + delta));
  if (clouds[next].id === activeId) return;
  selectCloud(clouds[next].id);
  requestAnimationFrame(() => {
    cloudList.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  });
}

function stepLeaf(delta) {
  if (!book.leaves.length) return;
  const index = book.leaves.findIndex((leaf) => leaf.id === book.activeId);
  let next = index;
  if (index < 0) next = delta > 0 ? 0 : book.leaves.length - 1;
  else next = (index + delta + book.leaves.length) % book.leaves.length;
  const leaf = book.leaves[next];
  book.activeId = leaf.id;
  highlightActiveLeaf();
  renderLeaves();
  requestAnimationFrame(() => {
    leafList.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  });
}

viewer.onInstanceClick = handleInstanceClick;

function showApp(title, items, rootPath = "") {
  clouds = items;
  folderKey = rootPath || title || "session";
  folderRoot = rootPath || inferFolderFromClouds() || "";
  if (folderRoot) writeLastFolder(folderRoot);
  restoreBook();
  history.reset(book);
  updateUndoButtons();
  document.body.classList.add("app-open");
  updateShortcutLabels();
  dropScreen.hidden = true;
  appEl.hidden = false;
  finishModal.hidden = true;
  folderTitle.textContent = title || "点云列表";
  updateFolderMeta();
  renderList();
  renderLeaves();
  viewer.resize();
  if (items.length) {
    selectCloud(items[0].id);
    prefetchAll();
  }
}

function setLoading(visible, text, progress) {
  loadOverlay.hidden = !visible;
  loadOverlay.style.pointerEvents = visible ? "auto" : "none";
  if (text) loadText.textContent = text;
  loadBar.style.width = `${Math.round((progress || 0) * 100)}%`;
}

function parseInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    const current = new Worker("/static/parser.worker.js?v=25");
    const handle = (event) => {
      if (event.data.type === "progress") {
        onProgress?.(event.data.progress);
        return;
      }
      current.terminate();
      if (event.data.type === "done") resolve(event.data.buffer);
      else reject(new Error(event.data.message || "解析失败"));
    };
    current.addEventListener("message", handle);
    current.addEventListener("error", (error) => {
      current.terminate();
      reject(error);
    });
    current.postMessage({ file, maxPoints: MAX_POINTS });
  });
}

async function loadFromServer(item, onProgress) {
  onProgress?.(0.08);
  const params = new URLSearchParams({
    path: item.id,
  });
  const response = await fetch(`/api/cloud?${params.toString()}`);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || "服务器加载失败");
  }
  onProgress?.(0.7);
  const buffer = await response.arrayBuffer();
  onProgress?.(1);
  return buffer;
}

function ensureCloud(item, onProgress) {
  if (cache.has(item.id)) return Promise.resolve(cache.get(item.id));
  if (inflight.has(item.id)) return inflight.get(item.id);
  const promise = (item.file ? parseInWorker(item.file, onProgress) : loadFromServer(item, onProgress))
    .then((buffer) => {
      const cloud = unpackCloud(buffer);
      cache.set(item.id, cloud);
      return cloud;
    })
    .finally(() => {
      inflight.delete(item.id);
      renderList();
    });
  inflight.set(item.id, promise);
  renderList();
  return promise;
}

async function prefetchAll() {
  const token = ++prefetchToken;
  for (const item of clouds) {
    if (token !== prefetchToken) return;
    try {
      await ensureCloud(item);
    } catch (error) {
      console.warn("预加载失败", item.fileName, error);
    }
  }
}

function afterCloudShown(item, cloud) {
  currentMeta.textContent = `${item.relativePath} · 显示 ${cloud.count.toLocaleString()} 点`;
  applyLabelsToViewer();
  highlightActiveLeaf();
  renderLeaves();
  renderList();
}

async function selectCloud(id) {
  const item = clouds.find((cloud) => cloud.id === id);
  if (!item) return;
  activeId = id;
  renderList();
  currentName.textContent = `${item.dateLabel}  ${item.fileName}`;
  currentMeta.textContent = item.relativePath;
  if (cache.has(id)) {
    const cached = cache.get(id);
    viewer.show(cached, { labeled: book.labeledMap(id) });
    afterCloudShown(item, cached);
    return;
  }

  loadingId = id;
  const already = inflight.has(id);
  setLoading(true, already ? "正在载入点云…" : "正在加载点云…", already ? 0.35 : 0.05);
  try {
    const cloud = await ensureCloud(item, (progress) => {
      if (activeId !== id) return;
      setLoading(true, "正在读取点云…", progress);
    });
    if (activeId !== id) return;
    viewer.show(cloud, { labeled: book.labeledMap(id) });
    afterCloudShown(item, cloud);
  } catch (error) {
    if (activeId === id) currentMeta.textContent = error.message || String(error);
  } finally {
    if (loadingId === id) {
      loadingId = null;
      setLoading(false, "", 0);
    }
  }
}

async function importBrowserFiles(entries) {
  const items = toCloudItems(entries);
  if (!items.length) {
    setStatus("未在该文件夹中找到点云文件（.txt / .xyz / .ply / .pcd）");
    return;
  }
  setStatus("正在确认文件夹位置…");
  const located = await locateFolderOnDisk(items);
  if (located) {
    await importLocalPath(located);
    if (clouds.length > items.length) {
      const opened = new Set(items.map((item) => item.fileName));
      const keep = clouds.filter((item) => opened.has(item.fileName));
      if (keep.length) {
        const root = commonDir(keep.map((item) => item.id)) || located;
        const title = String(root).split(/[/\\]/).filter(Boolean).pop() || "点云列表";
        showApp(title, keep, root);
      }
    }
    return;
  }
  setStatus("");
  const rootName = (items[0].relativePath.split(/[/\\]/)[0] || "点云列表").trim();
  showApp(rootName, items, "");
}

async function importLocalPath(path) {
  setStatus("");
  const response = await fetch(`/api/scan?path=${encodeURIComponent(path)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "无法读取该文件夹");
  }
  const items = data.clouds.map((item) => ({ ...item, source: "server" }));
  const title = data.root.split(/[/\\]/).filter(Boolean).pop() || "点云列表";
  writeLastFolder(data.root);
  showApp(title, items, data.root);
}

function resetToImport() {
  prefetchToken += 1;
  cache.clear();
  inflight.clear();
  clouds = [];
  activeId = null;
  loadingId = null;
  folderKey = "";
  folderRoot = "";
  book.reset();
  history.reset(book);
  updateUndoButtons();
  viewer.clear();
  finishModal.hidden = true;
  appEl.hidden = true;
  dropScreen.hidden = false;
  document.body.classList.remove("app-open");
  closeHotkeyPanel();
  setMergeMode(false);
  setStatus("");
  setLoading(false, "", 0);
  renderLeaves();
}

function labelPayload() {
  return {
    name: folderKey,
    folder: folderRoot || null,
    clouds: clouds.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      relativePath: item.relativePath,
      dateLabel: item.dateLabel,
    })),
    labels: book.toJSON(),
  };
}

function addNewLeaf() {
  if (appEl.hidden || !finishModal.hidden) return;
  book.createLeaf();
  setMergeMode(false);
  commitLabelChange();
  viewer.controls.enabled = true;
  viewport.focus({ preventScroll: true });
}

btnAddLeaf.addEventListener("click", () => {
  addNewLeaf();
});

btnUndo.addEventListener("click", () => undoLabels());
btnRedo.addEventListener("click", () => redoLabels());

window.addEventListener("keydown", (event) => {
  if (capturingHotkey) {
    event.preventDefault();
    applyCapturedHotkey(event);
    return;
  }
  const el = document.activeElement;
  const tag = el?.tagName;
  if (tag === "TEXTAREA") return;
  if (tag === "SELECT") return;
  if (tag === "INPUT" && (el.type === "text" || el.type === "search" || el.type === "number")) return;
  if (!hotkeyPanel.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHotkeyPanel();
    }
    return;
  }
  if (!finishModal.hidden || appEl.hidden) return;
  const action = matchHotkeyAction(hotkeys, event);
  if (!action) return;
  event.preventDefault();
  runHotkey(action, event);
});

window.addEventListener("keyup", (event) => {
  for (const id of ["panUp", "panDown", "panLeft", "panRight"]) {
    if (hotkeys[id]?.code === event.code) viewer.setPanKey(PAN_INTERNAL[id], false);
  }
});

window.addEventListener("blur", () => {
  viewer.clearPanKeys();
});

btnHotkeys.addEventListener("click", () => {
  if (hotkeyPanel.hidden) openHotkeyPanel();
  else closeHotkeyPanel();
});
btnHotkeysClose.addEventListener("click", () => closeHotkeyPanel());
btnHotkeysReset.addEventListener("click", () => {
  hotkeys = cloneHotkeyMap();
  saveHotkeys(hotkeys);
  capturingHotkey = null;
  renderHotkeyList();
  updateShortcutLabels();
  renderLeaves();
});

function showFinishDone() {
  finishActionsSave.hidden = true;
  finishActionsDone.hidden = false;
}

function showFinishSaveActions() {
  finishActionsSave.hidden = false;
  finishActionsDone.hidden = true;
}

function applySaveResult(data, payload) {
  const exported = data.exported || [];
  const errors = data.errors || [];
  const dir = data.exportDir || payload.exportDir || folderRoot || "";
  const bits = [];
  if (dir) bits.push(`已写入：${dir}`);
  if (data.backupDir) bits.push(`原文件备份：${data.backupDir}`);
  if (exported.length) bits.push(`共 ${exported.length} 个 txt（末尾 leaf_id）`);
  const jsons = data.saved || [];
  if (jsons.length) bits.push(`json：${jsons[0]}`);
  if (errors.length) bits.push(errors.join("；"));
  finishSave.textContent = bits.join("。") || "已保存。";
  showFinishDone();
}

let saving = false;

async function postSaveLabels(extra) {
  const payload = { ...labelPayload(), ...extra };
  const response = await fetch("/api/save_labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "保存失败");
  applySaveResult(data, payload);
}

btnFinish.addEventListener("click", async () => {
  const cloudCount = clouds.length;
  const leafCount = book.leaves.length;
  const mappedFiles = clouds.filter((item) => assignedCount(item.id) > 0).length;
  const { unlabeled, leafGaps } = gapReport();
  const unlabeledCount = unlabeled.length;
  const missingLeaves = leafGaps.length;
  let gapText = "";
  if (!book.leaves.length) gapText = "尚未创建叶片。";
  else if (!unlabeledCount && !missingLeaves) gapText = "缺标检查：从首次对应起后面没有缺天。";
  else {
    const parts = [];
    if (unlabeledCount) parts.push(`${unlabeledCount} 个文件在开始对应之后仍未标`);
    if (missingLeaves) parts.push(`${missingLeaves} 个叶片后面有缺天`);
    gapText = `缺标：${parts.join("，")}。`;
  }
  finishSummary.textContent = `共 ${cloudCount} 个点云，${leafCount} 个叶片标签；其中 ${mappedFiles} 个点云已有对应。${gapText}`;
  finishSave.textContent = "正在确认打开文件所在的文件夹…";
  showFinishSaveActions();
  finishModal.hidden = false;
  const root = await resolveOriginalFolder();
  finishSave.textContent = root
    ? `保存将写回原文件夹：${root}`
    : "未能定位打开文件所在的文件夹，请用「另存为」。";
});

btnSave.addEventListener("click", async () => {
  if (saving) return;
  saving = true;
  finishSave.textContent = "正在保存到原文件夹…";
  try {
    const root = await resolveOriginalFolder();
    if (!root) {
      finishSave.textContent = "未能定位打开文件所在的文件夹，请用「另存为」。";
      return;
    }
    await postSaveLabels({ mode: "save", folder: root });
  } catch (error) {
    persist();
    finishSave.textContent = `保存失败（${error.message}），已暂存在浏览器本地。`;
  } finally {
    saving = false;
  }
});

btnSaveAs.addEventListener("click", async () => {
  if (saving) return;
  saving = true;
  finishSave.textContent = "请选择另存位置…";
  const initial = folderRoot || inferFolderFromClouds() || readLastFolder() || "";
  try {
    const pick = await fetch(
      `/api/prepare_export_dir?initial=${encodeURIComponent(initial)}`,
      { method: "POST" }
    );
    const pickData = await pick.json().catch(() => ({}));
    if (!pick.ok || !pickData.path) {
      finishSave.textContent = pickData.detail || "已取消另存为。";
      return;
    }
    finishSave.textContent = `正在另存到：${pickData.path}`;
    await postSaveLabels({ mode: "saveas", exportDir: pickData.path });
  } catch (error) {
    persist();
    finishSave.textContent = `另存失败（${error.message}），已暂存在浏览器本地。`;
  } finally {
    saving = false;
  }
});

btnFinishCancel.addEventListener("click", () => {
  finishModal.hidden = true;
});

btnImportNew.addEventListener("click", () => {
  resetToImport();
});

btnExit.addEventListener("click", async () => {
  finishSave.textContent = "正在退出…";
  try {
    await fetch("/api/shutdown", { method: "POST" });
  } catch {
    /* server may already be closing */
  }
  document.body.innerHTML = "<div class='drop-screen'><div class='drop-card'><h1>已退出</h1><p>可以关闭此页面。</p></div></div>";
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  setStatus("正在读取文件夹…");
  try {
    const files = [];
    const items = event.dataTransfer.items;
    if (items && items.length) {
      const tasks = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) tasks.push(walkEntry(entry, files));
      }
      await Promise.all(tasks);
    }
    if (!files.length && event.dataTransfer.files?.length) {
      files.push(...filesFromInput(event.dataTransfer.files));
    }
    importBrowserFiles(files);
  } catch (error) {
    setStatus(error.message || String(error));
  }
});

btnBrowse.addEventListener("click", async () => {
  setStatus("请选择点云文件夹…");
  try {
    const pick = await fetch("/api/pick_folder", { method: "POST" });
    const data = await pick.json().catch(() => ({}));
    if (!pick.ok || !data.path) {
      setStatus(data.detail || "已取消选择");
      return;
    }
    setStatus("正在扫描本机文件夹…");
    await importLocalPath(data.path);
  } catch (error) {
    setStatus(error.message || String(error));
  }
});
folderInput.addEventListener("change", () => {
  if (!folderInput.files?.length) return;
  importBrowserFiles(filesFromInput(folderInput.files));
  folderInput.value = "";
});

btnLocal.addEventListener("click", () => {
  pathForm.hidden = !pathForm.hidden;
  if (!pathForm.hidden) pathInput.focus();
});

pathForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = pathInput.value.trim();
  if (!path) return;
  try {
    setStatus("正在扫描本机文件夹…");
    await importLocalPath(path);
  } catch (error) {
    setStatus(error.message || String(error));
  }
});

btnReimport.addEventListener("click", () => resetToImport());

pointSizeInput.addEventListener("input", () => {
  viewer.setPointSize(Number(pointSizeInput.value));
});

colorModeSelect.addEventListener("change", () => {
  viewer.setColorMode(colorModeSelect.value);
});

btnReset.addEventListener("click", () => viewer.resetView());

updateShortcutLabels();
