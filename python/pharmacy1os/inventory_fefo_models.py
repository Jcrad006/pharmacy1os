"""Opt-in site/product FEFO controls, isolated from legacy Prisma records."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow, uuid


class FefoPolicy(Base):
    __tablename__ = "py_fefo_policies"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid)
    site_id: Mapped[str] = mapped_column(ForeignKey("py_sites.id"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("py_products.id"), nullable=False, index=True)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="ADVISORY")
    minimum_shelf_life_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("py_staff.id"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    __table_args__ = (
        UniqueConstraint("site_id", "product_id", name="uq_py_fefo_site_product"),
        CheckConstraint("mode IN ('ADVISORY','ENFORCE')", name="ck_py_fefo_mode"),
        CheckConstraint("minimum_shelf_life_days BETWEEN 0 AND 3650",
                        name="ck_py_fefo_shelf_days"),
    )
