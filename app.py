"""本地点云浏览器：扫描文件夹、解析并缓存点云，供网页三维查看。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CACHE_DIR = APP_DIR / "cache"
EXPORT_DIR = APP_DIR / "exports"
CACHE_DIR.mkdir(exist_ok=True)
EXPORT_DIR.mkdir(exist_ok=True)

POINT_EXTS = {".txt", ".xyz", ".ply", ".pcd"}
DATE_RE = re.compile(r"(20\d{6})")
MAGIC = b"PCD1"
DEFAULT_MAX_POINTS = 0

app = FastAPI(title="点云浏览器")


@app.middleware("http")
async def no_store_static(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def extract_time_key(path: Path) -> str:
    for source in (path.stem, path.parent.name, path.name):
        match = DATE_RE.search(source)
        if match:
            return match.group(1)
    try:
        return str(int(path.stat().st_mtime))
    except OSError:
        return "0"


def format_date_label(time_key: str) -> str:
    if len(time_key) == 8 and time_key.isdigit():
        return f"{time_key[:4]}-{time_key[4:6]}-{time_key[6:8]}"
    return time_key


def _ignored_cloud_path(path: Path, root: Path) -> bool:
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        parts = path.parts
    return any(str(part).startswith("backup_") for part in parts)


def collect_clouds(root: Path) -> list[dict]:
    files = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in POINT_EXTS
        and not _ignored_cloud_path(path, root)
    ]
    items = []
    for path in files:
        time_key = extract_time_key(path)
        items.append(
            {
                "id": str(path),
                "name": path.stem,
                "fileName": path.name,
                "relativePath": str(path.relative_to(root)).replace("\\", "/"),
                "timeKey": time_key,
                "dateLabel": format_date_label(time_key),
                "sizeBytes": path.stat().st_size,
            }
        )
    items.sort(key=lambda item: (item["timeKey"], item["relativePath"]))
    return items


def _skip_header_lines(handle) -> None:
    while True:
        pos = handle.tell()
        line = handle.readline()
        if not line:
            handle.seek(pos)
            return
        stripped = line.strip()
        if not stripped or stripped[0] in "#/":
            continue
        if stripped.lower().startswith("ply") or stripped.lower().startswith("format"):
            continue
        if any(
            stripped.lower().startswith(prefix)
            for prefix in ("comment", "element", "property", "end_header", "version")
        ):
            continue
        handle.seek(pos)
        return


def load_ascii_cloud(
    path: Path,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None, np.ndarray | None]:
    """读取 ASCII 点云，返回 xyz、rgb(0-255)、sem_class、inst_class。"""
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        _skip_header_lines(handle)
        try:
            data = np.loadtxt(handle, dtype=np.float32, comments=("#", "/"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"无法解析点云: {exc}") from exc

    if data.size == 0:
        raise HTTPException(status_code=400, detail="点云文件为空")
    if data.ndim == 1:
        data = data.reshape(1, -1)
    if data.shape[1] < 3:
        raise HTTPException(status_code=400, detail="点云至少需要 x y z 三列")

    xyz = np.ascontiguousarray(data[:, :3])
    rgb = None
    sem = None
    inst = None
    cols = data.shape[1]
    # 本数据格式: x y z inst_class sem_class R G B ...
    if cols >= 8:
        inst = np.clip(data[:, 3], 0, 2**32 - 1).astype(np.uint32)
        sem = np.clip(data[:, 4], 0, 65535).astype(np.uint16)
        rgb = np.clip(data[:, 5:8], 0, 255)
    elif cols >= 6:
        rgb = np.clip(data[:, 3:6], 0, 255)
    elif cols >= 4:
        inst = np.clip(data[:, 3], 0, 2**32 - 1).astype(np.uint32)
    return xyz, rgb, sem, inst


def downsample(
    xyz: np.ndarray,
    rgb: np.ndarray | None,
    sem: np.ndarray | None,
    inst: np.ndarray | None,
    max_points: int,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None, np.ndarray | None]:
    count = len(xyz)
    if max_points <= 0 or count <= max_points:
        return xyz, rgb, sem, inst
    index = np.linspace(0, count - 1, max_points, dtype=np.int64)
    xyz = xyz[index]
    if rgb is not None:
        rgb = rgb[index]
    if sem is not None:
        sem = sem[index]
    if inst is not None:
        inst = inst[index]
    return xyz, rgb, sem, inst


def _pad_to(size: int, align: int) -> bytes:
    pad = (align - (size % align)) % align
    return b"\x00" * pad


def pack_cloud(
    xyz: np.ndarray,
    rgb: np.ndarray | None,
    sem: np.ndarray | None,
    inst: np.ndarray | None,
) -> bytes:
    flags = 0
    if rgb is not None:
        flags |= 1
    if sem is not None:
        flags |= 2
    if inst is not None:
        flags |= 4
    parts = [struct.pack("<4sII", MAGIC, int(len(xyz)), flags)]
    size = 12
    xyz_bytes = np.ascontiguousarray(xyz, dtype=np.float32).tobytes()
    parts.append(xyz_bytes)
    size += len(xyz_bytes)
    if rgb is not None:
        rgb_bytes = np.ascontiguousarray(rgb, dtype=np.uint8).tobytes()
        parts.append(rgb_bytes)
        size += len(rgb_bytes)
    if sem is not None:
        pad = _pad_to(size, 2)
        parts.append(pad)
        size += len(pad)
        sem_bytes = np.ascontiguousarray(sem, dtype=np.uint16).tobytes()
        parts.append(sem_bytes)
        size += len(sem_bytes)
    if inst is not None:
        pad = _pad_to(size, 4)
        parts.append(pad)
        inst_bytes = np.ascontiguousarray(inst, dtype=np.uint32).tobytes()
        parts.append(inst_bytes)
    return b"".join(parts)


def cache_path_for(file_path: Path, max_points: int) -> Path:
    digest = hashlib.sha1(
        f"{file_path.resolve()}|{file_path.stat().st_mtime_ns}|full-v4".encode()
    ).hexdigest()
    return CACHE_DIR / f"{digest}.bin"


def build_or_load_cache(file_path: Path, max_points: int) -> bytes:
    cached = cache_path_for(file_path, max_points)
    if cached.exists():
        return cached.read_bytes()
    xyz, rgb, sem, inst = load_ascii_cloud(file_path)
    payload = pack_cloud(xyz, rgb, sem, inst)
    cached.write_bytes(payload)
    return payload


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/scan")
def scan_folder(path: str = Query(..., min_length=1)) -> dict:
    root = Path(path).expanduser()
    if not root.exists():
        raise HTTPException(status_code=404, detail="文件夹不存在")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="路径不是文件夹")
    clouds = collect_clouds(root)
    if not clouds:
        raise HTTPException(status_code=404, detail="未找到点云文件（.txt / .xyz / .ply / .pcd）")
    return {"root": str(root.resolve()), "count": len(clouds), "clouds": clouds}


@app.get("/api/cloud")
def get_cloud(
    path: str = Query(..., min_length=1),
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=0, le=20_000_000),
) -> Response:
    file_path = Path(path).expanduser()
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="点云文件不存在")
    if file_path.suffix.lower() not in POINT_EXTS:
        raise HTTPException(status_code=400, detail="不支持的文件类型")
    payload = build_or_load_cache(file_path, max_points)
    return Response(content=payload, media_type="application/octet-stream")


def _choose_directory_winforms(title: str, initial: str | None = None) -> str | None:
    """Windows 文件夹窗口，带「新建文件夹」，独立进程弹出以免被服务线程挡住。"""
    env = os.environ.copy()
    env["PC_LABEL_TITLE"] = title
    env["PC_LABEL_INITIAL"] = initial or ""
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:PC_LABEL_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:PC_LABEL_INITIAL -and (Test-Path -LiteralPath $env:PC_LABEL_INITIAL)) {
    $dialog.SelectedPath = $env:PC_LABEL_INITIAL
}
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-4000, -4000)
$form.Size = New-Object System.Drawing.Size(1, 1)
$form.ShowInTaskbar = $false
$form.Show()
$form.Activate()
$result = $dialog.ShowDialog($form)
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    Write-Output $dialog.SelectedPath
}
"""
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ],
            capture_output=True,
            timeout=600,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (completed.stdout or b"").decode("utf-8", errors="ignore").strip()
    if not text:
        text = (completed.stdout or b"").decode("mbcs", errors="ignore").strip()
    return text or None


def _choose_directory_tk(title: str, initial: str | None = None) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    kwargs = {"title": title}
    if initial and Path(initial).is_dir():
        kwargs["initialdir"] = initial
    try:
        try:
            selected = filedialog.askdirectory(mustexist=True, **kwargs)
        except TypeError:
            selected = filedialog.askdirectory(**kwargs)
    finally:
        root.destroy()
    return selected or None


def _choose_directory(title: str, initial: str | None = None) -> str | None:
    if sys.platform == "win32":
        selected = _choose_directory_winforms(title, initial)
        if selected:
            return selected
    return _choose_directory_tk(title, initial)


def _unique_export_dir(parent: Path, suggest: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = _safe_export_name(suggest) or "labeled"
    dest = parent / f"{base}_{stamp}"
    n = 2
    while dest.exists():
        dest = parent / f"{base}_{stamp}_{n}"
        n += 1
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def _candidate_files(root: Path, rel: str) -> list[Path]:
    text = str(rel or "").replace("\\", "/").lstrip("/")
    if not text:
        return []
    parts = Path(text).parts
    opts = [root / text]
    if len(parts) > 1:
        opts.append(root / Path(*parts[1:]))
    opts.append(root / Path(text).name)
    return opts


def _file_under_root(root: Path, rel: str) -> Path | None:
    seen: set[str] = set()
    for opt in _candidate_files(root, rel):
        key = str(opt).lower()
        if key in seen:
            continue
        seen.add(key)
        if opt.is_file():
            return opt
    return None


def _common_folder(paths: list[Path]) -> Path | None:
    files = [path.resolve() for path in paths if path.is_file()]
    if not files:
        return None
    common = files[0].parent
    for path in files[1:]:
        other = path.parent
        while True:
            try:
                other.relative_to(common)
                break
            except ValueError:
                parent = common.parent
                if parent == common:
                    return None
                common = parent
    return common


def _expand_locate_hints(hints: list[str], relatives: list[str]) -> list[Path]:
    first = Path(str(relatives[0]).replace("\\", "/")).parts[0] if relatives else ""
    out: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        if not path.is_dir():
            return
        key = str(path.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        out.append(path)

    for hint in hints:
        text = str(hint or "").strip()
        if not text:
            continue
        path = Path(text).expanduser()
        if path.is_file():
            path = path.parent
        add(path)
        add(path.parent)
        if first:
            add(path / first)
            add(path.parent / first)
    return out


def _match_folder(root: Path, relatives: list[str], sizes: list[int] | None = None) -> list[dict] | None:
    files = []
    for index, rel in enumerate(relatives):
        found = _file_under_root(root, rel)
        if found is None:
            return None
        if sizes and index < len(sizes):
            try:
                expected = int(sizes[index])
            except (TypeError, ValueError):
                expected = -1
            if expected >= 0 and found.stat().st_size != expected:
                return None
        files.append(
            {
                "relative": rel,
                "id": str(found),
                "relativePath": str(found.relative_to(root)).replace("\\", "/"),
            }
        )
    return files


@app.post("/api/pick_folder")
def pick_folder() -> dict:
    selected = _choose_directory("选择点云文件夹")
    if not selected:
        raise HTTPException(status_code=400, detail="未选择文件夹")
    return {"path": selected}


@app.post("/api/locate_folder")
async def locate_folder(request: Request) -> dict:
    payload = await request.json()
    relatives = [str(item).replace("\\", "/") for item in (payload.get("relativePaths") or []) if item]
    hints = [str(item) for item in (payload.get("hints") or []) if item]
    sizes = payload.get("sizes") or []
    if not relatives:
        raise HTTPException(status_code=400, detail="没有可定位的点云路径")
    for candidate in _expand_locate_hints(hints, relatives):
        files = _match_folder(candidate, relatives, sizes)
        if not files:
            continue
        found_paths = [Path(item["id"]) for item in files]
        common = _common_folder(found_paths) or candidate
        return {
            "root": str(common.resolve()),
            "files": [
                {
                    "relative": item["relative"],
                    "id": item["id"],
                    "relativePath": str(Path(item["id"]).relative_to(common)).replace("\\", "/"),
                }
                for item in files
            ],
        }
    raise HTTPException(status_code=404, detail="无法定位打开文件所在的文件夹")


@app.post("/api/prepare_export_dir")
def prepare_export_dir(
    suggest: str = Query(""),
    initial: str = Query(""),
) -> dict:
    original = Path(initial).expanduser() if initial else None
    if original and original.is_file():
        original = original.parent
    start = original if original and original.is_dir() else EXPORT_DIR
    selected = _choose_directory(
        "另存为：选择保存位置（可新建文件夹）",
        str(start),
    )
    if not selected:
        raise HTTPException(status_code=400, detail="已取消另存为")
    dest = Path(selected).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail="未选择导出文件夹")
    return {
        "path": str(dest.resolve()),
        "original": str(original.resolve()) if original and original.is_dir() else None,
    }


def _norm_path_key(value: str) -> str:
    text = str(value or "").strip().replace("/", "\\")
    while "\\\\" in text:
        text = text.replace("\\\\", "\\")
    return text.rstrip("\\").lower()


def _safe_export_name(name: str) -> str:
    safe = re.sub(r"[^\w\u4e00-\u9fff\-]+", "_", name).strip("_")
    return safe or "labels"


def instance_to_leaf_maps(payload: dict) -> dict[str, dict[int, int]]:
    """cloud_id -> {original inst_class -> leaf_id}."""
    by_cloud: dict[str, dict[int, int]] = {}
    labels = payload.get("labels") or {}
    for leaf in labels.get("leaves") or []:
        try:
            leaf_id = int(leaf.get("id"))
        except (TypeError, ValueError):
            continue
        assignments = leaf.get("assignments") or {}
        for cloud_id, instance_id in assignments.items():
            if instance_id is None:
                continue
            try:
                inst = int(instance_id)
            except (TypeError, ValueError):
                continue
            key = str(cloud_id)
            by_cloud.setdefault(key, {})[inst] = leaf_id
            by_cloud.setdefault(_norm_path_key(key), {})[inst] = leaf_id
    return by_cloud


def remap_ascii_file(src: Path, dest: Path, inst_to_leaf: dict[int, int]) -> int:
    """原样保留各列，在末尾写入 leaf_id；同一叶片跨文件同一号，未对应为 0。可安全覆盖源文件。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".leaf_tmp")
    labeled_points = 0
    header_note = "// leaf_id 为跨文件统一叶片号，未对应实例为 0"
    wrote_note = False
    try:
        with src.open("r", encoding="utf-8", errors="ignore") as fin, tmp.open(
            "w", encoding="utf-8", newline="\n"
        ) as fout:
            for line in fin:
                stripped = line.rstrip("\r\n")
                compact = stripped.strip()
                if not compact:
                    fout.write("\n" if line.endswith("\n") else line)
                    continue
                lower = compact.lower()
                is_meta = compact[0] in "#/" or lower.startswith(
                    ("ply", "format", "comment", "element", "property", "end_header", "version")
                )
                if is_meta:
                    if compact.startswith("// leaf_id"):
                        if not wrote_note:
                            fout.write(header_note + "\n")
                            wrote_note = True
                        continue
                    if not wrote_note:
                        fout.write(header_note + "\n")
                        wrote_note = True
                    if "leaf_id" not in lower and (
                        "inst_class" in lower or compact.startswith("//x") or compact.startswith("#x")
                    ):
                        stripped = f"{stripped} leaf_id"
                    fout.write(stripped + "\n")
                    continue
                if not wrote_note:
                    fout.write(header_note + "\n")
                    wrote_note = True
                parts = compact.split()
                leaf_id = 0
                if len(parts) >= 4:
                    try:
                        old = int(float(parts[3]))
                        leaf_id = int(inst_to_leaf.get(old, 0))
                    except ValueError:
                        leaf_id = 0
                if leaf_id:
                    labeled_points += 1
                if len(parts) >= 14:
                    parts[-1] = str(leaf_id)
                    fout.write(" ".join(parts) + "\n")
                else:
                    fout.write(f"{stripped} {leaf_id}\n")
        os.replace(tmp, dest)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise
    return labeled_points


def _resolve_cloud_src(item: dict, out_root: Path | None) -> Path | None:
    cloud_id = str(item.get("id") or "")
    src = Path(cloud_id).expanduser()
    if src.is_file():
        return src
    rel = str(item.get("relativePath") or src.name).replace("\\", "/").lstrip("/")
    if out_root and out_root.is_dir():
        found = _file_under_root(out_root, rel) or _file_under_root(out_root, src.name)
        if found is not None:
            return found
    return None


def backup_original_clouds(payload: dict, out_root: Path) -> tuple[str | None, list[str]]:
    """覆盖写入前，把将要被改动的 txt / json 拷到 backup_时间戳。"""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_root = out_root / f"backup_{stamp}"
    errors: list[str] = []
    copied = 0
    for item in payload.get("clouds") or []:
        src = _resolve_cloud_src(item, out_root)
        if src is None:
            continue
        try:
            dest = out_root / src.relative_to(out_root)
        except ValueError:
            relative = str(item.get("relativePath") or src.name).replace("\\", "/").lstrip("/")
            dest = out_root / Path(relative).name
        overwrite_src = dest.exists() or dest.resolve() == src.resolve()
        if not overwrite_src:
            continue
        source = dest if dest.is_file() else src
        try:
            rel = source.relative_to(out_root)
        except ValueError:
            rel = Path(source.name)
        bak = backup_root / rel
        try:
            bak.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, bak)
            copied += 1
        except OSError as exc:
            errors.append(f"备份失败 {source.name}: {exc}")
    json_path = out_root / "leaf_labels.json"
    if json_path.is_file():
        try:
            backup_root.mkdir(parents=True, exist_ok=True)
            shutil.copy2(json_path, backup_root / "leaf_labels.json")
        except OSError as exc:
            errors.append(f"备份 json 失败: {exc}")
    if copied == 0 and not (backup_root / "leaf_labels.json").is_file():
        return None, errors
    return str(backup_root.resolve()), errors


def export_remapped_clouds(payload: dict, out_root: Path) -> tuple[list[str], list[str]]:
    maps = instance_to_leaf_maps(payload)
    exported: list[str] = []
    errors: list[str] = []
    clouds = payload.get("clouds") or []
    for item in clouds:
        cloud_id = str(item.get("id") or "")
        src = _resolve_cloud_src(item, out_root)
        if src is None:
            errors.append(f"找不到源文件：{cloud_id}")
            continue
        try:
            dest = out_root / src.relative_to(out_root)
        except ValueError:
            relative = str(item.get("relativePath") or src.name).replace("\\", "/").lstrip("/")
            dest = out_root / Path(relative).name
        mapping = maps.get(cloud_id) or maps.get(_norm_path_key(cloud_id)) or maps.get(_norm_path_key(str(src))) or {}
        try:
            remap_ascii_file(src, dest, mapping)
            exported.append(str(dest))
        except OSError as exc:
            errors.append(f"{src.name}: {exc}")
    return exported, errors


@app.post("/api/save_labels")
async def save_labels(request: Request) -> dict:
    payload = await request.json()
    name = str(payload.get("name") or "labels")
    folder = payload.get("folder")
    folder_name = Path(str(folder)).name if folder else ""
    safe_name = _safe_export_name(folder_name or name)
    mode = str(payload.get("mode") or "")
    original = Path(str(folder)).expanduser() if folder else None
    if original and original.is_file():
        original = original.parent
    if original is None or not original.is_dir():
        inferred = _common_folder(
            [Path(str(item.get("id") or "")).expanduser() for item in (payload.get("clouds") or [])]
        )
        if inferred is not None:
            original = inferred
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    saved: list[str] = []
    requested = str(payload.get("exportDir") or "").strip()
    if mode == "save" or (not requested and original and original.is_dir()):
        if not original or not original.is_dir():
            raise HTTPException(status_code=400, detail="无法确定打开文件所在的原文件夹")
        out_root = original
    elif requested:
        out_root = Path(requested).expanduser()
        out_root.mkdir(parents=True, exist_ok=True)
    else:
        raise HTTPException(status_code=400, detail="请选择保存位置")
    from starlette.concurrency import run_in_threadpool

    backup_dir = None
    backup_errors: list[str] = []
    if mode != "saveas":
        backup_dir, backup_errors = await run_in_threadpool(backup_original_clouds, payload, out_root)
    export_json = out_root / "leaf_labels.json"
    export_json.write_text(text, encoding="utf-8")
    saved.append(str(export_json))

    exported, errors = await run_in_threadpool(export_remapped_clouds, payload, out_root)
    return {
        "saved": saved,
        "exported": exported,
        "exportDir": str(out_root),
        "backupDir": backup_dir,
        "errors": [*backup_errors, *errors],
    }


@app.post("/api/shutdown")
def shutdown() -> dict:
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True}


def main() -> None:
    port = 8765
    threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
