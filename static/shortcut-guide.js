import { HOTKEY_DEFS, formatBinding } from "./hotkeys.js?v=27";

const escapeXml = (text) => String(text).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[char]));

export function setupShortcutGuide(getHotkeys, onOpen) {
  const dialog = document.getElementById("shortcut-guide");
  const image = document.getElementById("shortcut-guide-image");
  const close = document.getElementById("btn-guide-close");
  const open = () => {
    onOpen();
    const hotkeys = getHotkeys();
    const rows = HOTKEY_DEFS.map((def) => [formatBinding(hotkeys[def.id]), def.label]);
    rows.push(
      ["左键单击", "标注未对应实例 / 选择已对应叶片"],
      ["左键拖动", "旋转（拖动视角模式中为平移）"],
      ["右键拖动", "屏幕平移"],
      ["滚轮 / 中键拖动", "缩放"],
      ["右键双击", "开启 / 关闭拖动视角模式"],
      ["单指 / 双指", "触屏旋转 / 缩放与平移"],
    );
    const count = Math.ceil(rows.length / 2);
    const cards = rows.map(([key, label], index) => {
      const x = 24 + Math.floor(index / count) * 526;
      const y = 88 + (index % count) * 48;
      return `<g transform="translate(${x} ${y})">
        <rect width="506" height="40" rx="7" fill="#1c232c"/>
        <rect x="8" y="6" width="168" height="28" rx="5" fill="#263c52"/>
        <text x="92" y="26" text-anchor="middle" fill="#91caff">${escapeXml(key)}</text>
        <text x="188" y="26">${escapeXml(label)}</text>
      </g>`;
    }).join("");
    const footer = 96 + count * 48;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${footer + 100}" viewBox="0 0 1080 ${footer + 100}">
      <rect width="100%" height="100%" rx="12" fill="#111820"/>
      <g font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" fill="#e6edf3">
        <text x="24" y="38" font-size="25" font-weight="600">点云叶片标注 · 快捷键示例图</text>
        <text x="24" y="66" fill="#9caab8">按当前设置生成 · 所有键盘快捷键与鼠标 / 触屏操作</text>
        ${cards}
        <text x="24" y="${footer + 12}" fill="#91caff">视角保留示例：0915 调整视角 → 0917 → 返回 0915，恢复上次旋转、缩放和平移。</text>
        <text x="24" y="${footer + 40}" fill="#9caab8">隐藏已标叶片：隐藏后无法点选；再次切换恢复半透明显示。Ctrl+Z 仍是撤销。</text>
        <text x="24" y="${footer + 68}" fill="#9caab8">Esc 也可结束叶片合并；图示或设置面板内用于关闭 / 取消改键。设置中可自定义按键。</text>
      </g>
    </svg>`;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    image.alt = rows.map(([key, label]) => `${key}：${label}`).join("；");
    dialog.showModal();
    close.focus();
  };
  // 模态图示打开时拦截标注快捷键；Esc 交给原生 dialog 关闭。
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  close.addEventListener("click", () => dialog.close());
  document.getElementById("btn-shortcut-guide").addEventListener("click", open);
  open();
}
