"""Publication-grade evaluation of multi-temporal leaf identity.

Primary paper metrics
---------------------
HOTA / DetA / AssA (Luiten et al., 2021) over point-set IoU thresholds.
IDF1 (Ristani et al., 2016) at IoU = 0.5.
AssocAcc@0.5: adjacent-scan association after per-scan Hungarian matching.
IDSW, split rate, merge rate, panoptic quality, global vs frame mIoU.

Association does not require predicted IDs to equal ground-truth IDs.
Unmatched leaves (including the loser of a merge) count as association failures.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np

DATE_RE = re.compile(r"(20\d{6})")
POINT_EXTS = {".txt", ".xyz"}
ALPHAS = tuple(round(x, 2) for x in np.arange(0.05, 0.96, 0.05))
MATCH_ALPHA = 0.5
SPLIT_FRAC = 0.10


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def load_leaf_ids(path: Path) -> np.ndarray:
    values = np.loadtxt(
        path,
        comments="/",
        usecols=(-1,),
        dtype=np.float64,
        ndmin=1,
        encoding="utf-8",
    )
    return values.astype(np.int32, copy=False)


def _date_key(text: str) -> str:
    match = DATE_RE.search(str(text or ""))
    return match.group(1) if match else ""


def parse_yyyymmdd(text: str) -> date:
    return datetime.strptime(text, "%Y%m%d").date()


def _resolve_cloud(root: Path, item: dict) -> Path | None:
    rel = str(item.get("relativePath") or "").replace("\\", "/").lstrip("/")
    name = str(item.get("fileName") or Path(rel).name)
    candidates: list[Path] = []
    if rel:
        candidates.append(root / Path(*rel.split("/")))
    cloud_id = Path(str(item.get("id") or ""))
    if cloud_id.name:
        candidates.append(root / cloud_id.name)
        if len(cloud_id.parts) >= 2:
            candidates.append(root / cloud_id.parts[-2] / cloud_id.name)
    if name:
        candidates.append(root / name)
    for cand in candidates:
        if cand.is_file():
            return cand
    if name:
        hits = list(root.rglob(name))
        if len(hits) == 1:
            return hits[0]
    return None


def list_clouds(root: Path) -> list[dict]:
    json_path = root / "leaf_labels.json"
    clouds: list[dict] = []
    if json_path.is_file():
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        for item in payload.get("clouds") or []:
            path = _resolve_cloud(root, item)
            if path is None:
                continue
            date_label = str(item.get("dateLabel") or "")
            date_key = date_label.replace("-", "")
            if not DATE_RE.fullmatch(date_key):
                date_key = _date_key(str(item.get("relativePath") or path))
            rel = str(item.get("relativePath") or path.name).replace("\\", "/")
            clouds.append({"date": date_key, "rel": rel, "path": path})
    if not clouds:
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in POINT_EXTS:
                continue
            if "backup_" in path.parts:
                continue
            date_key = _date_key(str(path.relative_to(root))) or _date_key(path.name)
            if not date_key:
                continue
            clouds.append(
                {"date": date_key, "rel": path.relative_to(root).as_posix(), "path": path}
            )
    clouds.sort(key=lambda x: (x["date"], x["rel"]))
    return clouds


def pair_clouds(gt_root: Path, pred_root: Path) -> list[dict]:
    gt_list = list_clouds(gt_root)
    pred_list = list_clouds(pred_root)
    pred_by_date: dict[str, list[dict]] = defaultdict(list)
    pred_by_name: dict[str, dict] = {}
    for item in pred_list:
        pred_by_date[item["date"]].append(item)
        pred_by_name[Path(item["rel"]).name] = item
    paired = []
    used: set[int] = set()
    for gt in gt_list:
        pred = None
        name = Path(gt["rel"]).name
        if name in pred_by_name:
            pred = pred_by_name[name]
        elif len(pred_by_date.get(gt["date"], [])) == 1:
            pred = pred_by_date[gt["date"]][0]
        if pred is None or id(pred) in used:
            raise FileNotFoundError(f"找不到与真值配对的预测文件：{gt['rel']}")
        used.add(id(pred))
        paired.append({"date": gt["date"], "gt": gt["path"], "pred": pred["path"], "rel": gt["rel"]})
    if not paired:
        raise FileNotFoundError("没有配对到任何点云文件")
    return paired


# ---------------------------------------------------------------------------
# Matching primitives
# ---------------------------------------------------------------------------


def hungarian_maximize(weights: np.ndarray) -> tuple[list[int], list[int]]:
    weights = np.asarray(weights, dtype=np.float64)
    n0, m0 = weights.shape
    if n0 == 0 or m0 == 0:
        return [], []
    transpose = n0 > m0
    work = weights.T if transpose else weights
    n, m = work.shape
    mx = float(np.max(np.abs(work))) + 1.0
    cost = mx - work
    inf = 1e18
    a = np.zeros((n + 1, m + 1), dtype=np.float64)
    a[1:, 1:] = cost
    u = np.zeros(n + 1, dtype=np.float64)
    v = np.zeros(m + 1, dtype=np.float64)
    p = np.zeros(m + 1, dtype=np.int32)
    way = np.zeros(m + 1, dtype=np.int32)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = np.full(m + 1, inf)
        used = np.zeros(m + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = int(p[j0])
            delta = inf
            j1 = 0
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = a[i0, j] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = float(minv[j])
                    j1 = j
            for j in range(0, m + 1):
                if used[j]:
                    u[int(p[j])] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = int(way[j0])
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    assigned: list[tuple[int, int]] = []
    for j in range(1, m + 1):
        row = int(p[j])
        if row == 0:
            continue
        if transpose:
            assigned.append((j - 1, row - 1))
        else:
            assigned.append((row - 1, j - 1))
    assigned.sort()
    if not assigned:
        return [], []
    rows, cols = zip(*assigned)
    return list(rows), list(cols)


def adjusted_rand_index(contingency: np.ndarray) -> float:
    nij = np.asarray(contingency, dtype=np.float64)
    n = float(nij.sum())
    if n < 2:
        return 1.0
    comb = lambda x: float(np.sum(x * (x - 1.0) / 2.0))
    sum_c = comb(nij)
    sum_a = comb(nij.sum(axis=1))
    sum_b = comb(nij.sum(axis=0))
    comb_n = n * (n - 1.0) / 2.0
    expected = sum_a * sum_b / comb_n
    max_index = 0.5 * (sum_a + sum_b)
    if max_index == expected:
        return 1.0 if sum_c == expected else 0.0
    return (sum_c - expected) / (max_index - expected)


def _count_pairs(gt: np.ndarray, pred: np.ndarray) -> dict[tuple[int, int], int]:
    mask = gt > 0
    g = gt[mask].astype(np.int64, copy=False)
    p = pred[mask].astype(np.int64, copy=False)
    if g.size == 0:
        return {}
    packed = (g << 32) | (p & np.int64(0xFFFFFFFF))
    uniq, counts = np.unique(packed, return_counts=True)
    out = {}
    for key, cnt in zip(uniq.tolist(), counts.tolist()):
        out[(int(key >> 32), int(key & 0xFFFFFFFF))] = int(cnt)
    return out


# ---------------------------------------------------------------------------
# Frame representation
# ---------------------------------------------------------------------------


@dataclass
class Frame:
    date: str
    when: date
    rel: str
    gt_n: dict[int, int]
    pred_n: dict[int, int]
    conf: dict[tuple[int, int], int]
    n_points: int = 0
    n_labeled: int = 0

    def gt_ids(self) -> list[int]:
        return sorted(self.gt_n)

    def pred_ids(self) -> list[int]:
        return sorted(p for p in self.pred_n if p > 0)

    def iou(self, gt_id: int, pred_id: int) -> float:
        inter = self.conf.get((gt_id, pred_id), 0)
        union = self.gt_n.get(gt_id, 0) + self.pred_n.get(pred_id, 0) - inter
        return inter / union if union else 0.0

    def iou_matrix(self) -> tuple[list[int], list[int], np.ndarray]:
        gts, prs = self.gt_ids(), self.pred_ids()
        mat = np.zeros((len(gts), len(prs)), dtype=np.float64)
        for i, g in enumerate(gts):
            for j, p in enumerate(prs):
                mat[i, j] = self.iou(g, p)
        return gts, prs, mat


def match_frame(frame: Frame, alpha: float) -> list[tuple[int, int, float]]:
    gts, prs, mat = frame.iou_matrix()
    if not gts or not prs:
        return []
    thr = alpha if alpha > 0 else 1e-12
    weights = np.where(mat >= thr, mat, 0.0)
    rows, cols = hungarian_maximize(weights)
    out: list[tuple[int, int, float]] = []
    for r, c in zip(rows, cols):
        iou = float(weights[r, c])
        if iou >= thr:
            out.append((gts[r], prs[c], iou))
    return out


def load_frames(pairs: list[dict]) -> list[Frame]:
    frames: list[Frame] = []
    for item in pairs:
        gt = load_leaf_ids(item["gt"])
        pred = load_leaf_ids(item["pred"])
        if gt.shape != pred.shape:
            raise ValueError(
                f"{item['rel']} 点数不一致：真值 {gt.size}，预测 {pred.size}。"
            )
        counts = _count_pairs(gt, pred)
        gt_n: dict[int, int] = defaultdict(int)
        pred_n: dict[int, int] = defaultdict(int)
        for (g, p), n in counts.items():
            gt_n[g] += n
            pred_n[p] += n
        frames.append(
            Frame(
                date=item["date"],
                when=parse_yyyymmdd(item["date"]),
                rel=item["rel"],
                gt_n=dict(gt_n),
                pred_n=dict(pred_n),
                conf=dict(counts),
                n_points=int(gt.size),
                n_labeled=int(sum(gt_n.values())),
            )
        )
    return frames


# ---------------------------------------------------------------------------
# HOTA / IDF1 / MOTA
# ---------------------------------------------------------------------------


def compute_hota(frames: list[Frame], alphas: tuple[float, ...] = ALPHAS) -> dict:
    per_alpha = []
    for alpha in alphas:
        matches: list[tuple[int, int, int, float]] = []
        n_gt = n_pr = 0
        gt_det = Counter()
        pr_det = Counter()
        for t, fr in enumerate(frames):
            for g in fr.gt_ids():
                n_gt += 1
                gt_det[g] += 1
            for p in fr.pred_ids():
                n_pr += 1
                pr_det[p] += 1
            for g, p, iou in match_frame(fr, alpha):
                matches.append((t, g, p, iou))
        tp = len(matches)
        fn = n_gt - tp
        fp = n_pr - tp
        denom = tp + fn + fp
        deta = tp / denom if denom else 1.0
        det_re = tp / (tp + fn) if (tp + fn) else 1.0
        det_pr = tp / (tp + fp) if (tp + fp) else 1.0
        by_both: dict[tuple[int, int], int] = Counter()
        for _, g, p, _ in matches:
            by_both[(g, p)] += 1
        ass_scores, ass_re, ass_pr, loc = [], [], [], []
        for _, g, p, iou in matches:
            tpa = by_both[(g, p)]
            fna = gt_det[g] - tpa
            fpa = pr_det[p] - tpa
            ass_scores.append(tpa / (tpa + fna + fpa))
            ass_re.append(tpa / (tpa + fna) if (tpa + fna) else 1.0)
            ass_pr.append(tpa / (tpa + fpa) if (tpa + fpa) else 1.0)
            loc.append(iou)
        assa = float(np.mean(ass_scores)) if ass_scores else 1.0
        per_alpha.append(
            {
                "alpha": alpha,
                "HOTA": math.sqrt(deta * assa),
                "DetA": deta,
                "AssA": assa,
                "LocA": float(np.mean(loc)) if loc else 1.0,
                "DetRe": det_re,
                "DetPr": det_pr,
                "AssRe": float(np.mean(ass_re)) if ass_re else 1.0,
                "AssPr": float(np.mean(ass_pr)) if ass_pr else 1.0,
                "TP": tp,
                "FN": fn,
                "FP": fp,
            }
        )

    def _mean(key: str) -> float:
        return float(np.mean([row[key] for row in per_alpha]))

    hota50 = next(row for row in per_alpha if abs(row["alpha"] - 0.5) < 1e-9)
    return {
        "HOTA": _mean("HOTA"),
        "DetA": _mean("DetA"),
        "AssA": _mean("AssA"),
        "LocA": _mean("LocA"),
        "DetRe": _mean("DetRe"),
        "DetPr": _mean("DetPr"),
        "AssRe": _mean("AssRe"),
        "AssPr": _mean("AssPr"),
        "HOTA_50": hota50["HOTA"],
        "DetA_50": hota50["DetA"],
        "AssA_50": hota50["AssA"],
        "LocA_50": hota50["LocA"],
        "by_alpha": per_alpha,
    }


def compute_idf1(frames: list[Frame], alpha: float = MATCH_ALPHA) -> dict:
    matches: list[tuple[int, int]] = []
    n_gt = n_pr = 0
    pair_count: dict[tuple[int, int], int] = Counter()
    gt_ids: set[int] = set()
    pr_ids: set[int] = set()
    for fr in frames:
        gts, prs = fr.gt_ids(), fr.pred_ids()
        n_gt += len(gts)
        n_pr += len(prs)
        gt_ids.update(gts)
        pr_ids.update(prs)
        for g, p, _ in match_frame(fr, alpha):
            matches.append((g, p))
            pair_count[(g, p)] += 1
    gt_list, pr_list = sorted(gt_ids), sorted(pr_ids)
    if not gt_list or not pr_list:
        return {"IDF1": 1.0, "IDP": 1.0, "IDR": 1.0, "IDTP": 0, "IDFP": 0, "IDFN": 0}
    weights = np.zeros((len(gt_list), len(pr_list)), dtype=np.float64)
    gi = {g: i for i, g in enumerate(gt_list)}
    pi = {p: i for i, p in enumerate(pr_list)}
    for (g, p), n in pair_count.items():
        weights[gi[g], pi[p]] = n
    rows, cols = hungarian_maximize(weights)
    mapping = {}
    for r, c in zip(rows, cols):
        if weights[r, c] > 0:
            mapping[pr_list[c]] = gt_list[r]
    idtp = sum(1 for g, p in matches if mapping.get(p) == g)
    idfn = n_gt - idtp
    idfp = n_pr - idtp
    idf1 = (2 * idtp) / (2 * idtp + idfp + idfn) if (2 * idtp + idfp + idfn) else 1.0
    idp = idtp / (idtp + idfp) if (idtp + idfp) else 1.0
    idr = idtp / (idtp + idfn) if (idtp + idfn) else 1.0
    return {
        "IDF1": idf1,
        "IDP": idp,
        "IDR": idr,
        "IDTP": idtp,
        "IDFP": idfp,
        "IDFN": idfn,
        "track_map": {str(k): v for k, v in mapping.items()},
    }


def compute_mota_idsw(frames: list[Frame], alpha: float = MATCH_ALPHA) -> dict:
    last: dict[int, int] = {}
    idsw = 0
    n_gt = n_pr = tp = 0
    for fr in frames:
        n_gt += len(fr.gt_ids())
        n_pr += len(fr.pred_ids())
        matched = {g: p for g, p, _ in match_frame(fr, alpha)}
        tp += len(matched)
        for g, p in matched.items():
            if g in last and last[g] != p:
                idsw += 1
            last[g] = p
    fn, fp = n_gt - tp, n_pr - tp
    mota = 1.0 - (fn + fp + idsw) / n_gt if n_gt else 1.0
    n_switch_denom = 0
    last = {}
    for fr in frames:
        matched = {g: p for g, p, _ in match_frame(fr, alpha)}
        for g, p in matched.items():
            if g in last:
                n_switch_denom += 1
            last[g] = p
    return {
        "MOTA": mota,
        "IDSW": idsw,
        "IDSW_rate": idsw / n_switch_denom if n_switch_denom else 0.0,
        "TP_50": tp,
        "FN_50": fn,
        "FP_50": fp,
        "n_gt_dets": n_gt,
        "n_pred_dets": n_pr,
    }


# ---------------------------------------------------------------------------
# Segmentation: PQ, split/merge, frame/global mIoU
# ---------------------------------------------------------------------------


def compute_pq_split_merge(frames: list[Frame], alpha: float = MATCH_ALPHA) -> dict:
    iou_sum = 0.0
    tp = fn = fp = 0
    splits = merges = 0
    n_gt = n_pr = 0
    coverages = []
    for fr in frames:
        gts, prs = fr.gt_ids(), fr.pred_ids()
        n_gt += len(gts)
        n_pr += len(prs)
        matched = match_frame(fr, alpha)
        tp += len(matched)
        fn += len(gts) - len(matched)
        fp += len(prs) - len(matched)
        matched_g = {g for g, _, _ in matched}
        matched_p = {p for _, p, _ in matched}
        for _, _, iou in matched:
            iou_sum += iou
        for g in gts:
            parts = [
                p
                for p in prs
                if fr.gt_n[g] and fr.conf.get((g, p), 0) / fr.gt_n[g] >= SPLIT_FRAC
            ]
            if len(parts) >= 2:
                splits += 1
            if g in matched_g:
                p = next(pp for gg, pp, _ in matched if gg == g)
                coverages.append(fr.conf.get((g, p), 0) / fr.gt_n[g])
        for p in prs:
            parts = [
                g
                for g in gts
                if fr.pred_n[p] and fr.conf.get((g, p), 0) / fr.pred_n[p] >= SPLIT_FRAC
            ]
            if len(parts) >= 2:
                merges += 1
        _ = matched_p
    pq_den = tp + 0.5 * fp + 0.5 * fn
    sq = iou_sum / tp if tp else 1.0
    rq = tp / pq_den if pq_den else 1.0
    return {
        "PQ": sq * rq,
        "SQ": sq,
        "RQ": rq,
        "split_rate": splits / n_gt if n_gt else 0.0,
        "merge_rate": merges / n_pr if n_pr else 0.0,
        "n_split": splits,
        "n_merge": merges,
        "coverage": float(np.mean(coverages)) if coverages else 1.0,
    }


def compute_miou(frames: list[Frame]) -> dict:
    frame_ious = []
    global_conf: dict[tuple[int, int], int] = Counter()
    for fr in frames:
        matches = {g: (p, iou) for g, p, iou in match_frame(fr, 0.0)}
        ious = []
        for g in fr.gt_ids():
            if g in matches and matches[g][1] > 0:
                ious.append(matches[g][1])
            else:
                ious.append(0.0)
        if ious:
            frame_ious.append(float(np.mean(ious)))
        for (g, p), n in fr.conf.items():
            if g > 0:
                global_conf[(g, p)] += n
    gt_ids = sorted({g for g, p in global_conf if g > 0})
    pred_ids = sorted({p for g, p in global_conf if p > 0})
    mapping: dict[int, int] = {}
    if gt_ids and pred_ids:
        weights = np.zeros((len(gt_ids), len(pred_ids)), dtype=np.float64)
        gi = {g: i for i, g in enumerate(gt_ids)}
        pi = {p: i for i, p in enumerate(pred_ids)}
        for (g, p), n in global_conf.items():
            if p > 0:
                weights[gi[g], pi[p]] += n
        rows, cols = hungarian_maximize(weights)
        for r, c in zip(rows, cols):
            if weights[r, c] > 0:
                mapping[pred_ids[c]] = gt_ids[r]
    remapped: dict[tuple[int, int], int] = Counter()
    labeled = correct = 0
    for (g, p), n in global_conf.items():
        mapped = mapping.get(p, 0) if p > 0 else 0
        remapped[(g, mapped)] += n
        labeled += n
        if mapped == g:
            correct += n
    ious = []
    for k in gt_ids:
        inter = remapped.get((k, k), 0)
        union = sum(n for (g, p), n in remapped.items() if g == k or p == k)
        if union:
            ious.append(inter / union)
    gt_c = sorted({g for g, _ in global_conf})
    pr_c = sorted({p for _, p in global_conf})
    table = np.zeros((len(gt_c), len(pr_c)), dtype=np.float64)
    gi = {g: i for i, g in enumerate(gt_c)}
    pi = {p: i for i, p in enumerate(pr_c)}
    for (g, p), n in global_conf.items():
        table[gi[g], pi[p]] += n
    oa_daily = []
    for fr in frames:
        hit = 0
        matched = {g: p for g, p, _ in match_frame(fr, 0.0)}
        for g, n in fr.gt_n.items():
            p = matched.get(g)
            if p is None:
                continue
            hit += fr.conf.get((g, p), 0)
        oa_daily.append(hit / fr.n_labeled if fr.n_labeled else 1.0)
    return {
        "mIoU_frame": float(np.mean(frame_ious)) if frame_ious else 1.0,
        "mIoU_global": float(np.mean(ious)) if ious else 1.0,
        "OA_global": correct / labeled if labeled else 1.0,
        "OA_frame": float(np.mean(oa_daily)) if oa_daily else 1.0,
        "ARI_points": adjusted_rand_index(table) if table.size else 1.0,
        "temporal_cost": float(np.mean(oa_daily) - (correct / labeled if labeled else 1.0))
        if oa_daily
        else 0.0,
        "pred_to_gt": {str(k): v for k, v in sorted(mapping.items())},
        "n_labeled": labeled,
        "n_points": sum(fr.n_points for fr in frames),
    }


# ---------------------------------------------------------------------------
# Association (match-based, paper primary interpretable metric)
# ---------------------------------------------------------------------------


def _matched_pred(frame: Frame, alpha: float) -> dict[int, int | None]:
    matched = {g: p for g, p, _ in match_frame(frame, alpha)}
    return {g: matched.get(g) for g in frame.gt_ids()}


def compute_assoc(frames: list[Frame], alpha: float = MATCH_ALPHA) -> dict:
    adj_ok = adj_n = adj_miss = 0
    adj_w_ok = adj_w_n = 0.0
    pair_rows = []
    per_leaf: dict[int, dict] = {}

    for i in range(len(frames) - 1):
        a, b = frames[i], frames[i + 1]
        ma, mb = _matched_pred(a, alpha), _matched_pred(b, alpha)
        shared = set(a.gt_ids()) & set(b.gt_ids())
        n_ok = n_miss = 0
        fails = []
        for k in sorted(shared):
            pa, pb = ma.get(k), mb.get(k)
            w = (a.gt_n[k] + b.gt_n[k]) / 2.0
            adj_n += 1
            adj_w_n += w
            rec = per_leaf.setdefault(k, {"ok": 0, "n": 0, "miss": 0, "sw": 0, "seq": []})
            rec["n"] += 1
            if pa is None or pb is None:
                adj_miss += 1
                n_miss += 1
                rec["miss"] += 1
                fails.append(f"{k}:{pa}->{pb}")
            elif pa == pb:
                adj_ok += 1
                adj_w_ok += w
                n_ok += 1
                rec["ok"] += 1
            else:
                rec["sw"] += 1
                fails.append(f"{k}:{pa}->{pb}")
        gap_days = (b.when - a.when).days
        pair_rows.append(
            {
                "date_a": a.date,
                "date_b": b.date,
                "gap_days": gap_days,
                "n_shared": len(shared),
                "n_correct": n_ok,
                "n_miss": n_miss,
                "assoc_acc": (n_ok / len(shared)) if shared else 1.0,
                "fails": ";".join(fails),
            }
        )

    all_ok = all_n = 0
    leaf_rows = []
    seqs: dict[int, list[tuple[str, int | None, int]]] = defaultdict(list)
    for fr in frames:
        matched = _matched_pred(fr, alpha)
        for g in fr.gt_ids():
            seqs[g].append((fr.date, matched.get(g), fr.gt_n[g]))

    for k, seq in sorted(seqs.items()):
        preds = [p for _, p, _ in seq]
        n_days = len(seq)
        n_ok_all = n_all = 0
        for i in range(n_days):
            for j in range(i + 1, n_days):
                n_all += 1
                all_n += 1
                pa, pb = preds[i], preds[j]
                if pa is not None and pb is not None and pa == pb:
                    n_ok_all += 1
                    all_ok += 1
        stats = per_leaf.get(k, {"ok": 0, "n": 0, "miss": 0, "sw": 0})
        counter: dict[int, int] = Counter(p for p in preds if p is not None)
        best, n_best = (counter.most_common(1)[0] if counter else (None, 0))
        leaf_rows.append(
            {
                "leaf_id": k,
                "n_days": n_days,
                "majority_pred": best if best is not None else "",
                "consistency": n_best / n_days if n_days else 1.0,
                "assoc_acc": (stats["ok"] / stats["n"]) if stats["n"] else 1.0,
                "pair_acc": (n_ok_all / n_all) if n_all else 1.0,
                "id_switch": stats["sw"],
                "n_miss_adj": stats["miss"],
                "first_date": seq[0][0],
                "last_date": seq[-1][0],
                "pred_seq": ">".join("∅" if p is None else str(p) for p in preds),
            }
        )

    macro = float(np.mean([row["assoc_acc"] for row in leaf_rows if row["n_days"] > 1])) if leaf_rows else 1.0
    n_bad = sum(1 for row in leaf_rows if row["id_switch"] > 0 or row["n_miss_adj"] > 0)

    ld_gt, ld_pr = [], []
    for fr in frames:
        matched = _matched_pred(fr, alpha)
        for g in fr.gt_ids():
            ld_gt.append(g)
            p = matched.get(g)
            ld_pr.append(p if p is not None else -g)
    if ld_gt:
        ids = sorted(set(ld_gt) | set(ld_pr))
        idx = {v: i for i, v in enumerate(ids)}
        table = np.zeros((len(ids), len(ids)))
        for g, p in zip(ld_gt, ld_pr):
            table[idx[g], idx[p]] += 1
        ari = adjusted_rand_index(table)
    else:
        ari = 1.0

    return {
        "AssocAcc": adj_ok / adj_n if adj_n else 1.0,
        "AssocAcc_weighted": adj_w_ok / adj_w_n if adj_w_n else 1.0,
        "AssocAcc_macro": macro,
        "PairAcc": all_ok / all_n if all_n else 1.0,
        "n_adjacent": adj_n,
        "n_adjacent_correct": adj_ok,
        "n_adjacent_miss": adj_miss,
        "n_inconsistent_leaves": n_bad,
        "n_leaves": len(leaf_rows),
        "ARI_leaf_days": ari,
        "pair_rows": pair_rows,
        "leaf_rows": leaf_rows,
    }


def compute_gap_assoc(frames: list[Frame], alpha: float = MATCH_ALPHA) -> list[dict]:
    matched = [_matched_pred(fr, alpha) for fr in frames]
    by_step: dict[int, list[int]] = defaultdict(list)
    by_days: dict[int, list[int]] = defaultdict(list)
    for i in range(len(frames)):
        for j in range(i + 1, len(frames)):
            shared = set(frames[i].gt_ids()) & set(frames[j].gt_ids())
            if not shared:
                continue
            ok = 0
            for k in shared:
                pa, pb = matched[i].get(k), matched[j].get(k)
                if pa is not None and pb is not None and pa == pb:
                    ok += 1
            acc = ok / len(shared)
            step = j - i
            days = (frames[j].when - frames[i].when).days
            by_step[step].append(acc)
            by_days[days].append(acc)
    rows = []
    for step, vals in sorted(by_step.items()):
        rows.append(
            {
                "kind": "frame_step",
                "gap": step,
                "n_pairs": len(vals),
                "assoc_acc": float(np.mean(vals)),
            }
        )
    for days, vals in sorted(by_days.items()):
        rows.append(
            {
                "kind": "calendar_days",
                "gap": days,
                "n_pairs": len(vals),
                "assoc_acc": float(np.mean(vals)),
            }
        )
    bins = [(1, 3, "1-3d"), (4, 7, "4-7d"), (8, 14, "8-14d"), (15, 10_000, "15d+")]
    for lo, hi, name in bins:
        vals = []
        for days, accs in by_days.items():
            if lo <= days <= hi:
                vals.extend(accs)
        if vals:
            rows.append(
                {
                    "kind": "calendar_bin",
                    "gap": name,
                    "n_pairs": len(vals),
                    "assoc_acc": float(np.mean(vals)),
                }
            )
    return rows


# ---------------------------------------------------------------------------
# Majority-vote diagnostic (previous definition; not the paper primary)
# ---------------------------------------------------------------------------


def majority_pred(counter: dict[int, int]) -> int:
    if not counter:
        return 0
    pred_id, _ = max(
        counter.items(),
        key=lambda kv: (kv[1], kv[0] != 0, -kv[0] if kv[0] else 0),
    )
    return int(pred_id)


def compute_majority_assoc(frames: list[Frame]) -> dict:
    ok = n = 0
    for i in range(len(frames) - 1):
        a, b = frames[i], frames[i + 1]
        shared = set(a.gt_ids()) & set(b.gt_ids())
        for k in shared:
            n += 1
            ca: dict[int, int] = defaultdict(int)
            cb: dict[int, int] = defaultdict(int)
            for (g, p), cnt in a.conf.items():
                if g == k:
                    ca[p] += cnt
            for (g, p), cnt in b.conf.items():
                if g == k:
                    cb[p] += cnt
            pa, pb = majority_pred(ca), majority_pred(cb)
            if pa > 0 and pb > 0 and pa == pb:
                ok += 1
    return {"AssocAcc_majority": ok / n if n else 1.0}


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def evaluate(frames: list[Frame]) -> dict:
    hota = compute_hota(frames)
    idf1 = compute_idf1(frames)
    mota = compute_mota_idsw(frames)
    pq = compute_pq_split_merge(frames)
    miou = compute_miou(frames)
    assoc = compute_assoc(frames)
    gap = compute_gap_assoc(frames)
    maj = compute_majority_assoc(frames)
    summary = {
        "n_scans": len(frames),
        "dates": [fr.date for fr in frames],
        "n_points": miou["n_points"],
        "n_labeled": miou["n_labeled"],
        **{k: v for k, v in hota.items() if k != "by_alpha"},
        **{k: v for k, v in idf1.items() if k != "track_map"},
        **mota,
        **{k: v for k, v in pq.items()},
        **{k: v for k, v in miou.items() if k != "pred_to_gt"},
        **{k: v for k, v in assoc.items() if k not in {"pair_rows", "leaf_rows"}},
        **maj,
        "hota_by_alpha": hota["by_alpha"],
        "pred_to_gt": miou["pred_to_gt"],
        "idf1_track_map": idf1.get("track_map", {}),
        "pair_rows": assoc["pair_rows"],
        "leaf_rows": assoc["leaf_rows"],
        "gap_rows": gap,
    }
    return summary


def _pct(x: float) -> str:
    return f"{100.0 * x:.2f}%"


def print_report(gt: Path, pred: Path, s: dict) -> None:
    print(f"Ground truth : {gt}")
    print(f"Prediction   : {pred}")
    print(f"Scans        : {s['n_scans']}  ({' → '.join(s['dates'])})")
    print(f"Labeled pts  : {s['n_labeled']} / {s['n_points']}")
    print()
    print("========== Paper metrics ==========")
    print(f"HOTA              {s['HOTA']:.4f}     (mean over IoU α = 0.05–0.95)")
    print(f"  DetA            {s['DetA']:.4f}     detection / per-scan identity")
    print(f"  AssA            {s['AssA']:.4f}     temporal association")
    print(f"  LocA            {s['LocA']:.4f}     mean IoU of matches")
    print(f"HOTA@0.5          {s['HOTA_50']:.4f}")
    print(f"IDF1              {s['IDF1']:.4f}     IDP={s['IDP']:.4f}  IDR={s['IDR']:.4f}")
    print(f"AssocAcc@0.5      {_pct(s['AssocAcc'])}    {s['n_adjacent_correct']}/{s['n_adjacent']}  (adjacent, IoU match)")
    print(f"  miss/unmatched  {s['n_adjacent_miss']}")
    print(f"  weighted        {_pct(s['AssocAcc_weighted'])}")
    print(f"  macro (per leaf){_pct(s['AssocAcc_macro'])}")
    print(f"PairAcc           {_pct(s['PairAcc'])}    all day-pairs of a leaf")
    print(f"IDSW              {s['IDSW']}     rate {_pct(s['IDSW_rate'])}")
    print(f"Split rate        {_pct(s['split_rate'])}    GT leaf covered by ≥2 pred IDs")
    print(f"Merge rate        {_pct(s['merge_rate'])}    pred ID covering ≥2 GT leaves")
    print(f"PQ                {s['PQ']:.4f}     SQ={s['SQ']:.4f}  RQ={s['RQ']:.4f}")
    print(f"mIoU (per scan)   {_pct(s['mIoU_frame'])}")
    print(f"mIoU (global ID)  {_pct(s['mIoU_global'])}")
    print(f"OA global / frame {_pct(s['OA_global'])} / {_pct(s['OA_frame'])}")
    print(f"Temporal cost     {_pct(s['temporal_cost'])}    frame OA − global OA")
    print(f"ARI (points)      {s['ARI_points']:.4f}")
    print(f"ARI (leaf-days)   {s['ARI_leaf_days']:.4f}")
    print(f"MOTA (suppl.)     {s['MOTA']:.4f}")
    print(f"Unstable leaves   {s['n_inconsistent_leaves']}/{s['n_leaves']}")
    print()
    print("Majority-vote AssocAcc (diagnostic, not used as primary): "
          f"{_pct(s['AssocAcc_majority'])}")
    print()
    print("Association vs interval (frame step):")
    for row in s["gap_rows"]:
        if row["kind"] == "frame_step":
            print(f"  Δt = {row['gap']:>2} scans   {_pct(row['assoc_acc'])}   (n={row['n_pairs']})")
    print("Association vs calendar gap:")
    for row in s["gap_rows"]:
        if row["kind"] == "calendar_bin":
            print(f"  {row['gap']:<6}  {_pct(row['assoc_acc'])}   (n={row['n_pairs']})")
    bad = [row for row in s["leaf_rows"] if row["id_switch"] > 0 or row["n_miss_adj"] > 0]
    if bad:
        print()
        print("Unstable leaves (match-based):")
        for row in bad:
            print(
                f"  leaf {row['leaf_id']:>3}  AssocAcc {_pct(row['assoc_acc'])}  "
                f"SW={row['id_switch']}  miss={row['n_miss_adj']}  {row['pred_seq']}"
            )
    print()
    print("---------- copy for paper (English) ----------")
    print(
        f"HOTA {s['HOTA']:.3f} (DetA {s['DetA']:.3f}, AssA {s['AssA']:.3f}), "
        f"IDF1 {s['IDF1']:.3f}, adjacent AssocAcc {s['AssocAcc']:.3f}, "
        f"IDSW {s['IDSW']}, split {s['split_rate']:.3f}, merge {s['merge_rate']:.3f}, "
        f"PQ {s['PQ']:.3f}, mIoU-frame {s['mIoU_frame']:.3f}, mIoU-global {s['mIoU_global']:.3f}."
    )


def write_outputs(out_dir: Path, s: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    skip = {"pair_rows", "leaf_rows", "gap_rows", "hota_by_alpha", "pred_to_gt", "idf1_track_map"}
    summary = {k: v for k, v in s.items() if k not in skip}
    summary["pred_to_gt"] = s.get("pred_to_gt", {})
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _csv(out_dir / "adjacent_pairs.csv", s["pair_rows"])
    _csv(out_dir / "per_leaf.csv", s["leaf_rows"])
    _csv(out_dir / "assoc_by_gap.csv", s["gap_rows"])
    _csv(out_dir / "hota_by_alpha.csv", s["hota_by_alpha"])
    paper = {
        "HOTA": s["HOTA"],
        "DetA": s["DetA"],
        "AssA": s["AssA"],
        "LocA": s["LocA"],
        "HOTA_50": s["HOTA_50"],
        "IDF1": s["IDF1"],
        "AssocAcc": s["AssocAcc"],
        "AssocAcc_macro": s["AssocAcc_macro"],
        "PairAcc": s["PairAcc"],
        "IDSW": s["IDSW"],
        "IDSW_rate": s["IDSW_rate"],
        "split_rate": s["split_rate"],
        "merge_rate": s["merge_rate"],
        "PQ": s["PQ"],
        "mIoU_frame": s["mIoU_frame"],
        "mIoU_global": s["mIoU_global"],
        "OA_global": s["OA_global"],
        "temporal_cost": s["temporal_cost"],
        "ARI_points": s["ARI_points"],
        "MOTA": s["MOTA"],
    }
    _csv(out_dir / "paper_table.csv", [paper])


def _csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8-sig")
        return
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------


def _toy(date_str: str, triples: list[tuple[int, int, int]]) -> Frame:
    gt_n: dict[int, int] = defaultdict(int)
    pred_n: dict[int, int] = defaultdict(int)
    conf: dict[tuple[int, int], int] = {}
    for g, p, n in triples:
        conf[(g, p)] = n
        gt_n[g] += n
        pred_n[p] += n
    return Frame(date_str, parse_yyyymmdd(date_str), date_str, dict(gt_n), dict(pred_n), conf, 0, sum(gt_n.values()))


def self_test() -> None:
    w = np.array([[4.0, 1.0, 3.0], [2.0, 0.0, 5.0], [3.0, 2.0, 2.0]])
    rows, cols = hungarian_maximize(w)
    assert sorted(zip(rows, cols)) == [(0, 0), (1, 2), (2, 1)]

    perfect = [
        _toy("20250101", [(1, 1, 100), (2, 2, 100)]),
        _toy("20250103", [(1, 1, 100), (2, 2, 100)]),
    ]
    s = evaluate(perfect)
    assert abs(s["HOTA"] - 1.0) < 1e-6, s["HOTA"]
    assert abs(s["AssocAcc"] - 1.0) < 1e-6
    assert s["IDSW"] == 0

    perm = [
        _toy("20250101", [(1, 5, 100), (2, 8, 100)]),
        _toy("20250103", [(1, 5, 100), (2, 8, 100)]),
    ]
    s = evaluate(perm)
    assert abs(s["AssocAcc"] - 1.0) < 1e-6
    assert abs(s["HOTA"] - 1.0) < 1e-6, s["HOTA"]
    assert abs(s["IDF1"] - 1.0) < 1e-6

    swap = [
        _toy("20250101", [(1, 1, 100), (2, 2, 100)]),
        _toy("20250103", [(1, 2, 100), (2, 1, 100)]),
    ]
    s = evaluate(swap)
    assert s["AssocAcc"] == 0.0
    assert s["IDSW"] == 2
    assert s["DetA_50"] > 0.99
    assert s["AssA"] < 0.9

    merged = [
        _toy("20250101", [(1, 1, 100), (2, 1, 100)]),
        _toy("20250103", [(1, 1, 100), (2, 1, 100)]),
    ]
    s = evaluate(merged)
    assert s["merge_rate"] == 1.0
    assert s["AssocAcc"] < 1.0

    miss = [
        _toy("20250101", [(1, 1, 100)]),
        _toy("20250103", [(1, 0, 100)]),
    ]
    s = evaluate(miss)
    assert s["n_adjacent_miss"] == 1
    assert s["AssocAcc"] == 0.0
    print("self-test ok")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Multi-temporal leaf identity evaluation")
    parser.add_argument("--gt", type=Path, help="Ground-truth folder")
    parser.add_argument("--pred", type=Path, help="Prediction folder")
    parser.add_argument("--out", type=Path, default=None, help="Output directory")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        if args.gt is None:
            return
    if args.gt is None or args.pred is None:
        parser.error("请提供 --gt 和 --pred")
    gt_root = args.gt.expanduser().resolve()
    pred_root = args.pred.expanduser().resolve()
    frames = load_frames(pair_clouds(gt_root, pred_root))
    summary = evaluate(frames)
    print_report(gt_root, pred_root, summary)
    out_dir = args.out.expanduser().resolve() if args.out else pred_root / "temporal_eval"
    write_outputs(out_dir, summary)
    print()
    print(f"Wrote {out_dir}")


if __name__ == "__main__":
    main()
