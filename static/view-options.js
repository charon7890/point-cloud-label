// 视角按点云对象独立保存；与标注数据、撤销历史及导出格式无关。
export class ViewOptions {
  constructor(viewer, hideButton, rememberButton) {
    this.viewer = viewer;
    this.hideButton = hideButton;
    this.rememberButton = rememberButton;
    this.remember = false;
    this.views = new WeakMap();
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
    if (!this.remember) this.views = new WeakMap();
    this.render();
  }

  show(cloud, options) {
    // 在实际替换画面时保存，异步加载或快速切换不会把视角记到错误文件。
    if (this.remember && this.viewer.cloud) {
      this.views.set(this.viewer.cloud, this.viewer.captureView());
    }
    const view = this.remember ? this.views.get(cloud) : null;
    this.viewer.show(cloud, options);
    if (view) this.viewer.restoreView(view);
  }
}
