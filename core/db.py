"""Database wiring: engine, session, Base, create_all, get_db, reset_db.

- One SQLite file (path from ``config.DB_PATH``); ``check_same_thread=False``
  so the async app + tick loop can share it; ``pool_pre_ping=True``.
- ``Base`` is the declarative base every model in ``models.py`` inherits from.
- ``reset_db`` is the trivial-reset hook the demo controls use (§6.2): it can
  wipe the transactional + intelligence tables while preserving the seeded
  reference/config (and simulation/control) data, or reset everything.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, scoped_session, sessionmaker

from . import config


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


engine = create_engine(
    f"sqlite:///{config.DB_PATH}",
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)

SessionLocal = scoped_session(
    sessionmaker(bind=engine, autoflush=False, autocommit=False)
)


def create_all():
    """Create every table defined in ``models.py``."""
    from . import models  # noqa: F401  (import registers all models on Base.metadata)

    Base.metadata.create_all(bind=engine)


def get_db():
    """FastAPI dependency: yield a session and always close it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def reset_db(keep_reference=True):
    """Reset the database.

    ``keep_reference=True`` (default): drop and recreate only the
    transactional (§19.2) + intelligence (§19.3) tables, leaving the
    reference/config (§19.1) and simulation/control (§19.4) tables and their
    seeded data intact.

    ``keep_reference=False``: completely reset — drop and recreate every table.
    """
    from . import models

    # Ensure the schema exists before we attempt selective drops.
    Base.metadata.create_all(bind=engine)

    if keep_reference:
        tables = [
            m.__table__
            for m in (models.TRANSACTIONAL_MODELS + models.INTELLIGENCE_MODELS)
        ]
        Base.metadata.drop_all(bind=engine, tables=tables)
        Base.metadata.create_all(bind=engine, tables=tables)
    else:
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
