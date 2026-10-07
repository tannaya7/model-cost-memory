"""Cheapest model that passes, per job.

Weights runs by freshness, drops RETIRED models, refuses below the evidence floor
(INSUFFICIENT_EVIDENCE), and picks the lowest cost per successful run within tolerance of the
best pass rate. Returns the failing run ids with every verdict. Week 7.
"""
