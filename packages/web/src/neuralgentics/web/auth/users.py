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

    def __repr__(self) -> str:  # pragma: no cover — cosmetic
        return f"User(username={self.username!r}, role={self.role!r})"


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
                    expires_at      INTEGER NOT NULL,
                    revoked         INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (username) REFERENCES users(username)
                );

                CREATE INDEX IF NOT EXISTS idx_refresh_username
                    ON refresh_tokens(username);
                """
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
                "SELECT username, password_hash, role FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None:
            return None
        return User(username=row["username"], role=row["role"], password_hash=row["password_hash"])

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

    def list_users(self) -> list[User]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT username, password_hash, role FROM users ORDER BY username"
            ).fetchall()
        return [
            User(username=r["username"], role=r["role"], password_hash=r["password_hash"])
            for r in rows
        ]

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
