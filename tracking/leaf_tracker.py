"""
叶片时序追踪器（改进版）。

输入：按日期组织的实例分割点云（每帧一个 .txt，表头给出列名，至少含
x y z inst_class sem_class），输出：同格式点云，inst_class 替换为跨帧统一的轨迹 ID，
可直接用 eval_temporal.py 对照人工标注评估。

相对 Lajiao_zhuizong/proto_track.py 的改动（针对 GT 评估暴露的问题）：
  1. 匹配代价不再只看叶基点距离——所有叶子都长在茎上，基点彼此只差 1-2 cm，
     与两帧间的位移同量级，极易串号。现在的代价 = 配准后叶片点云重叠度
     + 质心/基点位移 + 长度收缩惩罚，三者互补。
  2. 门限随时间间隔 Δt（天）放宽，9 天间隔不再整批判成新叶。
  3. 轨迹带记忆：某帧没配上的轨迹进入“休眠”，后续帧仍可被重新认领，
     不再一断即换新号。
  4. 碎片吸收：被过分割成两块的叶子，小块若几乎完全落在已匹配叶片的点云内，
     沿用同一轨迹号，而不是各自领新号。
  5. 可选的整体运动预测：用高置信匹配拟合随高度变化的位移场，再对剩余
     叶片做二次匹配（顶端幼叶随茎伸长整体上移的情形）。

配准（逐帧对前一帧的绕 Z 轴刚性 ICP）、茎中轴线、叶基点等沿用原型实现。
"""
from __future__ import annotations

import argparse
import colorsys
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree

CANON_COLS = ["x", "y", "z", "r", "g", "b", "inst_class", "sem_class",
              "inst_prob", "sem_prob", "nx", "ny", "nz"]
N_COLS = len(CANON_COLS)
C_XYZ = slice(0, 3)
C_RGB = slice(3, 6)
C_INST = 6
C_SEM = 7
C_NRM = slice(10, 13)
STEM_SEM = 0
LEAF_SEM = 1
STEM_TRACK = 0
INF = 1e9


class AnomalousFrame(Exception):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# IO
# --------------------------------------------------------------------------- #
def date_of(path: str) -> str:
    return os.path.basename(path)[:8]


def list_frames(data_dir: str) -> list[str]:
    files = glob.glob(os.path.join(data_dir, "*.txt"))
    files += glob.glob(os.path.join(data_dir, "*", "*.txt"))
    files = [f for f in files if not f.endswith(".bak")
             and not os.path.basename(os.path.dirname(f)).startswith(("backup", "."))
             and date_of(f).isdigit()]
    return sorted(set(files), key=os.path.basename)


def read_header(path: str) -> list[str]:
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            s = line.strip()
            if not s:
                continue
            if s.startswith(("//", "#")):
                names = s.lstrip("/#").split()
                if len(names) >= 5 and any(n.lower() in ("x", "inst_class") for n in names):
                    return [n.lower() for n in names]
                continue
            break
    raise ValueError(f"{os.path.basename(path)}: 找不到列名表头")


def read_table(path: str) -> np.ndarray:
    """按表头列名读取，返回 CANON_COLS 顺序的 (N,13) 数组；缺失的列填 0。"""
    names = read_header(path)
    missing = [c for c in ("x", "y", "z", "inst_class", "sem_class") if c not in names]
    if missing:
        raise ValueError(f"{os.path.basename(path)}: 缺少列 {missing}: {names}")
    try:
        import pandas as pd
        df = pd.read_csv(path, sep=r"\s+", comment="/", header=None, names=names,
                         engine="c", dtype=float, on_bad_lines="skip")
        d = df.to_numpy(float)
    except Exception:
        rows = []
        with open(path) as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == len(names) and not line.lstrip().startswith(("//", "#")):
                    rows.append(parts)
        d = np.asarray(rows, dtype=float)
    d = d[~np.isnan(d[:, [names.index(c) for c in ("x", "y", "z", "inst_class", "sem_class")]]).any(1)]
    out = np.zeros((len(d), N_COLS), dtype=float)
    for k, c in enumerate(CANON_COLS):
        if c in names:
            out[:, k] = d[:, names.index(c)]
    return out


def file_key(path: str) -> str:
    st = os.stat(path)
    return hashlib.md5(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:16]


def load_table_cached(path: str, cache_dir: str | None) -> np.ndarray:
    if not cache_dir:
        return read_table(path)
    os.makedirs(cache_dir, exist_ok=True)
    cp = os.path.join(cache_dir, f"tab_{file_key(path)}.npy")
    if os.path.exists(cp):
        return np.load(cp)
    d = read_table(path)
    np.save(cp, d)
    return d


# --------------------------------------------------------------------------- #
# 茎清理 / 中轴线（沿用原型）
# --------------------------------------------------------------------------- #
def clean_stem(xyz, sem, voxel=4.0, keep_frac=0.10, max_gap=30.0):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    idx = np.flatnonzero(sem == STEM_SEM)
    if len(idx) < 100:
        return sem, 0
    p = xyz[idx]
    keys = np.floor(p / voxel).astype(np.int64)
    uk, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.ravel()
    centers = (uk + 0.5) * voxel
    pairs = cKDTree(centers).query_pairs(voxel * 1.8, output_type="ndarray")
    n = len(centers)
    A = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, lab = connected_components(A, directed=False)
    plab = lab[inv]
    sizes = np.bincount(plab)
    main = np.argmax(sizes)
    dist_main, _ = cKDTree(centers[lab == main]).query(centers, k=1)
    comp_gap = np.full(len(sizes), np.inf)
    np.minimum.at(comp_gap, lab, dist_main)
    keep_comp = (sizes >= keep_frac * len(idx)) | (comp_gap <= max_gap)
    good = keep_comp[plab]
    sem = sem.copy()
    sem[idx[~good]] = -1
    return sem, int((~good).sum())


def fit_centerline(stem_xyz, n_bins=60):
    z = stem_xyz[:, 2]
    edges = np.linspace(z.min(), z.max(), n_bins + 1)
    verts = []
    for i in range(n_bins):
        m = (z >= edges[i]) & (z <= edges[i + 1])
        if m.sum() >= 20:
            verts.append(stem_xyz[m].mean(0))
    verts = np.asarray(verts)
    if len(verts) < 2:
        verts = np.vstack([stem_xyz.min(0), stem_xyz.max(0)])
    return verts


def leaf_base(p, verts):
    d2 = ((p[:, None, :] - verts[None, :, :]) ** 2).sum(-1).min(1)
    k = max(5, int(0.05 * len(p)))
    idx = np.argpartition(d2, min(k, len(p) - 1))[:k]
    return p[idx].mean(0)


def leaf_length(p):
    q = p - p.mean(0)
    _, vec = np.linalg.eigh(q.T @ q)
    proj = q @ vec[:, -1]
    return float(proj.max() - proj.min())


def voxel_down(p, v):
    keys = np.floor(p / v).astype(np.int64)
    _, idx = np.unique(keys, axis=0, return_index=True)
    return p[idx]


# --------------------------------------------------------------------------- #
# 刚性配准（绕 Z 轴 + 平移，trimmed ICP，沿用原型）
# --------------------------------------------------------------------------- #
def _kabsch_yaw(A, B):
    ca, cb = A.mean(0), B.mean(0)
    a, b = A - ca, B - cb
    s = np.sum(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])
    c = np.sum(a[:, 0] * b[:, 0] + a[:, 1] * b[:, 1])
    th = np.arctan2(s, c)
    ct, st = np.cos(th), np.sin(th)
    R = np.array([[ct, -st, 0.0], [st, ct, 0.0], [0.0, 0.0, 1.0]])
    return R, cb - R @ ca


def register_rigid(src, dst, voxel=2.0, trim=0.6, max_iter=60, tol=1e-4):
    S, D = voxel_down(src, voxel), voxel_down(dst, voxel)
    tree = cKDTree(D)
    R_tot, t_tot = np.eye(3), np.zeros(3)
    cur = S.copy()
    d0, _ = tree.query(cur, k=1)
    rmse0 = float(np.sqrt(np.mean(d0[d0 <= np.quantile(d0, trim)] ** 2)))
    prev = None
    for _ in range(max_iter):
        dist, idx = tree.query(cur, k=1)
        m = dist <= np.quantile(dist, trim)
        R, t = _kabsch_yaw(cur[m], D[idx[m]])
        cur = (R @ cur.T).T + t
        R_tot = R @ R_tot
        t_tot = R @ t_tot + t
        err = float(np.sqrt(np.mean(dist[m] ** 2)))
        if prev is not None and abs(prev - err) < tol:
            break
        prev = err
    d1, _ = tree.query(cur, k=1)
    rmse1 = float(np.sqrt(np.mean(d1[d1 <= np.quantile(d1, trim)] ** 2)))
    return R_tot, t_tot, rmse0, rmse1


# --------------------------------------------------------------------------- #
# 帧与叶片描述
# --------------------------------------------------------------------------- #
def load_frame(path, cache_dir=None):
    try:
        d = load_table_cached(path, cache_dir)
    except ValueError as e:
        raise AnomalousFrame(str(e))
    xyz = d[:, C_XYZ]
    inst = d[:, C_INST].astype(int)
    sem = d[:, C_SEM].astype(int)
    sem, n_dropped = clean_stem(xyz, sem)
    n_inst = len(np.unique(inst))
    stem_frac = float(np.mean(sem == STEM_SEM))
    extent = float(np.linalg.norm(xyz.max(0) - xyz.min(0)))
    reasons = []
    if n_inst < 3:
        reasons.append(f"只有 {n_inst} 个实例")
    if stem_frac > 0.9:
        reasons.append(f"茎占 {stem_frac:.0%}")
    if extent < 5.0:
        reasons.append(f"包围盒对角线 {extent:.3f}，尺度异常")
    if reasons:
        raise AnomalousFrame(f"{date_of(path)}: " + "; ".join(reasons))
    return dict(date=date_of(path), path=path, xyz=xyz, inst=inst, sem=sem,
                nrm=d[:, C_NRM], raw=d, n_stem_dropped=n_dropped)


def apply_transform(frame, R, t):
    frame["xyz"] = (R @ frame["xyz"].T).T + t
    frame["nrm"] = (R @ frame["nrm"].T).T
    frame["raw"][:, C_XYZ] = frame["xyz"]
    frame["raw"][:, C_NRM] = frame["nrm"]


def describe_leaves(frame, verts, min_pts=30, ds_voxel=3.0):
    xyz, inst, sem = frame["xyz"], frame["inst"], frame["sem"]
    leaves = {}
    leaf_mask = sem == LEAF_SEM
    for iid in np.unique(inst[leaf_mask]):
        m = leaf_mask & (inst == iid)
        p = xyz[m]
        if len(p) < min_pts:
            continue
        ds = voxel_down(p, ds_voxel)
        leaves[int(iid)] = dict(
            iid=int(iid), npts=int(len(p)), centroid=p.mean(0), base=leaf_base(p, verts),
            length=leaf_length(p), pts=ds, tree=cKDTree(ds), pts_full=p,
        )
    return leaves


def coverage(pa, tree_a, b, rho):
    """a 的点落在 b 附近的比例、b 的点落在 a 附近的比例。"""
    da, _ = b["tree"].query(pa, k=1)
    db, _ = tree_a.query(b["pts"], k=1)
    return float(np.mean(da < rho)), float(np.mean(db < rho))


# --------------------------------------------------------------------------- #
# 匹配
# --------------------------------------------------------------------------- #
DEFAULT_PARAMS = dict(
    gate_xy=25.0,      # 基点水平位移门限（mm，Δt=基准间隔时）
    gate_z=55.0,       # 基点竖直位移门限
    gate_cent=45.0,    # 质心位移门限
    dt_ref=3.0,        # 门限按 max(1, Δt/dt_ref)^dt_pow 放宽
    dt_pow=0.7,
    shrink=0.7,        # 长度比 < shrink 禁止匹配（叶子不会明显缩小）
    w_shrink=6.0,
    rho=6.0,           # 重叠判定半径（mm）
    rho_len=0.12,      # 半径再加 rho_len × 叶长（幼叶/长叶更宽松）
    w_ov=1.0,          # 代价权重：重叠度
    w_base=0.6,        # 基点位移（归一化到门限）
    w_cent=0.6,        # 质心位移（归一化到门限）
    min_ov=0.25,       # 位移超门限时，重叠度 ≥ min_ov 仍可匹配
    c_null=1.3,        # “宁可不配”的代价：高于此的配对放弃（避免级联串号）
    keep_frames=3,     # 休眠轨迹保留帧数
    w_dormant=0.25,    # 每休眠一帧的额外代价
    absorb_cov=0.9,    # 碎片吸收：未匹配实例 ≥ 该比例点落在已匹配叶片 absorb_rho 邻域内
    absorb_rho=4.0,    # 碎片判定半径（mm，贴着叶面才算）
    absorb_mix=0.3,    # 碎片点邻域内宿主点比例中位数 ≥ 此值才算“同一叶面交错”，否则是贴着的幼叶
    absorb_max_frac=0.5,  # 且点数不超过宿主的该比例
    predict=True,      # 用高置信匹配拟合位移场后二次匹配
    conf_ov=0.6,
    min_pts=30,
)


def _pair_costs(cands, leaves_b, P, dt_days, shifts=None):
    """返回 cost, forbidden, 以及诊断量。cands: [(track_id, desc, dormant_frames, dt_days_i)]"""
    ida = list(range(len(cands)))
    idb = list(leaves_b)
    nA, nB = len(ida), len(idb)
    cost = np.full((nA, nB), INF)
    ov_mat = np.zeros((nA, nB))
    if nA == 0 or nB == 0:
        return cost, ov_mat, idb
    Bc = np.array([leaves_b[j]["centroid"] for j in idb])
    Bb = np.array([leaves_b[j]["base"] for j in idb])
    Bl = np.array([leaves_b[j]["length"] for j in idb])
    for i, (tid, a, dormant, dti) in enumerate(cands):
        s = max(1.0, dti / P["dt_ref"]) ** P["dt_pow"]
        gxy, gz, gc = P["gate_xy"] * s, P["gate_z"] * s, P["gate_cent"] * s
        shift = None if shifts is None else shifts[i]
        a_cent = a["centroid"] + (0 if shift is None else shift)
        a_base = a["base"] + (0 if shift is None else shift)
        pa = a["pts"] if shift is None else a["pts"] + shift
        tree_a = a["tree"] if shift is None else cKDTree(pa)
        dxy = np.linalg.norm(Bb[:, :2] - a_base[:2], axis=1)
        dz = np.abs(Bb[:, 2] - a_base[2])
        dcent = np.linalg.norm(Bc - a_cent, axis=1)
        ratio = Bl / (a["length"] + 1e-6)
        base_n = np.sqrt((dxy / gxy) ** 2 + (dz / gz) ** 2)
        cent_n = dcent / gc
        # 只对几何上还说得过去的候选算重叠度（省时间）
        plausible = (base_n < 2.5) | (cent_n < 2.5)
        for jj in np.flatnonzero(plausible):
            b = leaves_b[idb[jj]]
            rho = P["rho"] + P["rho_len"] * min(a["length"], b["length"])
            ca, cb = coverage(pa, tree_a, b, rho)
            ov_mat[i, jj] = max(ca, cb)
        shrink_pen = P["w_shrink"] * np.maximum(0.0, -np.log(ratio + 1e-6))
        c = (P["w_ov"] * (1.0 - ov_mat[i]) + P["w_base"] * base_n + P["w_cent"] * cent_n
             + shrink_pen + P["w_dormant"] * dormant)
        forbidden = (ratio < P["shrink"]) \
            | (((base_n > 1.0) & (cent_n > 1.0)) & (ov_mat[i] < P["min_ov"])) \
            | (~plausible)
        cost[i] = np.where(forbidden, INF, c)
    return cost, ov_mat, idb


def _solve(cost, c_null):
    """带“不匹配”选项的匈牙利分配。

    直接在含 INF 的矩阵上做 linear_sum_assignment 会让某一行被迫接受很差的配对，
    并连带挤走别人的正确配对（级联串号）。这里给每行/每列补一个代价为 c_null 的
    虚拟对手：代价高于 c_null 的配对宁可放弃。
    """
    nA, nB = cost.shape
    if nA == 0 or nB == 0:
        return []
    big = np.full((nA + nB, nA + nB), c_null, dtype=float)
    big[:nA, :nB] = cost
    big[nA:, nB:] = 0.0
    r, c = linear_sum_assignment(big)
    return [(i, j) for i, j in zip(r, c) if i < nA and j < nB and cost[i, j] < INF]


def _fit_shift_field(cands, leaves_b, pairs, idb):
    """位移 = f(z)：用置信匹配的质心位移做一阶最小二乘（截距 + 随高度变化）。"""
    if len(pairs) < 3:
        return None
    Z = np.array([cands[i][1]["centroid"][2] for i, _ in pairs])
    Dm = np.array([leaves_b[idb[j]]["centroid"] - cands[i][1]["centroid"] for i, j in pairs])
    X = np.column_stack([np.ones_like(Z), Z])
    coef, *_ = np.linalg.lstsq(X, Dm, rcond=None)
    resid = Dm - X @ coef
    if len(pairs) < 5 or np.median(np.linalg.norm(resid, axis=1)) > 15.0:
        # 数据太少或拟合不稳：退化为常数位移（中位数）
        med = np.median(Dm, axis=0)
        return lambda z: np.broadcast_to(med, (len(np.atleast_1d(z)), 3))
    return lambda z: np.column_stack([np.ones(len(np.atleast_1d(z))), np.atleast_1d(z)]) @ coef


def match_frame(cands, leaves_b, P, dt_days):
    """cands: 活跃 + 休眠轨迹；返回 {inst_b: track_id}, 未匹配实例列表, 已匹配轨迹集合, 诊断"""
    cost, ov, idb = _pair_costs(cands, leaves_b, P, dt_days)
    pairs = _solve(cost, P["c_null"])
    diag = dict(n_pass1=len(pairs), predicted=False)
    if P["predict"] and pairs:
        conf = [(i, j) for i, j in pairs if ov[i, j] >= P["conf_ov"] and cands[i][2] == 0]
        field = _fit_shift_field(cands, leaves_b, conf, idb)
        if field is not None:
            Z = np.array([c[1]["centroid"][2] for c in cands])
            shifts = np.asarray(field(Z))
            cost2, ov2, _ = _pair_costs(cands, leaves_b, P, dt_days, shifts=shifts)
            # 置信匹配保持不动（代价设 0，同时禁止它们与别的候选配对）
            for i, j in conf:
                cost2[i, :] = INF
                cost2[:, j] = INF
                cost2[i, j] = 0.0
            pairs2 = _solve(cost2, P["c_null"])
            if len(pairs2) >= len(pairs):
                pairs, ov, diag["predicted"] = pairs2, ov2, True
    assign = {idb[j]: cands[i][0] for i, j in pairs}
    matched_tracks = {cands[i][0] for i, _ in pairs}
    unmatched_b = [idb[j] for j in range(len(idb)) if idb[j] not in assign]
    diag["ov"] = {idb[j]: float(ov[i, j]) for i, j in pairs}
    return assign, unmatched_b, matched_tracks, diag


def _mixing_ratio(frag_pts, host_pts, r, n_sample=2000, seed=0):
    """碎片点邻域里宿主点所占比例的中位数。

    同一叶面被分割成两种标签时，两者的点在整片区域内交错（比例高且处处如此）；
    而紧贴着的另一片幼叶只在接触边缘才有宿主点（中位数低）。"""
    if len(frag_pts) > n_sample:
        frag_pts = frag_pts[np.random.default_rng(seed).choice(len(frag_pts), n_sample, replace=False)]
    n_h = np.array([len(x) for x in cKDTree(host_pts).query_ball_point(frag_pts, r)])
    n_f = np.array([len(x) for x in cKDTree(frag_pts).query_ball_point(frag_pts, r)]) - 1
    return float(np.median(n_h / np.maximum(n_h + n_f, 1)))


def absorb_fragments(assign, unmatched_b, leaves_b, P):
    """未匹配的小实例若与某已匹配叶片在同一叶面上交错分布，视为同一叶片的碎片。"""
    absorbed = {}
    hosts = [(j, leaves_b[j]) for j in assign]
    for u in list(unmatched_b):
        fu = leaves_b[u]
        best, best_cov = None, 0.0
        for j, host in hosts:
            if fu["npts"] > P["absorb_max_frac"] * host["npts"]:
                continue
            d, _ = host["tree"].query(fu["pts"], k=1)
            cov = float(np.mean(d < P["absorb_rho"]))
            if cov > best_cov:
                best, best_cov = j, cov
        if best is None or best_cov < P["absorb_cov"]:
            continue
        host = leaves_b[best]
        if "pts_full" in fu and "pts_full" in host:
            mix = _mixing_ratio(fu["pts_full"], host["pts_full"], P["absorb_rho"])
            if mix < P["absorb_mix"]:
                continue
        absorbed[u] = assign[best]
    for u, tid in absorbed.items():
        assign[u] = tid
        unmatched_b.remove(u)
    return absorbed


# --------------------------------------------------------------------------- #
# 导出
# --------------------------------------------------------------------------- #
def color_from_id(tid):
    if tid == STEM_TRACK:
        return (120, 120, 120)
    h = (tid * 0.6180339887) % 1.0
    s = 0.55 + 0.35 * ((tid % 3) / 2.0)
    v = 0.75 + 0.25 * (tid % 2)
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def export_frame(frame, inst2track, next_id, out_path, recolor=True):
    raw = frame["raw"].copy()
    inst, sem = frame["inst"], frame["sem"]
    track = np.zeros(len(raw), dtype=int)
    leaf_mask = sem == LEAF_SEM
    for iid in np.unique(inst[leaf_mask]):
        tid = inst2track.get(int(iid))
        if tid is None:
            tid = next_id
            next_id += 1
        track[leaf_mask & (inst == iid)] = tid
    if recolor:
        for tid in np.unique(track):
            raw[track == tid, C_RGB] = color_from_id(int(tid))
    raw[:, C_INST] = track
    fmt = ["%.6f"] * 3 + ["%d"] * 3 + ["%d", "%d"] + ["%.4f", "%.4f"] + ["%.6f"] * 3
    header = "//x y z r g b inst_class sem_class inst_prob sem_prob nx ny nz"
    np.savetxt(out_path, raw, fmt=fmt, header=header, comments="")
    return next_id


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def days_between(d0: str, d1: str) -> float:
    from datetime import date
    a = date(int(d0[:4]), int(d0[4:6]), int(d0[6:8]))
    b = date(int(d1[:4]), int(d1[4:6]), int(d1[6:8]))
    return float((b - a).days)


def run_sequence(files, out_dir, P, cache_dir=None, recolor=True):
    os.makedirs(out_dir, exist_ok=True)
    tracks = {}          # tid -> dict(desc, last_date, last_idx, dormant)
    next_global = 1
    prev_frame = None
    frame_idx = 0
    summary = []
    for path in files:
        t0 = time.time()
        date = date_of(path)
        try:
            f = load_frame(path, cache_dir)
        except AnomalousFrame as e:
            log(f"[SKIP] {e}")
            summary.append(dict(date=date, skipped=True))
            continue
        if prev_frame is not None:
            reg = _cached_registration(f, prev_frame, cache_dir)
            R, t, r0, r1 = reg
            apply_transform(f, R, t)
        verts = fit_centerline(f["xyz"][f["sem"] == STEM_SEM])
        leaves = describe_leaves(f, verts, min_pts=P["min_pts"])
        i2t = {}
        if prev_frame is None:
            for iid in leaves:
                i2t[iid] = next_global
                next_global += 1
            row = dict(date=date, leaves=len(leaves), matched=0, revived=0, births=len(leaves),
                       absorbed=0, deaths=0, dormant=0, rmse=None)
        else:
            cands = []
            for tid, tr in tracks.items():
                if tr["dormant"] > P["keep_frames"]:
                    continue
                cands.append((tid, tr["desc"], tr["dormant"], days_between(tr["last_date"], date)))
            dt = days_between(prev_frame["date"], date)
            assign, unmatched, matched_tracks, diag = match_frame(cands, leaves, P, dt)
            absorbed = absorb_fragments(assign, unmatched, leaves, P)
            revived = sum(1 for tid in matched_tracks if tracks[tid]["dormant"] > 0)
            for u in unmatched:
                assign[u] = next_global
                next_global += 1
            i2t = assign
            for tid in tracks:
                if tid not in matched_tracks:
                    tracks[tid]["dormant"] += 1
            deaths = sum(1 for tid, tr in tracks.items() if tr["dormant"] == 1)
            row = dict(date=date, leaves=len(leaves), matched=len(matched_tracks) - revived,
                       revived=revived, births=len(unmatched), absorbed=len(absorbed),
                       deaths=deaths, dormant=sum(1 for tr in tracks.values()
                                                  if 0 < tr["dormant"] <= P["keep_frames"]),
                       rmse=(r0, r1), predicted=diag["predicted"])
        # 更新轨迹状态（同一轨迹被多个实例共享时，用点最多的实例当描述子）
        best_for_tid = {}
        for iid, tid in i2t.items():
            if tid not in best_for_tid or leaves[iid]["npts"] > leaves[best_for_tid[tid]]["npts"]:
                best_for_tid[tid] = iid
        for tid, iid in best_for_tid.items():
            tracks[tid] = dict(desc=leaves[iid], last_date=date, last_idx=frame_idx, dormant=0)
        for L in leaves.values():
            L.pop("pts_full", None)  # 全量点只在碎片判定时用，不随轨迹长期保存
        out_path = os.path.join(out_dir, f"{date}_tracked.txt")
        next_global = export_frame(f, i2t, next_global, out_path, recolor=recolor)
        rm = "" if row["rmse"] is None else f"RMSE {row['rmse'][0]:5.2f}->{row['rmse'][1]:5.2f}  "
        log(f"{date}: {rm}leaves={row['leaves']:3d} matched={row['matched']:3d} "
            f"revived={row['revived']:2d} absorbed={row['absorbed']:2d} births={row['births']:3d} "
            f"deaths={row['deaths']:3d} dormant={row['dormant']:2d}  ({time.time() - t0:.1f}s)")
        summary.append(row)
        f.pop("raw", None)  # 释放大数组，配准只需要 xyz
        prev_frame = f
        frame_idx += 1
    log(f"\n轨迹总数 {next_global - 1}，输出 {sum(1 for r in summary if not r.get('skipped'))} 帧到 {out_dir}")
    with open(os.path.join(out_dir, "tracking_log.json"), "w", encoding="utf-8") as fh:
        json.dump(dict(params=P, frames=summary), fh, ensure_ascii=False, indent=1, default=str)
    return summary


def _cached_registration(f, prev, cache_dir):
    if cache_dir:
        cp = os.path.join(cache_dir, f"reg_{file_key(prev['path'])}_{file_key(f['path'])}.npz")
        if os.path.exists(cp):
            z = np.load(cp)
            return z["R"], z["t"], float(z["r0"]), float(z["r1"])
    R, t, r0, r1 = register_rigid(f["xyz"], prev["xyz"])
    if cache_dir:
        np.savez(cp, R=R, t=t, r0=r0, r1=r1)
    return R, t, r0, r1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir", help="输入目录：*.txt 平铺或按日期子目录，文件名以 YYYYMMDD 开头")
    ap.add_argument("-o", "--out_dir", default=None, help="输出目录（默认 <data_dir>-tracked）")
    ap.add_argument("--cache", default=None, help="解析/配准缓存目录（反复调参时大幅加速）")
    ap.add_argument("--no_recolor", action="store_true", help="保留原 RGB，不按轨迹着色")
    ap.add_argument("--legacy", action="store_true",
                    help="退化为原型算法（只用基点+长度、无记忆、无重叠度），用于对照")
    for k, v in DEFAULT_PARAMS.items():
        if isinstance(v, bool):
            ap.add_argument(f"--{k}", type=lambda s: s.lower() in ("1", "true", "yes"), default=v)
        else:
            ap.add_argument(f"--{k}", type=type(v), default=v)
    args = ap.parse_args(argv)
    P = {k: getattr(args, k) for k in DEFAULT_PARAMS}
    if args.legacy:
        P.update(w_ov=0.0, w_cent=0.0, min_ov=2.0, keep_frames=0, absorb_cov=2.0, predict=False,
                 dt_pow=0.0, rho_len=0.0)
    data_dir = os.path.abspath(args.data_dir.rstrip(os.sep))
    out_dir = os.path.abspath(args.out_dir or data_dir + "-tracked")
    files = list_frames(data_dir)
    if not files:
        sys.exit(f"{data_dir} 下没有 .txt 帧")
    log(f"[输入] {data_dir}  {len(files)} 帧: {date_of(files[0])} .. {date_of(files[-1])}")
    log(f"[输出] {out_dir}")
    log("[参数] " + ", ".join(f"{k}={v}" for k, v in P.items()))
    run_sequence(files, out_dir, P, cache_dir=args.cache, recolor=not args.no_recolor)


if __name__ == "__main__":
    main()
