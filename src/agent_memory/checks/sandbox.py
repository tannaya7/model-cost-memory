"""SandboxRunner: runs a test command in a throwaway Docker container.

No network, read-only base image, CPU/memory/time limits, removed afterwards. Code that exceeds
its limits is a FAIL; a sandbox that cannot start is UNKNOWN, never PASS. Implemented in Week 4.
"""
