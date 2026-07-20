"""SQLite-backed user store for neuralgentics-web team-server (T-109).

A single file at ``~/.neuralgentics/web-users.db`` (configurable via
``AuthConfig.db_path``) holds:

  * ``users``         — username (PK), bcrypt hash, role
  * ``refresh_tokens`` — issued refresh tokens, with a revoked flag so
                          ``/auth/logout`` can invalidate them without
                          waiting for natural expiry.

On first run (empty DB) three default users are seeded with loud
warnings printed to stderr — these are dev defaults and must be changed
in any non-dev deployment.

We use the ``bcrypt`` library directly (not passlib) because passlib 1.7.4
is incompatible with bcrypt 5.x (passlib reads ``bcrypt.__about__.__version__``
which was removed in bcrypt 5.0).
"""

from __future__ import annotations

import logging
import secrets
import sqlite3
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

import bcrypt

log = logging.getLogger("neuralgentics.web.auth.users")

BCRYPT_ROUNDS = 12  # OWASP baseline as of 2024.

DEFAULT_DB_PATH = Path.home() / ".neuralgentics" / "web-users.db"

# (username, password, role)
DEFAULT_USERS: tuple[tuple[str, str, str], ...] = (
    ("admin", "admin", "admin"),
    ("operator", "operator", "operator"),
    ("viewer", "viewer", "viewer"),
)


def _hash_password(password: str) -> str:
    """Return a bcrypt hash of ``password`` (utf-8, truncated to 72 bytes)."""
    pw = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw, bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("ascii")


def _verify_password(password: str, password_hash: str) -> bool:
    """Verify ``password`` against ``password_hash`` (constant-ish time)."""
    try:
        pw = password.encode("utf-8")[:72]
        return bcrypt.checkpw(pw, password_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


@dataclass(frozen=True)
class User:
    """A loaded user record. ``password_hash`` is excluded from repr."""

    username: str
    role: str
    password_hash: str
    source: str = "local"
    """``local`` for users created by the T-109 default seeding or an
    admin's password-set CLI; ``oidc`` for users created/provisioned by
    an OIDC login. T-121 role-mapping only adjusts ``source='oidc'``
    users — the local ``admin/admin`` can't be demoted by an IdP."""

    def __repr__(self) -> str:  # pragma: no cover — cosmetic
        return f"User(username={self.username!r}, role={self.role!r}, source={self.source!r})"


def _default_db_path() -> Path:
    return DEFAULT_DB_PATH


class UserStore:
    """SQLite user store + refresh-token registry.

    The store is intentionally synchronous — SQLite is fast, the user
    table is tiny, and async wrappers (aiosqlite/SQLAlchemy) would be
    over-engineering for a v0.14.x stub.
    """

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path: Path = Path(db_path) if db_path else _default_db_path()
        # If the path resolves to a non-default location, the parent dir
        # may not exist yet. _conn() creates it on first connect, but
        # tests sometimes inspect the file path before connecting.
        self._lock = threading.Lock()
        self._init_schema()
        self._maybe_seed_defaults()

    # ----- schema ---------------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._lock, self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username        TEXT PRIMARY KEY,
                    password_hash   TEXT NOT NULL,
                    role            TEXT NOT NULL,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token           TEXT PRIMARY KEY,
                    username        TEXT NOT NULL,
                    issued_at       INTEGER NOT NULL,
                    expires_at       INTEGER NOT NULL,
                    revoked         INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (username) REFERENCES users(username)
                );

                CREATE INDEX IF NOT EXISTS idx_refresh_username
                    ON refresh_tokens(username);

                -- T-112: OIDC provider links. A user may have links to
                -- multiple providers (e.g. github + google). The pair
                -- (provider, provider_user_id) is unique so the same IdP
                -- account can't be linked to two local users.
                CREATE TABLE IF NOT EXISTS user_oauth_links (
                    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                    username            TEXT NOT NULL,
                    provider            TEXT NOT NULL,
                    provider_user_id    TEXT NOT NULL,
                    access_token        TEXT,
                    refresh_token       TEXT,
                    expires_at          INTEGER,
                    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (username) REFERENCES users(username),
                    UNIQUE (provider, provider_user_id)
                );

                CREATE INDEX IF NOT EXISTS idx_oauth_username
                    ON user_oauth_links(username);
                CREATE INDEX IF NOT EXISTS idx_oauth_provider
                    ON user_oauth_links(provider, provider_user_id);
                """
            )
            # T-121: add the ``source`` column to the users table. Existing
            # DBs (created by T-109 / T-112) don't have it; the ALTER is
            # idempotent because we check PRAGMA table_info first. Local
            # users (including the seeded defaults) keep 'local'; OIDC
            # users created by T-112 had no source recorded and are
            # backfilled to 'oidc' (they were created by OIDC login, so
            # role-mapping applies to them — see T-121 admin-override rule).
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
            if "source" not in cols:
                conn.execute("ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'")
                # Backfill: any user with an OAuth link is an OIDC user.
                conn.execute(
                    "UPDATE users SET source = 'oidc' WHERE username IN "
                    "(SELECT DISTINCT username FROM user_oauth_links)"
                )
            # T-122: add the ``revoked_at`` column to user_oauth_links.
            # Existing DBs (created by T-112 / T-121) don't have it; the
            # ALTER is idempotent. NULL = active; a timestamp = the link
            # was marked revoked (refresh failed / user revoked access on
            # the IdP side) and the user must re-login before the access
            # token is trusted again.
            link_cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(user_oauth_links)").fetchall()
            }
            if "revoked_at" not in link_cols:
                conn.execute("ALTER TABLE user_oauth_links ADD COLUMN revoked_at TEXT")
            # Index for the background refresher's "find expiring rows" query.
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_oauth_expires_at "
                "ON user_oauth_links(expires_at) WHERE revoked_at IS NULL"
            )
            conn.commit()

    def _maybe_seed_defaults(self) -> None:
        with self._lock, self._conn() as conn:
            cur = conn.execute("SELECT COUNT(*) AS n FROM users")
            n = cur.fetchone()["n"]
            if n > 0:
                return
            print(
                "WARNING: neuralgentics-web — seeding 3 default users "
                "(admin/admin, operator/operator, viewer/viewer). "
                "CHANGE THESE PASSWORDS in any non-dev deployment. "
                "Use `python -m neuralgentics.web.auth.users set-password <user>`.",
                file=sys.stderr,
            )
            for username, password, role in DEFAULT_USERS:
                conn.execute(
                    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                    (username, _hash_password(password), role),
                )
            conn.commit()
        log.info("seeded %d default users at %s", len(DEFAULT_USERS), self.db_path)

    # ----- user CRUD ------------------------------------------------------

    def get_by_username(self, username: str) -> User | None:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT username, password_hash, role, source FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None:
            return None
        return User(
            username=row["username"],
            role=row["role"],
            password_hash=row["password_hash"],
            source=row["source"] if "source" in row.keys() else "local",  # noqa: SIM118
        )

    def verify(self, username: str, password: str) -> User | None:
        user = self.get_by_username(username)
        if user is None:
            # constant-ish time — hash a throwaway so the password branch
            # doesn't leak whether the user exists via timing.
            _hash_password(password)
            return None
        if not _verify_password(password, user.password_hash):
            return None
        return user

    def update_password(self, username: str, new_password: str) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE users SET password_hash = ?, updated_at = datetime('now') "
                "WHERE username = ?",
                (_hash_password(new_password), username),
            )
            conn.commit()
            return cur.rowcount > 0

    def set_role(self, username: str, new_role: str) -> bool:
        """Update a user's role. Used by T-121 role-mapping on OIDC login.

        Returns False if no such user. The role string is NOT validated
        here — the caller (the OIDC callback) passes a value already
        validated against :data:`ROLE_PRIVILEGE` or the operator's
        ``--oidc-default-role`` choice.
        """
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE users SET role = ?, updated_at = datetime('now') WHERE username = ?",
                (new_role, username),
            )
            conn.commit()
            return cur.rowcount > 0

    def list_users(self) -> list[User]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT username, password_hash, role, source FROM users ORDER BY username"
            ).fetchall()
        return [
            User(
                username=r["username"],
                role=r["role"],
                password_hash=r["password_hash"],
                source=r["source"] if "source" in r.keys() else "local",  # noqa: SIM118
            )
            for r in rows
        ]

    # ----- OIDC provisioning (T-112) -------------------------------------

    def get_by_oauth(self, provider: str, provider_user_id: str) -> User | None:
        """Return the local user linked to ``(provider, provider_user_id)``.

        Returns None if no link exists. Used by the OIDC callback to find
        an existing user on a repeat login.
        """
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT u.username, u.password_hash, u.role, u.source "
                "FROM user_oauth_links l JOIN users u ON l.username = u.username "
                "WHERE l.provider = ? AND l.provider_user_id = ?",
                (provider, provider_user_id),
            ).fetchone()
        if row is None:
            return None
        return User(
            username=row["username"],
            role=row["role"],
            password_hash=row["password_hash"],
            source=row["source"] if "source" in row.keys() else "local",  # noqa: SIM118
        )

    def get_by_email(self, email: str) -> User | None:
        """Return the local user whose username matches ``email``.

        OIDC users created from an email have ``username = email`` (when
        the provider gives an email and no preferred username). This lets
        a subsequent GitHub login find the same account created by an
        earlier Google login (matched by shared email).
        """
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT username, password_hash, role, source FROM users WHERE username = ?",
                (email,),
            ).fetchone()
        if row is None:
            return None
        return User(
            username=row["username"],
            role=row["role"],
            password_hash=row["password_hash"],
            source=row["source"] if "source" in row.keys() else "local",  # noqa: SIM118
        )

    def get_or_create_oidc_user(
        self,
        *,
        provider: str,
        provider_user_id: str,
        email: str | None,
        username_hint: str | None,
        default_role: str = "viewer",
    ) -> User:
        """Find or create the local user for an OIDC login.

        Resolution order:
          1. Existing link ``(provider, provider_user_id)`` → return that user.
          2. Existing user with ``username == email`` (cross-provider match).
          3. Create a new user with role ``default_role``.

        The new user's username is derived as:
          * ``email`` if the provider gave one (enables cross-provider match),
          * else ``<provider>:<provider_user_id>`` (no email to match on).

        A random unusable password hash is set (OIDC users never log in
        via password). The provider link row is created or updated.
        """
        # (1) Existing link.
        existing = self.get_by_oauth(provider, provider_user_id)
        if existing is not None:
            return existing
        # (2) Cross-provider email match.
        if email is not None:
            by_email = self.get_by_email(email)
            if by_email is not None:
                # Link this provider to the existing user.
                self._upsert_oauth_link(
                    username=by_email.username,
                    provider=provider,
                    provider_user_id=provider_user_id,
                    access_token=None,
                    refresh_token=None,
                    expires_at=None,
                )
                return by_email
        # (3) Create new user.
        new_username = email if email is not None else f"{provider}:{provider_user_id}"
        # Avoid colliding with an existing username (rare but possible
        # if a local user was created with the same email by an admin).
        if self.get_by_username(new_username) is not None:
            new_username = f"{provider}:{provider_user_id}"
        with self._lock, self._conn() as conn:
            # Random password hash — OIDC users can't log in via password.
            # bcrypt of 32 random bytes; never returned to anyone.
            random_pw = secrets.token_urlsafe(32)
            conn.execute(
                "INSERT INTO users (username, password_hash, role, source) "
                "VALUES (?, ?, ?, 'oidc')",
                (new_username, _hash_password(random_pw), default_role),
            )
            conn.execute(
                "INSERT INTO user_oauth_links (username, provider, provider_user_id) "
                "VALUES (?, ?, ?)",
                (new_username, provider, provider_user_id),
            )
            conn.commit()
        user = self.get_by_username(new_username)
        assert user is not None  # just inserted
        return user

    def update_oauth_tokens(
        self,
        *,
        provider: str,
        provider_user_id: str,
        access_token: str | None,
        refresh_token: str | None = None,
        expires_at: int | None = None,
    ) -> bool:
        """Update the stored access/refresh tokens for an existing link.

        Returns False if no link exists (caller should have created one
        via :meth:`get_or_create_oidc_user` first).

        T-122: also clears ``revoked_at`` (a successful callback is a
        re-login, which re-activates a previously-revoked link) and
        preserves any existing ``refresh_token`` when the caller passes
        ``refresh_token=None`` (GitHub callbacks have no refresh token,
        but a prior refresh-token grant may have stored one — though in
        practice GitHub never issues one, so this branch is mostly
        defensive).
        """
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE user_oauth_links SET "
                "access_token = ?, "
                "refresh_token = COALESCE(?, refresh_token), "
                "expires_at = ?, "
                "revoked_at = NULL, "
                "updated_at = datetime('now') "
                "WHERE provider = ? AND provider_user_id = ?",
                (access_token, refresh_token, expires_at, provider, provider_user_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def _upsert_oauth_link(
        self,
        *,
        username: str,
        provider: str,
        provider_user_id: str,
        access_token: str | None,
        refresh_token: str | None,
        expires_at: int | None,
    ) -> None:
        """Insert a link row, or update it if (provider, provider_user_id) exists."""
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO user_oauth_links "
                "(username, provider, provider_user_id, access_token, refresh_token, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(provider, provider_user_id) DO UPDATE SET "
                "username = excluded.username, "
                "access_token = COALESCE(excluded.access_token, user_oauth_links.access_token), "
                "refresh_token = COALESCE(excluded.refresh_token, user_oauth_links.refresh_token), "
                "expires_at = COALESCE(excluded.expires_at, user_oauth_links.expires_at), "
                "updated_at = datetime('now')",
                (username, provider, provider_user_id, access_token, refresh_token, expires_at),
            )
            conn.commit()

    def list_oauth_links(self, username: str) -> list[dict[str, object]]:
        """Return all provider links for ``username`` (for /auth/me)."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT provider, provider_user_id, created_at FROM user_oauth_links "
                "WHERE username = ? ORDER BY provider",
                (username,),
            ).fetchall()
        return [
            {"provider": r["provider"], "provider_user_id": r["provider_user_id"]} for r in rows
        ]

    # ----- T-122: refresh-token rotation support --------------------------

    def list_expiring_oauth_links(self, horizon_seconds: int) -> list[dict[str, object]]:
        """Return active links whose access token expires within ``horizon_seconds``.

        Rows with ``revoked_at IS NOT NULL`` are skipped (the user must
        re-login; refreshing would just fail again). Rows with no
        ``expires_at`` (GitHub OAuth Apps, or older rows written before
        T-122 fixed the storage) are also skipped — there's nothing to
        refresh against for GitHub, and for the others the background
        loop can't tell when they expire.

        Each returned dict has the columns the refresher needs:
        ``username``, ``provider``, ``provider_user_id``, ``access_token``,
        ``refresh_token``, ``expires_at``.
        """
        import time

        cutoff = int(time.time()) + int(horizon_seconds)
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT username, provider, provider_user_id, access_token, "
                "refresh_token, expires_at "
                "FROM user_oauth_links "
                "WHERE revoked_at IS NULL AND expires_at IS NOT NULL "
                "AND expires_at <= ? AND refresh_token IS NOT NULL",
                (cutoff,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_oauth_link(self, *, username: str, provider: str) -> dict[str, object] | None:
        """Return the active link row for ``(username, provider)`` or None.

        Used by :func:`get_valid_access_token` (force-refresh-on-401) to
        look up the stored access token + refresh token + expiry for a
        known user/provider pair. Revoked links are reported as None so
        the caller treats them as "must re-login".
        """
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT username, provider, provider_user_id, access_token, "
                "refresh_token, expires_at, revoked_at "
                "FROM user_oauth_links WHERE username = ? AND provider = ?",
                (username, provider),
            ).fetchone()
        if row is None:
            return None
        if row["revoked_at"] is not None:
            return None
        return dict(row)

    def mark_oauth_link_revoked(self, *, provider: str, provider_user_id: str) -> bool:
        """Mark a link revoked (refresh failed / user revoked access on IdP).

        Sets ``revoked_at = datetime('now')`` so the background loop
        skips it and ``get_oauth_link`` reports it as gone. The user
        must re-login (which clears ``revoked_at`` via the upsert on
        callback) before their access token is trusted again.
        """
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE user_oauth_links SET revoked_at = datetime('now'), "
                "updated_at = datetime('now') "
                "WHERE provider = ? AND provider_user_id = ? AND revoked_at IS NULL",
                (provider, provider_user_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def refresh_update_oauth_link(
        self,
        *,
        provider: str,
        provider_user_id: str,
        access_token: str,
        refresh_token: str | None,
        expires_at: int,
    ) -> bool:
        """Update a link with a refreshed access token + new expiry (T-122).

        ``refresh_token`` is the value to persist — if the IdP rotated
        it, pass the new one; if not, pass the existing one (the caller
        reads it from :meth:`list_expiring_oauth_links` /
        :meth:`get_oauth_link` and re-sends it). ``expires_at`` is an
        absolute unix timestamp (caller converts ``expires_in`` →
        ``now + expires_in`` before calling).
        """
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE user_oauth_links SET access_token = ?, refresh_token = ?, "
                "expires_at = ?, revoked_at = NULL, updated_at = datetime('now') "
                "WHERE provider = ? AND provider_user_id = ?",
                (access_token, refresh_token, int(expires_at), provider, provider_user_id),
            )
            conn.commit()
            return cur.rowcount > 0

    # ----- refresh tokens -------------------------------------------------

    def register_refresh(self, token: str, username: str, expires_at: int) -> None:
        import time

        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO refresh_tokens (token, username, issued_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (token, username, int(time.time()), int(expires_at)),
            )
            conn.commit()

    def is_refresh_valid(self, token: str) -> bool:
        import time

        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT revoked, expires_at FROM refresh_tokens WHERE token = ?",
                (token,),
            ).fetchone()
        if row is None:
            return False
        if bool(row["revoked"]):
            return False
        return int(time.time()) < int(row["expires_at"])

    def revoke_refresh(self, token: str) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE refresh_tokens SET revoked = 1 WHERE token = ? AND revoked = 0",
                (token,),
            )
            conn.commit()
            return cur.rowcount > 0

    def revoke_all_for_user(self, username: str) -> int:
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE refresh_tokens SET revoked = 1 WHERE username = ? AND revoked = 0",
                (username,),
            )
            conn.commit()
            return cur.rowcount


def _cli() -> int:
    """Tiny CLI: ``python -m neuralgentics.web.auth.users set-password <user>``."""
    import argparse

    p = argparse.ArgumentParser(prog="neuralgentics.web.auth.users")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("set-password", help="Change a user's password")
    sp.add_argument("username")
    sp.add_argument("--db", default=str(DEFAULT_DB_PATH), help="SQLite path")
    args = p.parse_args()

    if args.cmd == "set-password":
        import getpass

        store = UserStore(args.db)
        user = store.get_by_username(args.username)
        if user is None:
            print(f"no such user: {args.username}", file=sys.stderr)
            return 1
        pw = getpass.getpass(f"new password for {args.username}: ")
        if not pw:
            print("empty password rejected", file=sys.stderr)
            return 1
        ok = store.update_password(args.username, pw)
        print("updated" if ok else "no change")
        return 0 if ok else 1
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli())


__all__ = [
    "User",
    "UserStore",
    "DEFAULT_DB_PATH",
    "DEFAULT_USERS",
]
