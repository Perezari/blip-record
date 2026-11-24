#!/usr/bin/env python3
"""Verify a Blip ledger export (``ledger.jsonl``) — standard library only (spec: docs/DESIGN.md §7.5 M3, §7.8).

Usage:
    python verify_ledger.py ledger.jsonl
    python verify_ledger.py https://<account>.github.io/blip-record/ledger.jsonl
    python verify_ledger.py ledger.jsonl --head 1234 <hash>     # also check against a published head
    python verify_ledger.py ledger.jsonl --signals signals.json  # also check the published results
    python verify_ledger.py ledger.jsonl --max-open-days 120     # fail on long-unrevealed public commits

Each line is ``{"seq", "ts_ms", "kind", "body", "prev_hash", "hash"}`` where ``body`` is the exact canonical
JSON string that was hashed (an embedded JSON object is accepted too and re-canonicalised).

Checks (same as ``blip.store.ledger.verify``):
  * seq is contiguous from 1; every ``prev_hash`` equals the previous row's ``hash`` (genesis = 64 zeros);
  * ``hash == sha256(prev_hash + body)``; bodies are canonical JSON
    (``json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)``); row kind == body kind;
  * one COMMIT per ref; EVENT_COMMIT ``n`` runs 1, 2, 3… after the COMMIT;
  * every REVEAL: ``sha256(salt + canonical(signal))`` equals its COMMIT's commitment, visibility matches,
    each revealed event matches its EVENT_COMMIT (same salt), the event count matches, and each
    ``event_id == sha256(f"{signal_id}|{kind}|{bar_open_ms}|{n}")[:20]``;
  * no EVENT_COMMIT is left unrevealed after the last REVEAL of its ref;
  * public numbering: each public REVEAL has a valid ``public_no``, no number is revealed twice, and the
    k-th public COMMIT reveals number k (a hidden public trade leaves a gap only an unrevealed public
    COMMIT can explain). Unrevealed public commitments (open trades) are counted with the oldest age;
    ``--max-open-days N`` fails when one is older than N days;
  * ``--signals``: every revealed public signal is listed in signals.json, and each listed closed signal
    shows the revealed ``public_no``, terminal state and ``result_r`` (= ``r`` of its revealed CLOSED/VOID/
    EXPIRED event).

Exit status: 0 = valid, 1 = verification errors, 2 = could not read the input.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request

GENESIS = "0" * 64


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def commitment(salt_hex, body):
    return hashlib.sha256((salt_hex + canonical(body)).encode()).hexdigest()


def chain_hash(prev_hex, body_str):
    return hashlib.sha256((prev_hex + body_str).encode()).hexdigest()


def event_id_for(signal_id, kind, bar_open_ms, seq):
    return hashlib.sha256(f"{signal_id}|{kind}|{int(bar_open_ms)}|{int(seq)}".encode()).hexdigest()[:20]


def verify(rows, start_prev_hash=None, max_open_ms=None, now_ms=None):
    """Return a list of error strings (empty = valid)."""
    errors = []
    prev = start_prev_hash
    expect_seq = None
    commits = {}
    ev_commits = {}
    revealed_n = {}
    full = start_prev_hash is None          # ordinal public_no check needs the ledger from seq 1
    pub_ordinal = {}                        # ref -> 1-based position among public COMMITs
    pub_commit_at = {}                      # ref -> (seq, ts_ms) of its public COMMIT
    no_owner = {}                           # revealed public_no -> ref
    last_ts = None
    for idx, row in enumerate(rows):
        try:
            seq = int(row["seq"])
            kind = row["kind"]
            raw = row["body"]
            body_str = raw if isinstance(raw, str) else canonical(raw)
            body = json.loads(body_str)
        except Exception as e:
            errors.append(f"row {idx}: malformed ({type(e).__name__}: {e})")
            continue
        tag = f"seq {seq}"
        if isinstance(row.get("ts_ms"), int):
            last_ts = row["ts_ms"] if last_ts is None else max(last_ts, row["ts_ms"])
        if expect_seq is None:
            if prev is None:
                if seq != 1:
                    errors.append(f"{tag}: ledger must start at seq 1 (or pass start_prev_hash)")
                prev = GENESIS
        elif seq != expect_seq:
            errors.append(f"{tag}: expected seq {expect_seq}")
        expect_seq = seq + 1
        if row.get("prev_hash") != prev:
            errors.append(f"{tag}: prev_hash mismatch")
        if canonical(body) != body_str:
            errors.append(f"{tag}: body is not canonical JSON")
        if chain_hash(str(row.get("prev_hash")), body_str) != row.get("hash"):
            errors.append(f"{tag}: hash mismatch")
        prev = row.get("hash")
        if not isinstance(body, dict) or body.get("kind") != kind:
            errors.append(f"{tag}: row kind {kind!r} != body kind")
            continue
        ref = body.get("ref")
        if kind == "COMMIT":
            if ref in commits:
                errors.append(f"{tag}: duplicate COMMIT for ref {ref}")
                continue
            commits[ref] = body
            ev_commits[ref] = []
            if body.get("vis") == "public":
                pub_ordinal[ref] = len(pub_ordinal) + 1
                pub_commit_at[ref] = (seq, body.get("ts_ms"))
        elif kind == "EVENT_COMMIT":
            if ref not in commits:
                errors.append(f"{tag}: EVENT_COMMIT for unknown ref {ref}")
                continue
            lst = ev_commits[ref]
            if body.get("n") != len(lst) + 1:
                errors.append(f"{tag}: EVENT_COMMIT n={body.get('n')} for ref {ref}, expected {len(lst) + 1}")
            lst.append(body.get("commitment"))
        elif kind == "REVEAL":
            if ref not in commits:
                errors.append(f"{tag}: REVEAL for unknown ref {ref}")
                continue
            c = commits[ref]
            salt = body.get("salt")
            sig = body.get("signal")
            evs = body.get("events")
            if not isinstance(salt, str) or not isinstance(sig, dict) or not isinstance(evs, list):
                errors.append(f"{tag}: malformed REVEAL for ref {ref}")
                continue
            if commitment(salt, sig) != c.get("commitment"):
                errors.append(f"{tag}: REVEAL of ref {ref} does not match its COMMIT")
            elif c.get("vis") == "public" and ref not in revealed_n:
                no = sig.get("public_no")
                if not isinstance(no, int) or isinstance(no, bool) or no < 1:
                    errors.append(f"{tag}: public REVEAL of ref {ref} has no valid public_no")
                elif no in no_owner:
                    errors.append(f"{tag}: public_no #{no} revealed for ref {ref} and ref {no_owner[no]}")
                else:
                    no_owner[no] = ref
                    if full and no != pub_ordinal[ref]:
                        errors.append(f"{tag}: ref {ref} reveals public_no #{no} but is public COMMIT "
                                      f"#{pub_ordinal[ref]} (public numbers follow the COMMIT order)")
            if sig.get("visibility") != c.get("vis"):
                errors.append(f"{tag}: REVEAL visibility differs from COMMIT vis for ref {ref}")
            committed = ev_commits[ref]
            if len(evs) != len(committed):
                errors.append(f"{tag}: REVEAL of ref {ref} has {len(evs)} events, {len(committed)} committed")
            for n, (ev, ch) in enumerate(zip(evs, committed), start=1):
                if not isinstance(ev, dict) or commitment(salt, ev) != ch:
                    errors.append(f"{tag}: event {n} of ref {ref} does not match its EVENT_COMMIT")
                    continue
                want = event_id_for(str(sig.get("signal_id")), str(ev.get("kind")), ev.get("bar_open_ms") or 0, n)
                if ev.get("event_id") != want:
                    errors.append(f"{tag}: event {n} of ref {ref} has a wrong event_id")
            revealed_n[ref] = len(committed)
        elif kind == "NOTICE":
            pass
        else:
            errors.append(f"{tag}: unknown kind {kind!r}")
    for ref, n in revealed_n.items():
        if len(ev_commits.get(ref, [])) > n:
            errors.append(f"ref {ref}: EVENT_COMMIT after its last REVEAL is never revealed")
    if max_open_ms is not None:
        ref_now = now_ms if now_ms is not None else last_ts
        for ref, (cseq, cts) in pub_commit_at.items():
            if ref in revealed_n or ref_now is None or not isinstance(cts, int):
                continue
            if ref_now - cts > max_open_ms:
                errors.append(f"ref {ref}: public COMMIT (seq {cseq}) unrevealed for "
                              f"{(ref_now - cts) / 86_400_000:.1f} days (limit {max_open_ms / 86_400_000:g})")
    return errors


def open_public_commits(rows):
    """Public COMMITs that have no REVEAL yet: ``[{"ref", "seq", "ts_ms"}]`` in ledger order. Open public
    trades are legitimate, but a commitment that is never revealed hides a trade from the record."""
    commits = {}
    revealed = set()
    for row in rows:
        try:
            raw = row["body"]
            body = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except Exception:
            continue
        if not isinstance(body, dict):
            continue
        if body.get("kind") == "COMMIT" and body.get("vis") == "public" and body.get("ref") not in commits:
            commits[body.get("ref")] = {"ref": body.get("ref"), "seq": row.get("seq"), "ts_ms": body.get("ts_ms")}
        elif body.get("kind") == "REVEAL":
            revealed.add(body.get("ref"))
    return [c for ref, c in commits.items() if ref not in revealed]


_TERMINAL_EVENT_KINDS = ("CLOSED", "VOID", "EXPIRED")


def check_published(rows, published):
    """Cross-check a published ``signals.json`` (dict with ``signals``, or a list of entries) against the
    revealed ledger: every revealed public signal is listed; a listed revealed signal has a REVEAL; its
    ``no`` equals the revealed ``public_no``; ``status`` and ``result_r`` equal the revealed terminal
    event (kind, ``r``). Returns error strings."""
    reveals = {}
    for row in rows:
        try:
            raw = row["body"]
            body = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except Exception:
            continue
        if isinstance(body, dict) and body.get("kind") == "REVEAL" and isinstance(body.get("signal"), dict):
            reveals[body.get("ref")] = body
    entries = published.get("signals") if isinstance(published, dict) else published
    if not isinstance(entries, list):
        return ["published signals: expected a list of signal entries"]
    errors = []
    listed = set()
    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            errors.append(f"published signal {i}: not an object")
            continue
        ref = e.get("ledger_ref")
        listed.add(ref)
        rv = reveals.get(ref)
        label = f"published #{e.get('no')} (ref {ref})"
        if rv is None:
            if e.get("revealed") or e.get("result_r") is not None:
                errors.append(f"{label}: shown as closed but the ledger has no REVEAL for it")
            continue
        sig = rv["signal"]
        if e.get("no") != sig.get("public_no"):
            errors.append(f"{label}: number differs from the revealed public_no {sig.get('public_no')}")
        evs = [x for x in (rv.get("events") or []) if isinstance(x, dict)]
        term = [x for x in evs if x.get("kind") in _TERMINAL_EVENT_KINDS]
        if not term:
            continue
        last = term[-1]
        status = e.get("status")
        if status is not None and str(status).upper() != last.get("kind"):
            errors.append(f"{label}: status {status} but the revealed terminal event is {last.get('kind')}")
        pub_r, ev_r = e.get("result_r"), last.get("r")
        try:
            diff = abs(float(pub_r or 0.0) - float(ev_r or 0.0))
        except (TypeError, ValueError):
            diff = float("inf")
        if diff > 1e-4:
            errors.append(f"{label}: result_r {pub_r} but the revealed {last.get('kind')} event has r={ev_r}")
    for ref, rv in reveals.items():
        sig = rv["signal"]
        if sig.get("visibility") == "public" and ref not in listed:
            errors.append(f"revealed public signal #{sig.get('public_no')} (ref {ref}) is missing from the "
                          f"published signals")
    return errors


def read_text(src):
    if src.startswith(("http://", "https://")):
        req = urllib.request.Request(src, headers={"User-Agent": "blip-verify-ledger/1"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode("utf-8")
    if src == "-":
        return sys.stdin.read()
    with open(src, encoding="utf-8") as fh:
        return fh.read()


def parse_jsonl(text):
    rows = []
    for n, line in enumerate(text.splitlines(), start=1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"line {n}: invalid JSON ({e})") from None
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="Verify a Blip hash-chained commit-reveal ledger (ledger.jsonl).")
    ap.add_argument("source", help="path, URL or - for stdin")
    ap.add_argument("--head", nargs=2, metavar=("SEQ", "HASH"), help="also require this published head row")
    ap.add_argument("--signals", metavar="SIGNALS_JSON",
                    help="also check a published signals.json (path or URL) against the revealed ledger")
    ap.add_argument("--max-open-days", type=float, metavar="N",
                    help="fail when a public commitment stays unrevealed for more than N days")
    ap.add_argument("--now-ms", type=int, help=argparse.SUPPRESS)
    ap.add_argument("-q", "--quiet", action="store_true", help="print errors only")
    args = ap.parse_args(argv)
    try:
        rows = parse_jsonl(read_text(args.source))
        published = json.loads(read_text(args.signals)) if args.signals else None
    except Exception as e:
        print(f"error: cannot read input: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    now_ms = args.now_ms if args.now_ms is not None else int(time.time() * 1000)
    max_open_ms = None if args.max_open_days is None else int(args.max_open_days * 86_400_000)
    errors = verify(rows, max_open_ms=max_open_ms, now_ms=now_ms)
    if published is not None:
        errors += check_published(rows, published)
    if args.head:
        seq, h = int(args.head[0]), args.head[1].lower()
        match = [r for r in rows if int(r.get("seq", -1)) == seq]
        if not match or match[0].get("hash") != h:
            errors.append(f"published head seq {seq} hash {h} not found in the ledger")
    for e in errors:
        print(f"FAIL: {e}")
    if errors:
        print(f"{len(errors)} error(s) in {len(rows)} row(s)", file=sys.stderr)
        return 1
    if not args.quiet:
        counts = {}
        for r in rows:
            counts[r["kind"]] = counts.get(r["kind"], 0) + 1
        head = (rows[-1]["seq"], rows[-1]["hash"]) if rows else (0, GENESIS)
        summary = ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "empty"
        print(f"OK: {len(rows)} rows ({summary}); head {head[0]} {head[1]}")
        unrevealed = open_public_commits(rows)
        if unrevealed:
            ts = [c["ts_ms"] for c in unrevealed if isinstance(c["ts_ms"], int)]
            age = f"; oldest {(now_ms - min(ts)) / 86_400_000:.1f} days (seq {unrevealed[0]['seq']})" if ts else ""
            print(f"{len(unrevealed)} public commitment(s) not revealed yet (open trades){age}")
        if published is not None:
            print("published signals match the revealed ledger")
    return 0


if __name__ == "__main__":
    sys.exit(main())
