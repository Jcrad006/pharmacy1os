"""Python-native prescription document vault (synthetic-only migration).

Sources remain immutable bytes on disk; annotations and provenance are separate
SQL records. No method here applies clinical changes to the structured Rx.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
from base64 import b64decode
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from .models import Document, DocumentAnnotation, DocumentChange, Drug, Patient, Prescriber, Prescription
from .service import AccessDenied, Actor, PharmacyService, WorkflowError

ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/tiff", "application/pdf"}
MAX_BYTES = 25 * 1024 * 1024
MAGIC = b"P1DV1"
CHANGE_TYPES = {"SIG", "QUANTITY", "REFILLS", "DRUG", "STRENGTH", "DOSAGE_FORM", "DAW", "PRESCRIBER", "WRITTEN_DATE", "OTHER"}
COMMUNICATION = {"PHONE", "FAX", "ELECTRONIC", "IN_PERSON", "OTHER"}


class DocumentError(WorkflowError):
    pass


def decode_base64(encoded: str) -> bytes:
    if not isinstance(encoded, str):
        raise DocumentError("Base64 document source required")
    body = encoded.partition(",")[2] if encoded.startswith("data:") else encoded
    try:
        data = b64decode("".join(body.split()), validate=True)
    except Exception as exc:
        raise DocumentError("Invalid document base64") from exc
    if not data or len(data) > MAX_BYTES:
        raise DocumentError("Document must contain 1–25 MB of source bytes")
    return data


class DocumentService:
    def __init__(self, service: PharmacyService, root: str | Path, encryption_key: bytes | None = None):
        self.service = service
        self.root = Path(root).expanduser().resolve()
        if encryption_key is not None and len(encryption_key) != 32:
            raise DocumentError("AES-256-GCM document key must be 32 bytes")
        self.key = encryption_key

    @classmethod
    def from_demo_env(cls, service: PharmacyService) -> "DocumentService":
        """Synthetic preview only; not suitable for live patient records."""
        raw = os.getenv("DOCUMENT_ENCRYPTION_KEY")
        try:
            key = bytes.fromhex(raw) if raw is not None else None
        except ValueError as exc:
            raise DocumentError("DOCUMENT_ENCRYPTION_KEY must be hexadecimal") from exc
        root = Path(os.getenv("DOCUMENT_STORAGE_ROOT", str(Path.home() / ".pharmacy1os" / "synthetic" / "documents")))
        return cls(service, root, key)

    @staticmethod
    def _access(s, actor: Actor, permission: str) -> None:
        PharmacyService._authorized(s, actor, permission)
        if permission in {"entry", "process"} and actor.role not in {"ADMIN", "PHARMACIST", "TECHNICIAN", "INTERN"}:
            raise AccessDenied("Document modification permission required")

    @staticmethod
    def _metadata(doc: Document) -> dict[str, Any]:
        return {"id": doc.id, "prescription_id": doc.prescription_id,
                "source_type": doc.source_type, "mime_type": doc.mime_type,
                "original_filename": doc.original_filename, "sha256": doc.sha256,
                "byte_size": doc.byte_size, "encrypted": doc.encrypted, "immutable": True}

    def _path(self, site_id: str, document_id: str) -> Path:
        # UUID-only components and a rooted path avoid arbitrary path traversal.
        try:
            site = str(UUID(site_id)); document = str(UUID(document_id))
        except ValueError as exc:
            raise DocumentError("Invalid site/document identifier") from exc
        candidate = (self.root / "originals" / site / f"{document}.p1doc").resolve()
        if not candidate.is_relative_to(self.root):
            raise DocumentError("Document vault path outside root")
        return candidate

    def _encode(self, plain: bytes) -> bytes:
        if self.key is None:
            return plain
        nonce = os.urandom(12)
        sealed = AESGCM(self.key).encrypt(nonce, plain, None)
        # Legacy Node-compatible representation: magic + nonce + tag + ciphertext.
        return MAGIC + nonce + sealed[-16:] + sealed[:-16]

    def _decode(self, data: bytes, encrypted: bool) -> bytes:
        if not encrypted:
            return data
        if self.key is None:
            raise DocumentError("Document encryption key is unavailable")
        if not data.startswith(MAGIC) or len(data) < len(MAGIC) + 12 + 16:
            raise DocumentError("Encrypted source header is invalid")
        nonce = data[5:17]; tag = data[17:33]; cipher = data[33:]
        try:
            return AESGCM(self.key).decrypt(nonce, cipher + tag, None)
        except Exception as exc:
            raise DocumentError("Document authentication/decryption failed") from exc

    def create_source(self, actor: Actor, rx_id: str, data: bytes,
                      mime_type: str, source_type: str = "SCAN",
                      filename: str | None = None, *, _generated: bool = False) -> dict[str, Any]:
        if source_type not in {"SCAN", "UPLOAD", "ELECTRONIC_RENDER"}:
            raise DocumentError("Invalid document source type")
        if source_type == "ELECTRONIC_RENDER":
            if not _generated:
                raise DocumentError("Electronic SVG sources must be generated internally")
            if mime_type != "image/svg+xml":
                raise DocumentError("Electronic render must be a generated SVG")
        elif mime_type.lower() not in ALLOWED_MIME:
            raise DocumentError("Unsupported source document MIME type")
        if not data or len(data) > MAX_BYTES:
            raise DocumentError("Document must contain 1–25 MB of source bytes")
        if filename is not None and len(filename) > 255:
            raise DocumentError("Filename exceeds 255 characters")

        # Verify tenancy and authorization BEFORE touching the filesystem.
        with self.service.sessions() as s:
            self._access(s, actor, "entry")
            self.service._site(s, Prescription, rx_id, actor)
        document_id = str(uuid4())
        path = self._path(actor.site_id, document_id)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = self._encode(data)
        with path.open("xb") as file:
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        try:
            with self.service.sessions.begin() as s:
                self._access(s, actor, "entry")
                rx = self.service._site(s, Prescription, rx_id, actor)
                doc = Document(id=document_id, site_id=actor.site_id, patient_id=rx.patient_id,
                               prescription_id=rx.id, source_type=source_type, mime_type=mime_type,
                               original_filename=filename, storage_key=f"originals/{actor.site_id}/{document_id}.p1doc",
                               sha256=hashlib.sha256(data).hexdigest(), byte_size=len(data),
                               encrypted=self.key is not None, created_by_id=actor.id)
                s.add(doc); s.flush()
                self.service._audit(s, actor, "DOCUMENT_SOURCE_CREATED", doc.id,
                                    {"rx_id": rx.id, "sha256": doc.sha256, "encrypted": doc.encrypted})
                return self._metadata(doc)
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    def list_sources(self, actor: Actor, rx_id: str) -> list[dict[str, Any]]:
        from .models import Prescription
        with self.service.sessions() as s:
            self._access(s, actor, "read")
            self.service._site(s, Prescription, rx_id, actor)
            rows = s.scalars(select(Document).where(Document.site_id == actor.site_id,
                        Document.prescription_id == rx_id).order_by(Document.created_at, Document.id)).all()
            return [self._metadata(doc) for doc in rows]

    def read_source(self, actor: Actor, document_id: str) -> tuple[bytes, str]:
        with self.service.sessions() as s:
            self._access(s, actor, "read")
            doc = self.service._site(s, Document, document_id, actor)
            path = self._path(doc.site_id, doc.id)
            try:
                data = self._decode(path.read_bytes(), doc.encrypted)
            except OSError as exc:
                raise DocumentError("Stored document missing or unreadable") from exc
            if len(data) != doc.byte_size or hashlib.sha256(data).hexdigest() != doc.sha256:
                raise DocumentError("Document source integrity verification failed")
            return data, doc.mime_type

    @staticmethod
    def _change_validation(text: str, x: Any, y: Any, width: Any, height: Any,
                           change: dict[str, Any]) -> dict[str, Any]:
        text = text.strip() if isinstance(text, str) else ""
        if not 1 <= len(text) <= 1500:
            raise DocumentError("Visual annotation requires 1–1500 characters")
        try:
            values = [Decimal(str(v)) for v in (x, y, width, height)]
        except (TypeError, InvalidOperation, ValueError) as exc:
            raise DocumentError("Invalid annotation rectangle") from exc
        a, b, w, h = values
        if (not all(v.is_finite() for v in values) or a < 0 or b < 0
                or w < Decimal("0.01") or h < Decimal("0.01")
                or a + w > 1 or b + h > 1):
            raise DocumentError("Annotation must fit inside normalized page bounds")
        if (change.get("change_type") not in CHANGE_TYPES
                or not str(change.get("what_changed") or "").strip()
                or not str(change.get("reason") or "").strip()
                or (change.get("communication_method") is not None and change["communication_method"] not in COMMUNICATION)):
            raise DocumentError("Change type, what changed, reason and valid communication method required")
        return {"text": text, "x": a, "y": b, "width": w, "height": h,
                "change_type": change["change_type"], "what_changed": change["what_changed"].strip(),
                "reason": change["reason"].strip(),
                "communication_method": change.get("communication_method"),
                "contacted_party": change.get("contacted_party"),
                "authorizing_prescriber": change.get("authorizing_prescriber"),
                "note": change.get("note")}

    def annotate(self, actor: Actor, document_id: str, text: str,
                 x: Any, y: Any, width: Any, height: Any, change: dict[str, Any],
                 supersedes_id: str | None = None) -> str:
        values = self._change_validation(text, x, y, width, height, change)
        with self.service.sessions.begin() as s:
            self._access(s, actor, "entry")
            doc = self.service._site(s, Document, document_id, actor)
            previous = previous_change = None
            if supersedes_id:
                previous = self.service._site(s, DocumentAnnotation, supersedes_id, actor)
                if previous.document_id != doc.id or previous.status != "ACTIVE":
                    raise DocumentError("Superseded annotation must be active and belong to the same source")
                previous_change = s.scalar(select(DocumentChange).where(DocumentChange.annotation_id == previous.id))
                if not previous_change or previous_change.status != "ACTIVE":
                    raise DocumentError("Prior provenance record is not active")
                previous.status = "SUPERSEDED"
                previous_change.status = "SUPERSEDED"
            annotation = DocumentAnnotation(site_id=actor.site_id, document_id=doc.id,
                          prescription_id=doc.prescription_id, status="ACTIVE", created_by_id=actor.id,
                          supersedes_id=previous.id if previous else None,
                          **{k: values[k] for k in ("text", "x", "y", "width", "height")})
            s.add(annotation); s.flush()
            record = DocumentChange(site_id=actor.site_id, prescription_id=doc.prescription_id,
                      annotation_id=annotation.id, changed_by_id=actor.id,
                      supersedes_id=previous_change.id if previous_change else None,
                      **{k: v for k, v in values.items() if k not in {"text", "x", "y", "width", "height"}})
            s.add(record); s.flush()
            self.service._audit(s, actor, "DOCUMENT_ANNOTATION_CREATED" if not previous else "DOCUMENT_ANNOTATION_SUPERSEDED",
                                annotation.id, {"document_id": doc.id, "change_record_id": record.id,
                                                "supersedes": supersedes_id, "change_type": record.change_type,
                                                "what_changed": record.what_changed, "reason": record.reason})
            return annotation.id

    def list_annotations(self, actor: Actor, document_id: str) -> list[dict[str, Any]]:
        with self.service.sessions() as s:
            self._access(s, actor, "read")
            self.service._site(s, Document, document_id, actor)
            annotations = s.scalars(select(DocumentAnnotation).where(
                DocumentAnnotation.document_id == document_id).order_by(DocumentAnnotation.created_at, DocumentAnnotation.id)).all()
            rows = []
            for a in annotations:
                c = s.scalar(select(DocumentChange).where(DocumentChange.annotation_id == a.id))
                rows.append({"id": a.id, "status": a.status, "supersedes_id": a.supersedes_id,
                             "text": a.text, "x": str(a.x), "y": str(a.y),
                             "width": str(a.width), "height": str(a.height),
                             "changed_by_id": c.changed_by_id, "created_at": a.created_at.isoformat(),
                             "change": {"type": c.change_type, "what_changed": c.what_changed,
                                        "reason": c.reason, "communication_method": c.communication_method,
                                        "contacted_party": c.contacted_party,
                                        "authorizing_prescriber": c.authorizing_prescriber,
                                        "note": c.note}})
            return rows

    def render_erx(self, actor: Actor, rx_id: str, electronic_message_id: str) -> dict[str, Any]:
        """Generate a visual *from structured synthetic fields*, not a signed eRx."""
        from .models import Prescription
        with self.service.sessions() as s:
            self._access(s, actor, "entry")
            rx = self.service._site(s, Prescription, rx_id, actor)
            p = s.get(Patient, rx.patient_id)
            dr = s.get(Prescriber, rx.prescriber_id)
            drug = s.get(Drug, rx.drug_id)
            fields = {
                "Patient": f"{p.first_name} {p.last_name}",
                "Patient DOB": p.date_of_birth or "—",
                "Prescriber": f"{dr.first_name} {dr.last_name}, {dr.practice_level}",
                "NPI": dr.npi or "—",
                "Medication": f"{drug.name} {drug.strength} {drug.dosage_form}",
                "SIG": rx.sig,
                "Quantity": str(rx.quantity),
                "Refills": str(rx.refills_allowed),
                "Rx Number": rx.rx_number,
                "Electronic Message ID": electronic_message_id,
            }
        lines = [f'<text x="40" y="{70 + i * 48}" font-size="19">{html.escape(name)}: {html.escape(value)}</text>'
                 for i, (name, value) in enumerate(fields.items())]
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">'
               '<rect width="900" height="900" fill="white"/>'
               '<text x="40" y="30" font-size="24">Electronic prescription — synthetic visual</text>'
               + "".join(lines) + '</svg>')
        return self.create_source(actor, rx_id, svg.encode("utf-8"), "image/svg+xml",
                                  "ELECTRONIC_RENDER", f"eRx-{rx_id}.svg", _generated=True)

    def verify_integrity(self, actor: Actor) -> list[dict[str, str]]:
        """Read-only synthetic scan; report corrupt/missing sources, never auto-repair."""
        with self.service.sessions() as s:
            self._access(s, actor, "read")
            docs = s.scalars(select(Document).where(Document.site_id == actor.site_id)).all()
            ids = [d.id for d in docs]
        problems = []
        for document_id in ids:
            try:
                self.read_source(actor, document_id)
            except DocumentError as exc:
                problems.append({"document_id": document_id, "error": str(exc)})
        return problems
