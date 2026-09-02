const MAGIC = "PCD1";

function shouldSkipLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const first = trimmed[0];
  if (first === "#" || first === "/") return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("ply") ||
    lower.startsWith("format") ||
    lower.startsWith("comment") ||
    lower.startsWith("element") ||
    lower.startsWith("property") ||
    lower.startsWith("end_header") ||
    lower.startsWith("version")
  );
}

function alignSize(size, align) {
  const rem = size % align;
  return rem === 0 ? size : size + (align - rem);
}

function growTyped(arr, Ctor, minLength) {
  if (minLength <= arr.length) return arr;
  const next = new Ctor(Math.max(minLength, Math.ceil(arr.length * 1.5) + 4096));
  next.set(arr);
  return next;
}

function packCloud(positions, colors, semantic, instances) {
  const count = positions.length / 3;
  let flags = 0;
  if (colors) flags |= 1;
  if (semantic) flags |= 2;
  if (instances) flags |= 4;

  let size = 12 + count * 12;
  if (colors) size += count * 3;
  if (semantic) {
    size = alignSize(size, 2);
    size += count * 2;
  }
  if (instances) {
    size = alignSize(size, 4);
    size += count * 4;
  }

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, count, true);
  view.setUint32(8, flags, true);
  new Float32Array(buffer, 12, count * 3).set(positions);
  let offset = 12 + count * 12;
  if (colors) {
    new Uint8Array(buffer, offset, count * 3).set(colors);
    offset += count * 3;
  }
  if (semantic) {
    offset = alignSize(offset, 2);
    new Uint16Array(buffer, offset, count).set(semantic);
    offset += count * 2;
  }
  if (instances) {
    offset = alignSize(offset, 4);
    new Uint32Array(buffer, offset, count).set(instances);
  }
  return buffer;
}

async function parseFile(file, maxPoints, onProgress) {
  const estimated = Math.max(1024, Math.floor(file.size / 80) + 16);
  let positions = new Float32Array(estimated * 3);
  let colors = new Uint8Array(estimated * 3);
  let semantic = new Uint16Array(estimated);
  let instances = new Uint32Array(estimated);
  let count = 0;
  let hasColor = false;
  let hasSemantic = false;
  let hasInstance = false;
  let leftover = "";
  let bytesRead = 0;
  const unlimited = !maxPoints || maxPoints <= 0;

  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");

  const consumeLine = (line) => {
    if (shouldSkipLine(line)) return;
    if (!unlimited && count >= maxPoints) return;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if ((count + 1) * 3 > positions.length) {
      positions = growTyped(positions, Float32Array, (count + 1) * 3);
      colors = growTyped(colors, Uint8Array, (count + 1) * 3);
      semantic = growTyped(semantic, Uint16Array, count + 1);
      instances = growTyped(instances, Uint32Array, count + 1);
    }
    const i = count * 3;
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
    if (parts.length >= 8) {
      instances[count] = Math.max(0, Number(parts[3]) || 0);
      semantic[count] = Math.min(65535, Math.max(0, Number(parts[4]) || 0));
      colors[i] = Math.min(255, Math.max(0, Number(parts[5]) || 0));
      colors[i + 1] = Math.min(255, Math.max(0, Number(parts[6]) || 0));
      colors[i + 2] = Math.min(255, Math.max(0, Number(parts[7]) || 0));
      hasInstance = true;
      hasSemantic = true;
      hasColor = true;
    } else if (parts.length >= 6) {
      colors[i] = Math.min(255, Math.max(0, Number(parts[3]) || 0));
      colors[i + 1] = Math.min(255, Math.max(0, Number(parts[4]) || 0));
      colors[i + 2] = Math.min(255, Math.max(0, Number(parts[5]) || 0));
      hasColor = true;
    } else if (parts.length >= 4) {
      instances[count] = Math.max(0, Number(parts[3]) || 0);
      hasInstance = true;
    }
    count += 1;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    leftover += decoder.decode(value, { stream: true });
    const lines = leftover.split(/\r?\n/);
    leftover = lines.pop() || "";
    for (const line of lines) consumeLine(line);
    if (onProgress) onProgress(Math.min(0.99, bytesRead / file.size));
    if (!unlimited && count >= maxPoints) {
      reader.cancel();
      break;
    }
  }
  leftover += decoder.decode();
  if (leftover) consumeLine(leftover);
  if (onProgress) onProgress(1);

  if (!count) throw new Error("未能从文件中解析出点");
  return packCloud(
    positions.subarray(0, count * 3),
    hasColor ? colors.subarray(0, count * 3) : null,
    hasSemantic ? semantic.subarray(0, count) : null,
    hasInstance ? instances.subarray(0, count) : null
  );
}

self.onmessage = async (event) => {
  const { file, maxPoints = 0 } = event.data;
  try {
    const buffer = await parseFile(file, maxPoints, (progress) => {
      self.postMessage({ type: "progress", progress });
    });
    self.postMessage({ type: "done", buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
