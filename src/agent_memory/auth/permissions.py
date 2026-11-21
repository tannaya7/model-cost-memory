"""Who may do what: the one permission table, for companies and for projects.

Two scopes, each with its own permissions:

- **Organisation (company) scope:** people, invites, roles, the audit trail, leaving, deleting the company.
- **Project scope:** reading numbers, reading prompt and answer text, recording data, re-tests, usage limits, the stored
  provider key, settings (webhook, retention), pay mode and budget, project keys, creating and deleting projects, exports.

A person's role in a company applies to every project of that company. There are no per-project roles yet, so a project
role is the company role. A personal project's owner has the owner role in it. A project key (used by SDKs and scripts)
and the public demo are not people: they get fixed, smaller sets of project permissions below.

Every permission names the lowest role that has it; roles are ordered viewer < member < admin < owner, so a higher role
always has everything a lower one has, and a lower role never gets something by implication. Anything not listed is denied.
Nothing here is decided in the browser: `current_project` and the company routes check this table on the server.

Not in scope, deferred pending legal review: any view of one person's own spend or usage inside a company.
"""

from __future__ import annotations

ROLES = ("viewer", "member", "admin", "owner")
ROLE_RANK = {role: i for i, role in enumerate(ROLES)}

PROJECT_PERMISSIONS: dict[str, tuple[str, str]] = {
    # permission: (lowest role, what it means)
    "metrics.view": ("viewer", "See spend, tokens, quality figures, recommendations, alerts and notices"),
    "billing.view": ("viewer", "See the pay mode and monthly budget figures the dashboards are drawn from"),
    "content.view": ("member", "Read prompt and answer text, tool calls and stored examples"),
    "data.write": ("member", "Record runs, define and edit tasks, label runs, resolve alerts, refresh news"),
    "retest.start": ("admin", "Start a trial on another model, which spends the company's own provider budget"),
    "limits.change": ("admin", "Add, change or remove usage limits"),
    "providerkey.change": ("admin", "Store or remove the provider key used for trials"),
    "settings.view": ("admin", "See webhook address and secret, key prefix and the settings page"),
    "settings.change": ("admin", "Change webhook, retention, tool-argument storage, AI-summary consent"),
    "billing.change": ("admin", "Change the pay mode and the monthly budget"),
    "keys.rotate": ("admin", "Replace the project key (the old one stops working at once)"),
    "project.create": ("admin", "Create a project in the company"),
    "project.delete": ("admin", "Delete a project and everything recorded in it"),
    "export.run": ("admin", "Export data. No export exists yet; this is reserved so one cannot be added open"),
}

ORG_PERMISSIONS: dict[str, tuple[str, str]] = {
    "overview.view": ("viewer", "See counts, tokens and list-price cost across the company's projects you may open (no text, no people)"),
    "notice.view": ("viewer", "Read the company's privacy notice and your own role and notice state"),
    "notice.acknowledge": ("viewer", "Record that you were shown the current privacy notice (for yourself only)"),
    "profile.edit_own": ("viewer", "Set or clear your own optional job role"),
    "notice.view_status": ("admin", "See how many members acknowledged the notice (a count, never names)"),
    "rollups.view": ("admin", "See how many members chose each job role, for groups of five or more only"),
    "overview.export": ("admin", "Download the company overview as a CSV file (counts, tokens and cost; never text, never people)"),
    "members.view": ("viewer", "See who is in the company and their roles"),
    "members.view_emails": ("admin", "See the members' email addresses"),
    "members.invite": ("admin", "Invite people, see and withdraw invites"),
    "members.change_role": ("admin", "Change a member's or viewer's role"),
    "members.remove": ("admin", "Remove a member or viewer"),
    "roles.grant_admin": ("owner", "Make, change or remove an admin or owner, or invite an admin"),
    "audit.view": ("admin", "Read the company's audit trail"),
    "company.leave": ("viewer", "Leave the company"),
    "company.delete": ("owner", "Delete the company (only once it has no projects)"),
}

# Not people: fixed sets. A project key can do what an SDK or script needs, and nothing that changes who may do what.
KEY_PERMISSIONS = frozenset({
    "metrics.view", "billing.view", "content.view", "data.write", "retest.start", "limits.change", "providerkey.change",
})
DEMO_PERMISSIONS = frozenset({"metrics.view", "billing.view", "content.view"})

# Project routes that need more than the default (reads: metrics.view, any other method: data.write).
ROUTE_PERMISSIONS: dict[tuple[str, str], str] = {
    ("POST", "/v1/jobs/{job}/retest"): "retest.start",
    ("POST", "/v1/jobs/{job}/retest/preview"): "retest.start",
    ("POST", "/v1/jobs/{job}/retest/{retest_id}/stop"): "retest.start",
    ("GET", "/v1/insights/export.csv"): "export.run",
    ("GET", "/v1/insights/features/export.csv"): "export.run",
    ("GET", "/v1/insights/planner/export.csv"): "export.run",
    ("PUT", "/v1/provider-key"): "providerkey.change",
    ("DELETE", "/v1/provider-key"): "providerkey.change",
    ("POST", "/v1/limits"): "limits.change",
    ("PUT", "/v1/limits/{limit_id}/used"): "limits.change",
    ("DELETE", "/v1/limits/{limit_id}"): "limits.change",
}


def lowest_role(permission: str) -> str:
    return (PROJECT_PERMISSIONS.get(permission) or ORG_PERMISSIONS[permission])[0]


def role_can(role: str | None, permission: str) -> bool:
    """Whether a role (a company role, "key" or "demo") has a permission. Unknown roles and permissions are denied."""
    if role is None:
        return False
    if role == "key":
        return permission in KEY_PERMISSIONS
    if role == "demo":
        return permission in DEMO_PERMISSIONS
    if role not in ROLE_RANK or (permission not in PROJECT_PERMISSIONS and permission not in ORG_PERMISSIONS):
        return False
    return ROLE_RANK[role] >= ROLE_RANK[lowest_role(permission)]


def required_permission(method: str, template: str | None) -> str:
    """The permission a project route needs. Deny by default: a write nobody listed needs data.write, never less."""
    if (method, template or "") in ROUTE_PERMISSIONS:
        return ROUTE_PERMISSIONS[(method, template or "")]
    return "metrics.view" if method in ("GET", "HEAD", "OPTIONS") else "data.write"


def matrix() -> dict:
    """The table as data, for the screen and the tests."""
    return {
        "roles": list(ROLES),
        "project": [{"permission": p, "means": m, "roles": [r for r in ROLES if role_can(r, p)]}
                    for p, (_, m) in PROJECT_PERMISSIONS.items()],
        "company": [{"permission": p, "means": m, "roles": [r for r in ROLES if role_can(r, p)]}
                    for p, (_, m) in ORG_PERMISSIONS.items()],
    }
