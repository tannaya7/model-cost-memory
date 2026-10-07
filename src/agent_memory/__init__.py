"""Model & Cost Memory: a long-term memory of an AI system's own performance.

Records every production model run with its cost and a machine-checked outcome, then answers:
which model is the cheapest that still does each job properly, and did the last model upgrade
quietly break something. See docs/ARCHITECTURE.md.
"""

__version__ = "0.0.1"
