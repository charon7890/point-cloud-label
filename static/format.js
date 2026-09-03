const MAGIC = "PCD1";
const DATE_RE = /(20\d{6})/;
const POINT_EXTS = [".txt", ".xyz", ".ply", ".pcd"];
const MAX_POINTS = 0;

function extractTimeKey(name) {
  const match = String(name).match(DATE_RE);
  return match ? match[1] : "";
}

function formatDateLabel(timeKey) {
  if (timeKey && timeKey.length === 8) {
    return `${timeKey.slice(0, 4)}-${timeKey.slice(4, 6)}-${timeKey.slice(6, 8)}`;
  }
  return timeKey || "未知时间";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPointCloudName(name) {
  const lower = name.toLowerCase();
  return POINT_EXTS.some((ext) => lower.endsWith(ext));
}

async function walkEntry(entry, files) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    files.push({ file, relPath: entry.fullPath.replace(/^\//, "") });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const readBatch = () =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  while (true) {
    const batch = await readBatch();
    if (!batch.length) break;
    for (const child of batch) {
      await walkEntry(child, files);
    }
  }
}

function filesFromInput(fileList) {
  return Array.from(fileList).map((file) => ({
    file,
    relPath: file.webkitRelativePath || file.name,
  }));
}

function toCloudItems(entries) {
  const items = entries
    .filter((entry) => isPointCloudName(entry.relPath || entry.file.name))
    .map((entry) => {
      const relPath = entry.relPath || entry.file.name;
      const parts = relPath.split(/[/\\]/);
      const fileName = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts[parts.length - 2] : "";
      const timeKey = extractTimeKey(fileName) || extractTimeKey(parent) || extractTimeKey(relPath);
      return {
        id: relPath,
        name: fileName.replace(/\.[^.]+$/, ""),
        fileName,
        relativePath: relPath,
        timeKey: timeKey || String(entry.file.lastModified || 0),
        dateLabel: formatDateLabel(timeKey),
        sizeBytes: entry.file.size,
        file: entry.file,
        source: "browser",
      };
    });
  items.sort((a, b) => {
    if (a.timeKey === b.timeKey) return a.relativePath.localeCompare(b.relativePath);
    return a.timeKey.localeCompare(b.timeKey);
  });
  return items;
}

function alignOffset(offset, align) {
  const rem = offset % align;
  return rem === 0 ? offset : offset + (align - rem);
}

function unpackCloud(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error("点云数据格式不正确");
  const count = view.getUint32(4, true);
  const flags = view.getUint32(8, true);
  let offset = 12;
  const positions = new Float32Array(buffer.slice(offset, offset + count * 12));
  offset += count * 12;
  const actualCount = Math.floor(positions.length / 3);
  let colors = null;
  let semantic = null;
  let instances = null;
  if (flags & 1) {
    colors = new Uint8Array(buffer.slice(offset, offset + count * 3));
    offset += count * 3;
  }
  if (flags & 2) {
    offset = alignOffset(offset, 2);
    semantic = new Uint16Array(buffer.slice(offset, offset + count * 2));
    offset += count * 2;
  }
  if (flags & 4) {
    offset = alignOffset(offset, 4);
    instances = new Uint32Array(buffer.slice(offset, offset + count * 4));
  }
  return { count: actualCount, positions, colors, semantic, instances };
}

function buildInstanceStats(cloud) {
  if (!cloud.instances) return [];
  const map = new Map();
  for (let i = 0; i < cloud.count; i += 1) {
    const id = cloud.instances[i];
    let rec = map.get(id);
    if (!rec) {
      rec = {
        id,
        count: 0,
        semantic: cloud.semantic ? cloud.semantic[i] : null,
      };
      map.set(id, rec);
    }
    rec.count += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.id - b.id);
}

export {
  DATE_RE,
  MAX_POINTS,
  buildInstanceStats,
  filesFromInput,
  formatSize,
  toCloudItems,
  unpackCloud,
  walkEntry,
};
