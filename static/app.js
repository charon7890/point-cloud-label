import {
  MAX_POINTS,
  filesFromInput,
  formatSize,
  toCloudItems,
  unpackCloud,
  walkEntry,
} from "./format.js?v=19";
import { leafCss, LeafBook } from "./labels.js?v=19";
import { PointCloudViewer } from "./viewer.js?v=19";

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

const viewer = new PointCloudViewer(viewport);
const book = new LeafBook();
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
      next[byRel.get(rel) || byName.get(name) || cloudId] = instanceId;
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
  return book.leaves.filter((leaf) => leaf.assignments[cloudId] != null).length;
}

function updateHint() {
  const active = book.get(book.activeId);
  if (active) {
    hint.textContent = `已选 ${active.name}：WASD（W上 A左 S下 D右）· 双击右键拖动 · ↑↓叶片 ←→点云 · M 新增`;
    pickBadge.hidden = false;
    pickBadge.textContent = `将标注为 ${active.name}（Delete 取消当前文件对应）`;
    return;
  }
  pickBadge.hidden = true;
  hint.textContent = "WASD：W上 A左 S下 D右 · 双击右键拖动视角 · ←→点云 · ↑↓叶片 · M 新增";
}

function applyLabelsToViewer() {
  if (!activeId) {
    viewer.setLabeledInstances(new Map());
    return;
  }
  viewer.setLabeledInstances(book.labeledMap(activeId));
}

function renderLeaves() {
  leafList.innerHTML = "";
  if (!book.leaves.length) {
    leafMeta.textContent = "单击点云中的实例，或按 M 新增叶片";
  } else {
    const currentAssigned = activeId ? assignedCount(activeId) : 0;
    const extra = book.activeId != null ? "；Delete 只取消当前文件对应" : "";
    leafMeta.textContent = `共 ${book.leaves.length} 个叶片；当前文件已对应 ${currentAssigned} 个${extra}`;
  }
  for (const leaf of book.leaves) {
    const li = document.createElement("li");
    const assignedHere = activeId != null && leaf.assignments[activeId] != null;
    const fileCount = Object.keys(leaf.assignments).length;
    if (leaf.id === book.activeId) li.classList.add("active");
    li.innerHTML = `
      <span class="left">
        <span class="swatch" style="background:${leafCss(leaf.id)}"></span>
        <span>
          <span class="inst-id">${leaf.name}</span>
          <span class="sub">${assignedHere ? "当前文件已对应" : "当前文件未对应"} · ${fileCount} 个点云</span>
        </span>
      </span>`;
    li.addEventListener("click", () => {
      book.toggleActive(leaf.id);
      const inst = activeId != null ? leaf.assignments[activeId] : null;
      viewer.highlightInstance(book.activeId === leaf.id ? inst ?? null : null);
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
  const explicit = book.activeId != null;
  if (!explicit && existing) {
    book.activeId = existing.id;
    viewer.highlightInstance(instanceId);
    renderLeaves();
    return;
  }
  const wasExplicit = explicit;
  book.assign(activeId, instanceId);
  if (!wasExplicit) book.activeId = null;
  persist();
  applyLabelsToViewer();
  renderLeaves();
  renderList();
  viewer.highlightInstance(instanceId);
}

function refreshAfterLabelChange() {
  persist();
  applyLabelsToViewer();
  renderLeaves();
  renderList();
}

function unassignCurrentFile() {
  if (book.activeId == null || !activeId) return false;
  if (!book.unassign(activeId, book.activeId)) return false;
  refreshAfterLabelChange();
  viewer.highlightInstance(null);
  return true;
}

function deleteEntireLeaf() {
  if (book.activeId == null) return;
  book.remove(book.activeId);
  refreshAfterLabelChange();
  viewer.highlightInstance(null);
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
  const inst = activeId != null ? leaf.assignments[activeId] : null;
  viewer.highlightInstance(inst ?? null);
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
    const current = new Worker("/static/parser.worker.js?v=19");
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
  const activeLeaf = book.get(book.activeId);
  const inst = activeLeaf && activeId ? activeLeaf.assignments[activeId] : null;
  viewer.highlightInstance(inst ?? null);
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
  viewer.clear();
  finishModal.hidden = true;
  appEl.hidden = true;
  dropScreen.hidden = false;
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
  persist();
  renderLeaves();
  viewer.highlightInstance(null);
  viewer.controls.enabled = true;
  viewport.focus({ preventScroll: true });
}

btnAddLeaf.addEventListener("click", () => {
  addNewLeaf();
});

window.addEventListener("keydown", (event) => {
  const el = document.activeElement;
  const tag = el?.tagName;
  if (tag === "TEXTAREA") return;
  if (tag === "SELECT") return;
  if (tag === "INPUT" && (el.type === "text" || el.type === "search" || el.type === "number")) return;
  if (!finishModal.hidden || appEl.hidden) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === "Escape") {
    event.preventDefault();
    viewer.setViewDragMode(false);
    viewer.clearPanKeys();
    return;
  }
  const wasdCode =
    event.code === "KeyW" || event.code === "KeyA" || event.code === "KeyS" || event.code === "KeyD"
      ? event.code
      : { w: "KeyW", a: "KeyA", s: "KeyS", d: "KeyD" }[String(event.key).toLowerCase()];
  if (wasdCode) {
    event.preventDefault();
    viewer.setPanKey(wasdCode, true);
    return;
  }
  if (event.key === "Delete") {
    event.preventDefault();
    handleDeleteKey(event.shiftKey);
    return;
  }
  if ((event.key === "m" || event.key === "M") && !event.repeat) {
    event.preventDefault();
    addNewLeaf();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepCloud(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    stepCloud(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    stepLeaf(-1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    stepLeaf(1);
  }
});

window.addEventListener("keyup", (event) => {
  const wasdCode =
    event.code === "KeyW" || event.code === "KeyA" || event.code === "KeyS" || event.code === "KeyD"
      ? event.code
      : { w: "KeyW", a: "KeyA", s: "KeyS", d: "KeyD" }[String(event.key).toLowerCase()];
  if (wasdCode) viewer.setPanKey(wasdCode, false);
});

window.addEventListener("blur", () => {
  viewer.clearPanKeys();
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
  finishSummary.textContent = `共 ${cloudCount} 个点云，${leafCount} 个叶片标签；其中 ${mappedFiles} 个点云已有对应。`;
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
