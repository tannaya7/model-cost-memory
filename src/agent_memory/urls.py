"""Outbound URLs a customer gives us: webhook URLs and re-test endpoints (`base_url`).

The server sends requests to these, so an unchecked URL lets anyone with a project make the server
call its own network: the cloud metadata service (169.254.169.254), the database, Caddy's admin port.
So a URL is refused unless every address its host resolves to is public (`ipaddress.is_global`):
no loopback, private (10/8, 172.16/12, 192.168/16), link-local, carrier-grade NAT (100.64/10),
unspecified, multicast or reserved addresses, and no IPv6 equivalents (IPv4-mapped ones included).

Checked twice: when the URL is saved (a clear 422 for the user), and again right before each use,
because a name can be re-pointed at a private address after it was saved (DNS rebinding).

`ALLOW_PRIVATE_URLS=true` turns the check off, for a development machine or a self-hosted server
that re-tests on a local Ollama. It is refused at startup on a server whose PUBLIC_URL is https.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


class UnsafeUrl(ValueError):
    """The URL points at an address the server must not call."""


async def _resolve(host: str, port: int) -> list[str]:
    """Every address `host` resolves to (replaced in tests, which have no DNS for example names)."""
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def _public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])  # drop an IPv6 zone id
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def literal_problem(url: str, *, allowed_schemes: tuple[str, ...] = ("https", "http")) -> str | None:
    """What is wrong with the URL without looking anything up, or None. Used by request validation."""
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises on a bad port
    except ValueError:
        return "is not a valid URL"
    if parts.scheme not in allowed_schemes:
        return f"must start with {' or '.join(s + '://' for s in allowed_schemes)}"
    if not parts.hostname:
        return "has no host"
    if parts.username or parts.password:
        return "must not contain a user name or password"
    host = parts.hostname
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return "points at this machine or a private network"
    try:
        if not _public(host):
            return "points at a private, loopback or reserved address"
    except ValueError:
        pass  # a name, not an address: checked when resolved
    return None


async def check_outbound(url: str, *, allow_private: bool = False) -> None:
    """Raise UnsafeUrl unless the URL is safe for the server to call now."""
    if allow_private:
        return
    problem = literal_problem(url)
    if problem:
        raise UnsafeUrl(f"The URL {problem}")
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        addresses = await _resolve(parts.hostname, port)
    except OSError as exc:
        raise UnsafeUrl(f"The host {parts.hostname} could not be found") from exc
    if not addresses:
        raise UnsafeUrl(f"The host {parts.hostname} could not be found")
    for address in addresses:
        try:
            public = _public(address)
        except ValueError:
            public = False
        if not public:
            raise UnsafeUrl(f"The host {parts.hostname} resolves to a private, loopback or reserved address")
