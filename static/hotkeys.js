const STORAGE_KEY = "pc-label:hotkeys";

export const HOTKEY_DEFS = [
  { id: "prevCloud", label: "上一个点云" },
  { id: "nextCloud", label: "下一个点云" },
  { id: "prevLeaf", label: "上一片叶片" },
  { id: "nextLeaf", label: "下一片叶片" },
  { id: "addLeaf", label: "新增叶片" },
  { id: "unassign", label: "取消当前文件对应" },
  { id: "deleteLeaf", label: "删除整片叶片" },
  { id: "undo", label: "撤销" },
  { id: "redo", label: "重做" },
  { id: "panUp", label: "视角上移" },
  { id: "panDown", label: "视角下移" },
  { id: "panLeft", label: "视角左移" },
  { id: "panRight", label: "视角右移" },
  { id: "exitDrag", label: "退出拖动视角" },
];

export const DEFAULT_HOTKEYS = {
  prevCloud: { code: "ArrowLeft", key: "ArrowLeft", ctrl: false, shift: false, alt: false },
  nextCloud: { code: "ArrowRight", key: "ArrowRight", ctrl: false, shift: false, alt: false },
  prevLeaf: { code: "ArrowUp", key: "ArrowUp", ctrl: false, shift: false, alt: false },
  nextLeaf: { code: "ArrowDown", key: "ArrowDown", ctrl: false, shift: false, alt: false },
  addLeaf: { code: "KeyM", key: "m", ctrl: false, shift: false, alt: false },
  unassign: { code: "Delete", key: "Delete", ctrl: false, shift: false, alt: false },
  deleteLeaf: { code: "Delete", key: "Delete", ctrl: false, shift: true, alt: false },
  undo: { code: "KeyZ", key: "z", ctrl: true, shift: false, alt: false },
  redo: { code: "KeyY", key: "y", ctrl: true, shift: false, alt: false },
  panUp: { code: "KeyW", key: "w", ctrl: false, shift: false, alt: false },
  panDown: { code: "KeyS", key: "s", ctrl: false, shift: false, alt: false },
  panLeft: { code: "KeyA", key: "a", ctrl: false, shift: false, alt: false },
  panRight: { code: "KeyD", key: "d", ctrl: false, shift: false, alt: false },
  exitDrag: { code: "Escape", key: "Escape", ctrl: false, shift: false, alt: false },
};

export const PAN_INTERNAL = {
  panUp: "KeyW",
  panDown: "KeyS",
  panLeft: "KeyA",
  panRight: "KeyD",
};

function cloneBinding(binding) {
  return {
    code: String(binding.code || ""),
    key: String(binding.key || ""),
    ctrl: Boolean(binding.ctrl),
    shift: Boolean(binding.shift),
    alt: Boolean(binding.alt),
  };
}

export function cloneHotkeyMap(source = DEFAULT_HOTKEYS) {
  const next = {};
  for (const def of HOTKEY_DEFS) {
    next[def.id] = cloneBinding(source[def.id] || DEFAULT_HOTKEYS[def.id]);
  }
  return next;
}

export function loadHotkeys() {
  const next = cloneHotkeyMap();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object") {
      for (const def of HOTKEY_DEFS) {
        if (saved[def.id]?.code) next[def.id] = cloneBinding({ ...DEFAULT_HOTKEYS[def.id], ...saved[def.id] });
      }
    }
  } catch {
    /* ignore */
  }
  return next;
}

export function saveHotkeys(hotkeys) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hotkeys));
  } catch {
    /* ignore quota */
  }
}

export function bindingFromEvent(event) {
  return {
    code: event.code,
    key: event.key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

export function sameBinding(a, b) {
  if (!a || !b) return false;
  return a.code === b.code && Boolean(a.ctrl) === Boolean(b.ctrl) && Boolean(a.shift) === Boolean(b.shift) && Boolean(a.alt) === Boolean(b.alt);
}

export function matchBinding(binding, event) {
  if (!binding) return false;
  const ctrl = event.ctrlKey || event.metaKey;
  if (Boolean(binding.ctrl) !== Boolean(ctrl)) return false;
  if (Boolean(binding.shift) !== Boolean(event.shiftKey)) return false;
  if (Boolean(binding.alt) !== Boolean(event.altKey)) return false;
  if (binding.code && event.code) return binding.code === event.code;
  return String(binding.key).toLowerCase() === String(event.key).toLowerCase();
}

function prettyKey(code, key) {
  const named = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
    Delete: "Delete",
    Backspace: "Backspace",
    Enter: "Enter",
    Space: "空格",
    Tab: "Tab",
  };
  if (named[code] || named[key]) return named[code] || named[key];
  if (code?.startsWith("Key")) return code.slice(3);
  if (code?.startsWith("Digit")) return code.slice(5);
  if (key && key.length === 1) return key.toUpperCase();
  return key || code || "?";
}

export function formatBinding(binding) {
  if (!binding) return "";
  const parts = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(prettyKey(binding.code, binding.key));
  return parts.join("+");
}

export function matchHotkeyAction(hotkeys, event) {
  const ranked = HOTKEY_DEFS.map((def) => def.id).sort((a, b) => {
    const bindA = hotkeys[a];
    const bindB = hotkeys[b];
    const score = (bind) => Number(bind.ctrl) + Number(bind.shift) + Number(bind.alt);
    return score(bindB) - score(bindA);
  });
  return ranked.find((id) => matchBinding(hotkeys[id], event)) || null;
}

export function assignHotkey(hotkeys, id, binding) {
  const next = { ...hotkeys, [id]: cloneBinding(binding) };
  const conflict = HOTKEY_DEFS.map((def) => def.id).find(
    (other) => other !== id && sameBinding(next[other], next[id])
  );
  if (conflict) next[conflict] = cloneBinding(hotkeys[id]);
  return next;
}
