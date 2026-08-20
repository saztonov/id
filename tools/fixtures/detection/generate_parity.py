# -*- coding: utf-8 -*-
"""Одноразовый генератор паритетных фикстур Python↔TS для packages/detection.

Прогоняет ЧИСТЫЕ модули референса RD WEB (temp/RDNEW/services/web_ocr/detection:
postprocess/nms/tiling/model_params — без onnxruntime и PIL) на детерминированных
входах (numpy, seed=42) и пишет JSON-фикстуры {case, input, params, expected} в
этот каталог. TS-тест packages/detection/src/parity.test.ts читает их и сверяет
результаты порта с допуском 1e-6.

Перегенерация (нужна только при изменении референса):
    python tools/fixtures/detection/generate_parity.py
    npx prettier --write "tools/fixtures/detection/**/*.json"   # формат-гейт репо

Требования: python3 + numpy; каталог temp/RDNEW (в .gitignore) должен лежать в
корне репозитория. Сгенерированные *.json коммитятся — прогон тестов Python не
требует.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
RDNEW = REPO_ROOT / "temp" / "RDNEW"
if not RDNEW.exists():
    raise SystemExit(f"Не найден референс {RDNEW} — фикстуры генерировать не из чего")
sys.path.insert(0, str(RDNEW))

import numpy as np  # noqa: E402

from services.web_ocr.detection import model_params as mp  # noqa: E402
from services.web_ocr.detection import nms as nms_mod  # noqa: E402
from services.web_ocr.detection import postprocess as pp  # noqa: E402
from services.web_ocr.detection import tiling as tiling_mod  # noqa: E402
from services.web_ocr.domain.enums import BlockType  # noqa: E402

CLASS_MAPPING = {"text": 0, "image": 1, "stamp": 2}


def dump(name: str, payload: dict) -> None:
    path = HERE / name
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"написано {path.relative_to(REPO_ROOT)}")


def raw_det_json(det: pp.RawTileDet) -> dict:
    return {"blockType": det.block_type.value, "boxNorm": list(det.box_norm), "score": det.score}


def pixel_det_json(det: nms_mod.PixelDet) -> dict:
    return {
        "blockType": det.block_type.value,
        "x0": det.x0,
        "y0": det.y0,
        "x1": det.x1,
        "y1": det.y1,
        "score": det.score,
    }


def pixel_det_from_json(d: dict) -> nms_mod.PixelDet:
    return nms_mod.PixelDet(BlockType(d["blockType"]), d["x0"], d["y0"], d["x1"], d["y1"], d["score"])


def counter_json(counter) -> dict:
    return {bt.value: int(n) for bt, n in sorted(counter.items(), key=lambda kv: kv[0].value) if n}


def stats_json(stats: pp.TileDecodeStats) -> dict:
    return {
        "nearFullTile": counter_json(stats.near_full_tile),
        "rejectedFullTile": counter_json(stats.rejected_full_tile),
        "rejectedMinBox": stats.rejected_min_box,
    }


def gen_decode_tile_sigmoid() -> None:
    """decode_tile: sigmoid + cxcywh_normalized + top-K + score_floor + min-box."""
    rng = np.random.default_rng(42)
    q = 6
    logits = rng.normal(0.0, 2.5, size=(q, 4))
    boxes = np.stack(
        [
            rng.uniform(0.15, 0.85, size=q),  # cx
            rng.uniform(0.15, 0.85, size=q),  # cy
            rng.uniform(0.05, 0.45, size=q),  # w
            rng.uniform(0.05, 0.45, size=q),  # h
        ],
        axis=-1,
    )
    # Вырожденный бокс (уже min_box_norm по ширине) — проверка minBox-фильтра.
    boxes[3] = [0.5, 0.5, 5e-4, 0.2]
    # Высокий логит text у вырожденного бокса, чтобы он попал в top-K до фильтра.
    logits[3, 0] = 4.0

    dets = boxes.tolist()
    labels = logits.tolist()
    params = {
        "classMapping": CLASS_MAPPING,
        "resolution": 560,
        "activation": "sigmoid",
        "numSelect": 10,
        "scoreFloor": 0.05,
        "boxFormat": "cxcywh_normalized",
    }
    stats = pp.TileDecodeStats()
    result = pp.decode_tile(
        np.asarray(dets, dtype=np.float64),
        np.asarray(labels, dtype=np.float64),
        class_mapping=CLASS_MAPPING,
        resolution=560,
        activation="sigmoid",
        num_select=10,
        score_floor=0.05,
        box_format="cxcywh_normalized",
        stats=stats,
    )
    dump(
        "decode_tile_sigmoid.json",
        {
            "case": "decode_tile: sigmoid, cxcywh_normalized, top-K=10, floor=0.05",
            "input": {"dets": dets, "labels": labels},
            "params": params,
            "expected": {"raw": [raw_det_json(d) for d in result], "stats": stats_json(stats)},
        },
    )


def gen_decode_tile_softmax_guard() -> None:
    """decode_tile: softmax + xyxy_pixels + full-tile guard для text (тайловый режим)."""
    rng = np.random.default_rng(43)
    q = 5
    res = 640
    logits = rng.normal(0.0, 2.0, size=(q, 4))
    boxes = np.stack(
        [
            rng.uniform(0.0, 0.4, size=q) * res,
            rng.uniform(0.0, 0.4, size=q) * res,
            rng.uniform(0.5, 1.0, size=q) * res,
            rng.uniform(0.5, 1.0, size=q) * res,
        ],
        axis=-1,
    )
    # Вырожденный паттерн: box ~на весь tile с высоким score text → guard отбрасывает.
    # Все крафтовые логиты попарно различны: при РАВНЫХ score порядок внутри
    # top-K у numpy (argpartition+нестабильный argsort) не определён и паритет
    # порядка с TS был бы недоказуем.
    boxes[0] = [2.0, 3.0, 636.0, 638.0]
    logits[0] = [6.0, -3.0, -3.2, -4.0]
    # Почти full-tile IMAGE — guard применяется только к text, бокс остаётся.
    boxes[1] = [1.0, 1.0, 639.0, 637.0]
    logits[1] = [-3.1, 5.0, -2.9, -4.1]

    dets = boxes.tolist()
    labels = logits.tolist()
    stats = pp.TileDecodeStats()
    result = pp.decode_tile(
        np.asarray(dets, dtype=np.float64),
        np.asarray(labels, dtype=np.float64),
        class_mapping=CLASS_MAPPING,
        resolution=res,
        activation="softmax",
        num_select=8,
        score_floor=0.0,
        box_format="xyxy_pixels",
        reject_full_tile_types=frozenset({BlockType.TEXT}),
        full_tile_min_ratio=0.9,
        stats=stats,
    )
    dump(
        "decode_tile_softmax_guard.json",
        {
            "case": "decode_tile: softmax, xyxy_pixels, reject_full_tile={text}",
            "input": {"dets": dets, "labels": labels},
            "params": {
                "classMapping": CLASS_MAPPING,
                "resolution": res,
                "activation": "softmax",
                "numSelect": 8,
                "scoreFloor": 0.0,
                "boxFormat": "xyxy_pixels",
                "rejectFullTileTypes": ["text"],
                "fullTileMinRatio": 0.9,
            },
            "expected": {"raw": [raw_det_json(d) for d in result], "stats": stats_json(stats)},
        },
    )


def gen_nms_merge_filter_cap() -> None:
    """Стадии page-level постобработки на фиксированном наборе PixelDet."""
    dets = [
        # Пара text с высоким IoU → NMS оставит score 0.9.
        {"blockType": "text", "x0": 100.0, "y0": 100.0, "x1": 400.0, "y1": 160.0, "score": 0.9},
        {"blockType": "text", "x0": 110.0, "y0": 102.0, "x1": 405.0, "y1": 158.0, "score": 0.7},
        # Text рядом на той же строке (зазор мал) → merge склеит с первым.
        {"blockType": "text", "x0": 412.0, "y0": 101.0, "x1": 700.0, "y1": 159.0, "score": 0.8},
        # Text далеко → не склеивается.
        {"blockType": "text", "x0": 100.0, "y0": 800.0, "x1": 400.0, "y1": 860.0, "score": 0.65},
        # Image, перекрывающий text — класс другой, NMS не подавляет.
        {"blockType": "image", "x0": 90.0, "y0": 90.0, "x1": 500.0, "y1": 500.0, "score": 0.85},
        # Пара штампов с высоким IoU → NMS оставит 0.75; merge их НЕ трогает.
        {"blockType": "stamp", "x0": 600.0, "y0": 600.0, "x1": 800.0, "y1": 760.0, "score": 0.75},
        {"blockType": "stamp", "x0": 605.0, "y0": 605.0, "x1": 795.0, "y1": 755.0, "score": 0.74},
        # Слабый image — отсечётся порогом класса 0.6.
        {"blockType": "image", "x0": 900.0, "y0": 100.0, "x1": 1100.0, "y1": 300.0, "score": 0.55},
    ]
    pixel = [pixel_det_from_json(d) for d in dets]
    after_nms = nms_mod.class_aware_nms(pixel, iou_threshold=0.5)
    after_merge = nms_mod.merge_split_text_boxes(after_nms)
    thresholds = {BlockType.TEXT: 0.5, BlockType.IMAGE: 0.6, BlockType.STAMP: 0.7}
    after_filter = nms_mod.filter_by_class_threshold(after_merge, thresholds, 0.5)
    capped = nms_mod.cap_detections(after_filter, 3)
    dump(
        "nms_merge_filter_cap.json",
        {
            "case": "class_aware_nms(0.5) → merge_split_text → filter(text .5/image .6/stamp .7) → cap(3)",
            "input": {"dets": dets},
            "params": {
                "nmsIou": 0.5,
                "thresholds": {"text": 0.5, "image": 0.6, "stamp": 0.7},
                "defaultThreshold": 0.5,
                "maxDetections": 3,
            },
            "expected": {
                "afterNms": [pixel_det_json(d) for d in after_nms],
                "afterMerge": [pixel_det_json(d) for d in after_merge],
                "afterFilter": [pixel_det_json(d) for d in after_filter],
                "capped": [pixel_det_json(d) for d in capped],
            },
        },
    )


def gen_tiling() -> None:
    """plan_inference_tiles / whole_page_tile / remap_rect_to_page."""
    plans = []
    for width, height, tile, overlap in [
        (1800, 1400, 1024, 128),
        (4000, 3000, 1024, 128),
        (800, 600, 1024, 128),
        (1025, 1024, 1024, 0),
    ]:
        tiles = tiling_mod.plan_inference_tiles(width, height, tile_size=tile, overlap=overlap)
        plans.append(
            {
                "input": {"width": width, "height": height, "tileSize": tile, "overlap": overlap},
                "expected": [
                    {"tileId": t.tile_id, "x0": t.x0, "y0": t.y0, "x1": t.x1, "y1": t.y1} for t in tiles
                ],
            }
        )
    tile = tiling_mod.InferenceTile(3, 896, 776, 1800, 1400)
    remaps = []
    for rect in [(10.5, 20.25, 300.75, 400.5), (-5.0, -7.0, 2000.0, 900.0)]:
        mapped = tiling_mod.remap_rect_to_page(rect, tile, page_width=1800, page_height=1400)
        remaps.append({"input": {"rect": list(rect)}, "expected": list(mapped)})
    whole = tiling_mod.whole_page_tile(640, 480)
    dump(
        "tiling.json",
        {
            "case": "plan_inference_tiles + remap_rect_to_page + whole_page_tile",
            "input": {"tileForRemap": {"tileId": 3, "x0": 896, "y0": 776, "x1": 1800, "y1": 1400}},
            "params": {},
            "expected": {
                "plans": plans,
                "remaps": remaps,
                "wholePage": {
                    "tileId": whole.tile_id,
                    "x0": whole.x0,
                    "y0": whole.y0,
                    "x1": whole.x1,
                    "y1": whole.y1,
                },
            },
        },
    )


def gen_manifest_params() -> None:
    """manifest_params + resolve_inference_mode на трёх манифестах."""
    manifests = {
        "full": {
            "manifest_version": 2,
            "num_classes": 3,
            "resolution": 560,
            "class_mapping": CLASS_MAPPING,
            "preprocessing": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225], "input_name": "input"},
            "box_format": "cxcywh_normalized",
            "score_activation": "sigmoid",
            "num_select": 200,
            "dynamic_batch": True,
            "tiling": {"tile_size": 768, "overlap": 96, "mode": "whole_page_and_tiles", "min_visibility": 0.3},
        },
        "legacy_minimal": {
            "num_classes": 3,
            "resolution": 640,
            "class_mapping": CLASS_MAPPING,
            "preprocessing": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
        },
        "garbage_mode": {
            "num_classes": 3,
            "resolution": 512,
            "class_mapping": CLASS_MAPPING,
            "preprocessing": {"mean": [0.5, 0.5, 0.5], "std": [0.25, 0.25, 0.25]},
            "tiling": {"tile_size": 512, "overlap": 64, "mode": "мусор"},
        },
    }
    expected = {}
    for name, manifest in manifests.items():
        model = SimpleNamespace(
            manifest=manifest,
            resolution=manifest["resolution"],
            class_mapping=manifest["class_mapping"],
        )
        params = mp.manifest_params(
            model,
            default_tile_size=mp.DEFAULT_TILE_SIZE,
            default_overlap=mp.DEFAULT_OVERLAP,
            default_activation="sigmoid",
            default_num_select=mp.DEFAULT_NUM_SELECT,
        )
        resolved = mp.resolve_inference_mode("auto", params.training_mode)
        expected[name] = {
            "mean": params.mean,
            "std": params.std,
            "inputName": params.input_name,
            "boxFormat": params.box_format,
            "activation": params.activation,
            "numSelect": params.num_select,
            "tileSize": params.tile_size,
            "overlap": params.overlap,
            "resolution": params.resolution,
            "dynamicBatch": params.dynamic_batch,
            "trainingMode": params.training_mode,
            "minVisibility": params.min_visibility,
            "resolvedAuto": {"mode": resolved.mode, "source": resolved.source},
        }
    dump(
        "manifest_params.json",
        {
            "case": "manifest_params + resolve_inference_mode(auto)",
            "input": {"manifests": manifests},
            "params": {},
            "expected": expected,
        },
    )


def gen_page_pipeline() -> None:
    """Полный числовой путь страницы: decode_tile × 4 → remap → NMS → merge → пороги → cap.

    Повторяет построчно числовую часть service._run_page (без PIL/сессии):
    floor = min(default, *пороги); reject_full_tile_types={text} при >1 плитки;
    масштаб нормализованных боксов плитки на РЕАЛЬНЫЕ размеры плитки; финальные
    coords_norm — деление пиксельных координат на размеры страницы с клампом.
    """
    rng = np.random.default_rng(4242)
    page_w, page_h = 1800, 1400
    tile_size, overlap = 1024, 128
    tiles = tiling_mod.plan_inference_tiles(page_w, page_h, tile_size=tile_size, overlap=overlap)
    assert len(tiles) == 4

    thresholds = {BlockType.TEXT: 0.5, BlockType.IMAGE: 0.6}
    default_threshold = 0.4
    nms_iou = 0.5
    max_detections = 10
    resolution = 560
    num_select = 30
    floor = min([default_threshold, *thresholds.values()])
    reject = frozenset({BlockType.TEXT}) if len(tiles) > 1 else frozenset()

    tile_inputs = []
    pixel_dets = []
    for tile in tiles:
        q = 8
        logits = rng.normal(-1.0, 2.0, size=(q, 4))
        boxes = np.stack(
            [
                rng.uniform(0.1, 0.9, size=q),
                rng.uniform(0.1, 0.9, size=q),
                rng.uniform(0.05, 0.5, size=q),
                rng.uniform(0.05, 0.5, size=q),
            ],
            axis=-1,
        )
        # На каждой плитке гарантируем по уверенному кандидату каждого типа.
        logits[0] = [3.0, -4.0, -4.0, -5.0]
        logits[1] = [-4.0, 2.5, -4.0, -5.0]
        logits[2] = [-4.0, -4.0, 2.0, -5.0]
        # И один вырожденный full-tile text (guard обязан отбросить).
        boxes[3] = [0.5, 0.5, 0.96, 0.97]
        logits[3] = [5.0, -4.0, -4.0, -5.0]
        dets_list = boxes.tolist()
        labels_list = logits.tolist()
        tile_inputs.append(
            {
                "tile": {"tileId": tile.tile_id, "x0": tile.x0, "y0": tile.y0, "x1": tile.x1, "y1": tile.y1},
                "dets": dets_list,
                "labels": labels_list,
            }
        )
        raw = pp.decode_tile(
            np.asarray(dets_list, dtype=np.float64),
            np.asarray(labels_list, dtype=np.float64),
            class_mapping=CLASS_MAPPING,
            resolution=resolution,
            activation="sigmoid",
            num_select=num_select,
            score_floor=floor,
            box_format="cxcywh_normalized",
            reject_full_tile_types=reject,
        )
        tw, th = float(tile.width), float(tile.height)
        for rd in raw:
            local = (rd.box_norm[0] * tw, rd.box_norm[1] * th, rd.box_norm[2] * tw, rd.box_norm[3] * th)
            px = tiling_mod.remap_rect_to_page(local, tile, page_width=page_w, page_height=page_h)
            pixel_dets.append(nms_mod.PixelDet(rd.block_type, px[0], px[1], px[2], px[3], rd.score))

    final = nms_mod.class_aware_nms(pixel_dets, iou_threshold=nms_iou)
    final = nms_mod.merge_split_text_boxes(final)
    final = nms_mod.filter_by_class_threshold(final, thresholds, default_threshold)
    final = nms_mod.cap_detections(final, max_detections)
    candidates = [
        {
            "blockType": d.block_type.value,
            "coordsNorm": [
                min(1.0, max(0.0, d.x0 / page_w)),
                min(1.0, max(0.0, d.y0 / page_h)),
                min(1.0, max(0.0, d.x1 / page_w)),
                min(1.0, max(0.0, d.y1 / page_h)),
            ],
            "score": d.score,
        }
        for d in final
    ]
    dump(
        "page_pipeline.json",
        {
            "case": "страница 1800x1400 из 4 тайлов 1024/128: decode → remap → NMS → merge → пороги → cap",
            "input": {"pageWidth": page_w, "pageHeight": page_h, "tiles": tile_inputs},
            "params": {
                "resolution": resolution,
                "activation": "sigmoid",
                "boxFormat": "cxcywh_normalized",
                "numSelect": num_select,
                "tileSize": tile_size,
                "overlap": overlap,
                "thresholds": {"text": 0.5, "image": 0.6},
                "defaultThreshold": default_threshold,
                "nmsIou": nms_iou,
                "mergeSplitText": True,
                "maxDetections": max_detections,
            },
            "expected": {"candidates": candidates},
        },
    )


def main() -> None:
    gen_decode_tile_sigmoid()
    gen_decode_tile_softmax_guard()
    gen_nms_merge_filter_cap()
    gen_tiling()
    gen_manifest_params()
    gen_page_pipeline()


if __name__ == "__main__":
    main()
