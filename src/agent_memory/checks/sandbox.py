"""SandboxRunner: runs a test command in a throwaway container. A LATER job type, not in v1.

The first job type is document extraction, which never executes AI-written code. If a code-generation
job type is added, the runner must live outside the API image with no Docker socket in it: no network,
read-only base image, CPU/memory/time limits, removed afterwards. Code that exceeds its limits is a
FAIL; a sandbox that cannot start is UNKNOWN, never PASS.
"""
