"""Append-only audit service.

Modules:
  canonical: deterministic JSON encoding and strict parsing
  store:     sqlite3-backed append-only log, hash chain and snapshots
  replay:    deterministic state reduction
  main:      FastAPI application
"""
