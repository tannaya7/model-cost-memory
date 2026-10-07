"""The OutcomeChecker interface every check kind implements."""

from abc import ABC, abstractmethod
from enum import Enum


class Outcome(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"


class OutcomeChecker(ABC):
    @abstractmethod
    def check(self, run: object) -> Outcome:
        """Return PASS or FAIL, or UNKNOWN when the check cannot run."""
