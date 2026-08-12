"""Repack potion-base-8M into the @jigyasudham/veto-model package payload.

Condition #6: the upstream HF revision is pinned by full commit hash.
Condition #7: this pipeline is repo-tracked so the published artifact is
reproducible from source.

Output (into <package>/model/):
  embeddings.int8.bin  row-major int8, vocab_size x dim
  scales.f32.bin       one float32 scale per row (little-endian)
  tokenizer.json       copied verbatim from the pinned revision
  model.json           header: dims, revision, quantization, sha256s
  golden.json          fixed sentences + expected vectors, for the JS port

Usage:
  python repack-model.py [--out "D:\\Veto Model"]

Run with the prototype venv, which already has model2vec + huggingface_hub:
  "D:\\Veto Model\\prototype\\.venv\\Scripts\\python.exe" repack-model.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

MODEL_ID = "minishlab/potion-base-8M"
# Pinned by full commit hash — short forms are ambiguous and npm immutability
# is worthless if the input can move under us.
REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"

EXPECTED_VOCAB = 29528
EXPECTED_DIM = 256

# Fixed forever once published: the JS port is asserted byte-close against
# these. Chosen to exercise casing, punctuation, unicode, code-shaped text,
# the empty string (no tokens -> zero vector), and a long multi-sentence run.
GOLDEN_SENTENCES = [
    "",
    "hello world",
    "Hello World",
    "The npm publish failed with a 404.",
    "src/transcripts/embed.ts",
    "SQLITE_RANGE: column index out of range",
    "café naïve résumé",
    "  leading and trailing whitespace  ",
    "Punctuation, semicolons; and (parentheses) -- plus dashes.",
    "MixedCASE camelCaseIdentifier snake_case_name",
    "1234567890 42 3.14159",
    "a",
    "\u4e2d\u6587\u6d4b\u8bd5",
    "emoji \U0001f600 in text",
    ("A longer passage that spans several sentences. It exists to exercise "
     "mean pooling over many tokens, where a single distinctive clause is "
     "diluted by surrounding text. That dilution is the whole reason chunked "
     "indexing was adopted for the semantic layer."),
]


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def quantize_rows(emb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row symmetric int8. Each row carries its own scale, so a row is
    dequantized as q * scale at lookup time, before pooling."""
    scale = np.abs(emb).max(axis=1) / 127.0
    scale[scale == 0] = 1.0
    q = np.clip(np.round(emb / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale.astype(np.float32)


def reference_embed(ids: list[int], q: np.ndarray, scale: np.ndarray) -> np.ndarray:
    """The exact algorithm embed.ts must reproduce, computed from the SHIPPED
    int8 artifact — not from the float32 original.

    Mirrors model2vec StaticModel: gather rows, mean-pool, L2-normalize with
    a 1e-32 epsilon. No special tokens, no per-token weights (asserted below).
    """
    dim = q.shape[1]
    if not ids:
        return np.zeros(dim, dtype=np.float32)
    rows = q[ids].astype(np.float32) * scale[ids][:, None]
    pooled = rows.mean(axis=0)
    return pooled / (np.linalg.norm(pooled) + 1e-32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"D:\Veto Model",
                    help="package root; payload is written to <out>/model/")
    args = ap.parse_args()

    from huggingface_hub import snapshot_download
    from model2vec import StaticModel

    # from_pretrained() has no `revision` parameter, so pin here and load
    # from the resolved local path.
    local = Path(snapshot_download(MODEL_ID, revision=REVISION))
    print(f"snapshot: {local}")

    model = StaticModel.from_pretrained(str(local))
    emb = np.asarray(model.embedding, dtype=np.float32)

    # Assumptions the JS port is built on. Any of these flipping means the
    # port is silently wrong, so fail loudly at repack time instead.
    assert model.weights is None, (
        "model ships per-token weights; embed.ts mean-pools without them "
        "(model2vec model.py:421). Port must be updated before shipping.")
    assert getattr(model, "token_mapping", None) is None, (
        "model uses vocabulary quantization / token remapping; embed.ts "
        "indexes the table directly.")
    assert model.normalize, "model does not normalize; embed.ts assumes it does"
    assert emb.shape == (EXPECTED_VOCAB, EXPECTED_DIM), f"unexpected shape {emb.shape}"

    q, scale = quantize_rows(emb)

    out_root = Path(args.out)
    out = out_root / "model"
    out.mkdir(parents=True, exist_ok=True)

    (out / "embeddings.int8.bin").write_bytes(q.tobytes(order="C"))
    (out / "scales.f32.bin").write_bytes(scale.astype("<f4").tobytes())
    shutil.copyfile(local / "tokenizer.json", out / "tokenizer.json")

    # Fidelity of the shipped artifact vs the float32 original.
    deq = q.astype(np.float32) * scale[:, None]
    row_drift = 1.0 - np.sum(
        (emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-32)) *
        (deq / (np.linalg.norm(deq, axis=1, keepdims=True) + 1e-32)), axis=1)

    # Golden vectors: what embed.ts must reproduce, plus the float32 reference
    # so quantization drift stays visible and separable from port bugs.
    ids_list = model.tokenize(sentences=GOLDEN_SENTENCES)
    golden = []
    worst = 0.0
    worst_cos = 0.0
    for sent, ids in zip(GOLDEN_SENTENCES, ids_list):
        expected = reference_embed(list(ids), q, scale)
        ref = np.asarray(model.encode([sent]), dtype=np.float32)[0]
        n = np.linalg.norm(ref)
        ref_unit = ref / n if n else ref
        drift = float(np.abs(expected - ref_unit).max())
        # Cosine drift is the retrieval-relevant number and the one comparable
        # to the prototype's 1.1e-4; component diff is reported alongside
        # because a large component move with a tiny angle change is harmless.
        cos_drift = 0.0 if not ids else float(1.0 - np.dot(expected, ref_unit))
        worst = max(worst, drift)
        worst_cos = max(worst_cos, cos_drift)
        golden.append({
            "text": sent,
            "token_ids": [int(i) for i in ids],
            "expected": [round(float(x), 8) for x in expected],
            "reference_f32_max_abs_diff": round(drift, 10),
            "reference_f32_cosine_drift": round(cos_drift, 12),
        })

    tok = json.loads((out / "tokenizer.json").read_text(encoding="utf-8"))
    header = {
        "format": "veto-model/1",
        "upstream": {
            "model_id": MODEL_ID,
            "revision": REVISION,
            "license": "MIT",
            "distilled_from": "baai/bge-base-en-v1.5",
        },
        "vocab_size": int(emb.shape[0]),
        "dim": int(emb.shape[1]),
        "quantization": {
            "dtype": "int8",
            "scheme": "per-row symmetric",
            "scales": "scales.f32.bin (little-endian float32, one per row)",
            "dequantize": "row_f32 = int8_row * scale[row]",
        },
        "inference": {
            "add_special_tokens": False,
            "pooling": "mean",
            "normalize": True,
            "normalize_epsilon": 1e-32,
            "empty_input": "zero vector of length dim",
            "per_token_weights": None,
        },
        "tokenizer": {
            "file": "tokenizer.json",
            "model_type": tok.get("model", {}).get("type"),
            # embed.ts must reproduce this chain exactly — the normalizer
            # flags (lowercasing, accent stripping, CJK spacing) are where a
            # hand-port silently diverges, not WordPiece itself.
            "normalizer": tok.get("normalizer"),
            "pre_tokenizer": tok.get("pre_tokenizer"),
            # HF BertNormalizer: strip_accents=null does NOT mean "off" — it
            # follows `lowercase`. Verified 2026-08-11: 'café' and 'cafe' both
            # tokenize to id 6674. A port that reads the null literally and
            # skips accent stripping diverges silently on accented text.
            "strip_accents_effective": bool(
                (tok.get("normalizer") or {}).get("lowercase", False)
                if (tok.get("normalizer") or {}).get("strip_accents") is None
                else (tok.get("normalizer") or {}).get("strip_accents")),
            "unk_token": tok.get("model", {}).get("unk_token"),
            "continuing_subword_prefix": tok.get("model", {}).get("continuing_subword_prefix"),
            "max_input_chars_per_word": tok.get("model", {}).get("max_input_chars_per_word"),
        },
        "files": {
            "embeddings.int8.bin": sha256_file(out / "embeddings.int8.bin"),
            "scales.f32.bin": sha256_file(out / "scales.f32.bin"),
            "tokenizer.json": sha256_file(out / "tokenizer.json"),
        },
        "repacked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repacked_by": "scripts/repack-model.py",
    }
    (out / "model.json").write_text(json.dumps(header, indent=2) + "\n", encoding="utf-8")
    (out / "golden.json").write_text(
        json.dumps({"model_revision": REVISION, "count": len(golden),
                    "vectors": golden}, indent=2) + "\n", encoding="utf-8")

    total = sum(f.stat().st_size for f in out.iterdir())
    print(f"\nvocab {emb.shape[0]} x dim {emb.shape[1]}")
    print(f"int8 quantization drift: max {row_drift.max():.2e}, mean {row_drift.mean():.2e}")
    print(f"golden vs float32: max cosine drift {worst_cos:.2e}, "
          f"max component diff {worst:.2e}")
    print(f"tokenizer: {header['tokenizer']['model_type']} + "
          f"{(header['tokenizer']['normalizer'] or {}).get('type')} + "
          f"{(header['tokenizer']['pre_tokenizer'] or {}).get('type')}")
    print(f"  normalizer config: "
          f"{ {k: v for k, v in (header['tokenizer']['normalizer'] or {}).items() if k != 'type'} }")
    print()
    for f in sorted(out.iterdir()):
        print(f"  {f.stat().st_size:>10,}  {f.name}")
    print(f"  {total:>10,}  TOTAL ({total/1024/1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
