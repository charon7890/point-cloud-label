function leafHue(id) {
  return (id * 0.61803398875) % 1;
}

function hueToRgb(hue) {
  const x = 1 - Math.abs((hue * 6) % 2 - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 1 / 6) {
    r = 1;
    g = x;
  } else if (hue < 2 / 6) {
    r = x;
    g = 1;
  } else if (hue < 3 / 6) {
    g = 1;
    b = x;
  } else if (hue < 4 / 6) {
    g = x;
    b = 1;
  } else if (hue < 5 / 6) {
    r = x;
    b = 1;
  } else {
    r = 1;
    b = x;
  }
  return [0.2 + r * 0.8, 0.2 + g * 0.8, 0.2 + b * 0.8];
}

export function leafRgb(id) {
  return hueToRgb(leafHue(id));
}

export function leafCss(id) {
  return `hsl(${(leafHue(id) * 360).toFixed(1)} 72% 58%)`;
}

export function asInstanceList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = Number(item);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function cloneAssignments(assignments) {
  const next = {};
  for (const [cloudId, value] of Object.entries(assignments || {})) {
    const ids = asInstanceList(value);
    if (ids.length) next[cloudId] = ids;
  }
  return next;
}

export class LeafBook {
  constructor() {
    this.leaves = [];
    this.activeId = null;
  }

  reset() {
    this.leaves = [];
    this.activeId = null;
  }

  nextAvailableId() {
    const used = new Set(this.leaves.map((leaf) => leaf.id));
    let id = 1;
    while (used.has(id)) id += 1;
    return id;
  }

  createLeaf() {
    const id = this.nextAvailableId();
    const leaf = {
      id,
      name: `${id}号叶片`,
      assignments: {},
    };
    this.leaves.push(leaf);
    this.leaves.sort((a, b) => a.id - b.id);
    this.activeId = id;
    return leaf;
  }

  get(id) {
    return this.leaves.find((leaf) => leaf.id === id) || null;
  }

  toggleActive(id) {
    this.activeId = this.activeId === id ? null : id;
    return this.activeId;
  }

  instancesOf(leafId, cloudId) {
    const leaf = this.get(leafId);
    if (!leaf || cloudId == null) return [];
    return asInstanceList(leaf.assignments[cloudId]);
  }

  assign(cloudId, instanceId, { append = false } = {}) {
    const inst = Number(instanceId);
    if (!Number.isFinite(inst)) return null;
    const occupied = this.leafForInstance(cloudId, inst);
    let leaf = this.get(this.activeId);
    if (occupied) {
      if (leaf && occupied.id === leaf.id) return leaf;
      return null;
    }
    if (!leaf) leaf = this.createLeaf();
    const current = asInstanceList(leaf.assignments[cloudId]);
    if (append) {
      if (!current.includes(inst)) current.push(inst);
      leaf.assignments[cloudId] = current;
      return leaf;
    }
    leaf.assignments[cloudId] = [inst];
    return leaf;
  }

  removeInstance(cloudId, instanceId, leafId = this.activeId) {
    const leaf = this.get(leafId);
    const inst = Number(instanceId);
    const current = asInstanceList(leaf?.assignments[cloudId]);
    if (!leaf || !Number.isFinite(inst) || !current.includes(inst)) return null;
    const next = current.filter((id) => id !== inst);
    if (next.length) leaf.assignments[cloudId] = next;
    else delete leaf.assignments[cloudId];
    return leaf;
  }

  unassign(cloudId, leafId = this.activeId) {
    const leaf = this.get(leafId);
    if (!leaf || asInstanceList(leaf.assignments[cloudId]).length === 0) return null;
    delete leaf.assignments[cloudId];
    return leaf;
  }

  remove(id) {
    const index = this.leaves.findIndex((leaf) => leaf.id === id);
    if (index < 0) return null;
    const [removed] = this.leaves.splice(index, 1);
    if (this.activeId === id) this.activeId = null;
    return removed;
  }

  leafForInstance(cloudId, instanceId) {
    const inst = Number(instanceId);
    if (!Number.isFinite(inst)) return null;
    return this.leaves.find((leaf) => asInstanceList(leaf.assignments[cloudId]).includes(inst)) || null;
  }

  labeledMap(cloudId) {
    const map = new Map();
    for (const leaf of this.leaves) {
      for (const instanceId of asInstanceList(leaf.assignments[cloudId])) {
        map.set(instanceId, { leafId: leaf.id, rgb: leafRgb(leaf.id) });
      }
    }
    return map;
  }

  toJSON() {
    return {
      nextId: this.nextAvailableId(),
      leaves: this.leaves.map((leaf) => ({
        id: leaf.id,
        name: leaf.name,
        assignments: cloneAssignments(leaf.assignments),
      })),
    };
  }

  fromJSON(data) {
    this.leaves = Array.isArray(data?.leaves)
      ? data.leaves.map((leaf) => ({
          id: leaf.id,
          name: `${leaf.id}号叶片`,
          assignments: cloneAssignments(leaf.assignments),
        }))
      : [];
    this.leaves.sort((a, b) => a.id - b.id);
    this.activeId = data?.activeId ?? null;
  }
}

export class LabelHistory {
  constructor(limit = 80) {
    this.limit = limit;
    this.entries = [];
    this.index = -1;
  }

  snapshot(book) {
    return {
      activeId: book.activeId,
      leaves: book.leaves.map((leaf) => ({
        id: leaf.id,
        name: leaf.name,
        assignments: cloneAssignments(leaf.assignments),
      })),
    };
  }

  reset(book) {
    this.entries = [this.snapshot(book)];
    this.index = 0;
  }

  push(book) {
    const next = this.snapshot(book);
    const current = this.entries[this.index];
    if (current && JSON.stringify(current.leaves) === JSON.stringify(next.leaves)) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(next);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  apply(book, entry) {
    book.leaves = (entry.leaves || []).map((leaf) => ({
      id: leaf.id,
      name: `${leaf.id}号叶片`,
      assignments: cloneAssignments(leaf.assignments),
    }));
    book.leaves.sort((a, b) => a.id - b.id);
    book.activeId = entry.activeId ?? null;
  }

  undo(book) {
    if (this.index <= 0) return false;
    this.index -= 1;
    this.apply(book, this.entries[this.index]);
    return true;
  }

  redo(book) {
    if (this.index >= this.entries.length - 1) return false;
    this.index += 1;
    this.apply(book, this.entries[this.index]);
    return true;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }
}
