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

  assign(cloudId, instanceId) {
    let leaf = this.get(this.activeId);
    if (!leaf) leaf = this.createLeaf();
    for (const other of this.leaves) {
      if (other !== leaf && other.assignments[cloudId] === instanceId) {
        delete other.assignments[cloudId];
      }
    }
    leaf.assignments[cloudId] = instanceId;
    return leaf;
  }

  unassign(cloudId, leafId = this.activeId) {
    const leaf = this.get(leafId);
    if (!leaf || leaf.assignments[cloudId] == null) return null;
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
    return this.leaves.find((leaf) => leaf.assignments[cloudId] === instanceId) || null;
  }

  labeledMap(cloudId) {
    const map = new Map();
    for (const leaf of this.leaves) {
      const instanceId = leaf.assignments[cloudId];
      if (instanceId == null) continue;
      map.set(instanceId, { leafId: leaf.id, rgb: leafRgb(leaf.id) });
    }
    return map;
  }

  toJSON() {
    return {
      nextId: this.nextAvailableId(),
      leaves: this.leaves,
    };
  }

  fromJSON(data) {
    this.leaves = Array.isArray(data?.leaves) ? data.leaves.map((leaf) => ({
      id: leaf.id,
      name: `${leaf.id}号叶片`,
      assignments: { ...(leaf.assignments || {}) },
    })) : [];
    this.leaves.sort((a, b) => a.id - b.id);
    this.activeId = null;
  }
}
