// 视角缓存：按「文件夹 + 点云」记住离开时的相机状态。
// 与标注数据、撤销历史及导出格式无关，只影响切换生长时期时的画面朝向。
const VIEW_PREF_KEY = "pc-label:remember-view";
const VIEW_STORE_PREFIX = "pc-label:views:";
const VIEW_STORE_LIMIT = 400;

function normalizeKeys(keys) {
  const list = [];
  for (const value of keys || []) {
    const text = String(value || "").trim();
    if (text && !list.includes(text)) list.push(text);
  }
  return list;
}

function readRememberPref() {
  try {
    return localStorage.getItem(VIEW_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeRememberPref(on) {
  try {
    localStorage.setItem(VIEW_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

function isViewData(view) {
  return Boolean(view)
    && Array.isArray(view.position) && view.position.length === 3
    && Array.isArray(view.target) && view.target.length === 3;
}

function readStoredViews(keys) {
  for (const key of keys) {
    let raw = null;
    try {
      raw = localStorage.getItem(VIEW_STORE_PREFIX + key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && typeof parsed.views === "object" ? parsed.views : parsed;
      const map = new Map();
      for (const [id, view] of Object.entries(list || {})) {
        if (isViewData(view)) map.set(String(id), view);
      }
      if (map.size) return map;
    } catch {
      /* 记录损坏时当作没有缓存 */
    }
  }
  return new Map();
}

function dropStoredViews(keys) {
  for (const key of keys) {
    try {
      localStorage.removeItem(VIEW_STORE_PREFIX + key);
    } catch {
      /* ignore */
    }
  }
}

export class ViewOptions {
  constructor(viewer, hideButton, rememberButton) {
    this.viewer = viewer;
    this.hideButton = hideButton;
    this.rememberButton = rememberButton;
    // 默认开启：同一株植物的不同时期来回切换时，视角不会被重置。
    this.remember = readRememberPref();
    this.views = new Map();
    this.storageKeys = [];
    this.currentId = null;
    hideButton.addEventListener("click", () => this.toggleHidden());
    rememberButton.addEventListener("click", () => this.toggleRemember());
  }

  updateLabels(shortcutText) {
    this.shortcutText = shortcutText;
    this.render();
  }

  render() {
    for (const [button, action, label, on] of [
      [this.hideButton, "hideLabeled", "隐藏已标", this.viewer.hideLabeled],
      [this.rememberButton, "rememberView", "视角保留", this.remember],
    ]) {
      button.textContent = `${label}：${on ? "开" : "关"} (${this.shortcutText(action)})`;
      button.setAttribute("aria-pressed", String(on));
    }
  }

  toggleHidden() {
    this.viewer.setHideLabeled(!this.viewer.hideLabeled);
    this.render();
  }

  toggleRemember() {
    this.remember = !this.remember;
    writeRememberPref(this.remember);
    if (this.remember) this.saveCurrent();
    else {
      this.views.clear();
      dropStoredViews(this.storageKeys);
    }
    this.render();
  }

  /** 每次导入文件夹时调用，取出该文件夹之前缓存的视角。 */
  useFolder(keys) {
    this.leaveFolder();
    this.storageKeys = normalizeKeys(keys);
    this.views = this.remember ? readStoredViews(this.storageKeys) : new Map();
  }

  /** 离开当前文件夹（重新导入、退出）时调用：先存下正在看的视角。 */
  leaveFolder() {
    if (this.saveCurrent()) this.persist();
    this.currentId = null;
  }

  /** 文件夹键变化时调用（例如拖入的文件夹定位到了本机路径）。 */
  setStorageKeys(keys) {
    this.storageKeys = normalizeKeys(keys);
  }

  /** 点云 id 变化后调用（oldId -> newId）。 */
  remapIds(map) {
    if (!map?.size) return;
    const next = new Map();
    for (const [id, view] of this.views) {
      const mapped = map.get(id);
      if (mapped) next.set(String(mapped), view);
      else next.set(id, view);
    }
    this.views = next;
    if (this.currentId != null && map.has(this.currentId)) this.currentId = String(map.get(this.currentId));
  }

  /** 记下当前画面的视角：切换点云、点「复位视角」、关闭页面时调用。 */
  saveCurrent() {
    if (!this.remember || !this.viewer.cloud || this.currentId == null) return false;
    const id = String(this.currentId);
    // 先删后写，保证 Map 的顺序就是「最近使用」的顺序，方便按数量淘汰。
    this.views.delete(id);
    this.views.set(id, this.viewer.captureView());
    while (this.views.size > VIEW_STORE_LIMIT) {
      this.views.delete(this.views.keys().next().value);
    }
    return true;
  }

  persist() {
    if (!this.remember || !this.storageKeys.length || !this.views.size) return;
    let payload = null;
    try {
      payload = JSON.stringify({ savedAt: Date.now(), views: Object.fromEntries(this.views) });
    } catch {
      return;
    }
    for (const key of this.storageKeys) {
      try {
        localStorage.setItem(VIEW_STORE_PREFIX + key, payload);
      } catch {
        /* 超出配额时忽略，视角缓存不该影响标注 */
      }
    }
  }

  /**
   * 切换点云。
   * - 有待恢复的缓存：精确还原该点云离开时的视角；
   * - 本次导入里还没看过的时期：沿用当前视角（按点云大小换算），而不是跳回默认视角；
   * - 刚导入新文件夹的第一张：仍按默认取景，避免沿用上一株植物的视角；
   * - 关闭「视角保留」时：仍按原来的方式重新取景。
   */
  show(cloud, { id = null, ...options } = {}) {
    const changed = this.saveCurrent();
    if (changed) this.persist();
    const key = id == null ? null : String(id);
    const saved = this.remember && key != null ? this.views.get(key) : null;
    const carried =
      !saved && this.remember && this.currentId != null && this.viewer.cloud
        ? this.viewer.captureView()
        : null;
    this.viewer.show(cloud, options);
    if (saved) this.viewer.restoreView(saved);
    else if (carried) this.viewer.restoreView(carried, { scale: true });
    this.currentId = key;
  }

  /** 复位到适合当前点云的默认视角，并把复位后的视角记进缓存。 */
  resetView() {
    this.viewer.resetView();
    if (this.saveCurrent()) this.persist();
  }
}
