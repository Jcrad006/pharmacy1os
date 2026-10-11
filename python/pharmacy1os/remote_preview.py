"""Loopback-only, authenticated HTTP boundary for a narrowly editable Qt pilot.

Separate-process transport, not a database adapter. Allows one explicitly
validated, pharmacist-reviewed SIG edit using a stale-version guard; no fill,
claim, inventory, POS or remote-host actions. SYNTHETIC development only.
"""
from __future__ import annotations

import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE_BYTES = 1024 * 1024
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{64}\Z")
IDENTIFIER_RE = re.compile(r"[a-fA-F0-9-]{36}\Z")


class WorkstationConnectionError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an Authorization bearer token to a redirected origin.
        return None


class LocalSessionWorkstationClient:
    """Isolated native workstation talks to a localhost authenticated API.

    Never accepts x-demo-staff-id. No SQLAlchemy, workstation database file,
    source-document write, filling, payer, inventory or checkout commands.
    Only pharmacist-attested, versioned prescription SIG changes are allowed.
    """
    def __init__(self, base_url: str = "http://127.0.0.1:8008", *, timeout: float = 3):
        if not isinstance(base_url, str):
            raise ValueError("Explicit loopback HTTP URL required")
        try:
            url = urlsplit(base_url)
            port = url.port
        except ValueError as exc:
            raise ValueError("Invalid workstation service URL") from exc
        if (url.scheme != "http" or url.hostname != "127.0.0.1"
                or port is None or not 1024 <= port <= 65535
                or url.username is not None or url.password is not None
                or url.path not in ("", "/") or url.query or url.fragment):
            raise ValueError("Preview permits only http://127.0.0.1:PORT without credentials or paths")
        if type(timeout) not in (int, float) or not 0.2 <= timeout <= 10:
            raise ValueError("Timeout must be between 0.2 and 10 seconds")
        self.base_url = f"http://127.0.0.1:{port}"
        self.timeout = timeout
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())
        self._token: str | None = None
        self._identity: dict | None = None

    @property
    def identity(self) -> dict | None:
        return dict(self._identity) if self._identity is not None else None

    def _call(self, method: str, path: str, *, payload: dict | None = None,
              params: dict | None = None, authenticated: bool = True) -> dict:
        if authenticated and not self._token:
            raise WorkstationConnectionError("Sign in to the synthetic workstation first", status=401)
        # Exact allowlist: a very narrow reviewed SIG edit is the ONLY
        # client-side mutation (aside from login/logout). Never use this
        # method as a general-purpose pharmacy REST client.
        rx_path = r"/api/prescriptions/[a-fA-F0-9-]{36}"
        public_login = method == "POST" and path == "/api/auth/login"
        logout = method == "POST" and path == "/api/auth/logout"
        reviewed_sig_edit = method == "PATCH" and re.fullmatch(rx_path, path) is not None
        read = method == "GET" and (
            path in ("/api/auth/me", "/api/prescriptions/queue")
            or re.fullmatch(rx_path + r"(?:/audit|/edit-context)?", path) is not None)
        if not (public_login or logout or read or reviewed_sig_edit):
            raise ValueError("Read-only or reviewed-SIG preview refuses this endpoint or HTTP method")
        if public_login == authenticated or (payload is not None and not (public_login or reviewed_sig_edit)):
            raise ValueError("Invalid preview authentication or request payload")
        if reviewed_sig_edit:
            if not authenticated or params:
                raise ValueError("Reviewed SIG changes require an authenticated request without query parameters")
            if not isinstance(payload, dict) or set(payload) != {"expected_version", "attestation_note", "changes"}:
                raise ValueError("Only versioned, documented SIG changes may be submitted")
            version, note, changes = (payload[k] for k in ("expected_version", "attestation_note", "changes"))
            if (type(version) is not int or version < 0 or not isinstance(note, str)
                    or not 12 <= len(note.strip()) <= 2000
                    or not isinstance(changes, dict) or set(changes) != {"sig"}
                    or not isinstance(changes["sig"], str)
                    or not 1 <= len(changes["sig"].strip()) <= 4000):
                raise ValueError("Invalid documented SIG change")
        path_url = self.base_url + path
        if params:
            path_url += "?" + urlencode(params)
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self._token
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        request = Request(path_url, headers=headers, data=data, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                if not 200 <= response.status < 300:
                    raise WorkstationConnectionError("Synthetic service rejected the request",
                                                     status=response.status)
                if "application/json" not in response.headers.get("Content-Type", "").lower():
                    raise WorkstationConnectionError("Unexpected server response type")
                content = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if exc.code == 401:
                self._token = None
                self._identity = None
                message = "Session expired or login refused; sign in again"
            elif exc.code == 403:
                message = "This synthetic account is not authorized"
            elif exc.code in (301, 302, 303, 307, 308):
                message = "Unexpected server redirect refused"
            else:
                message = f"Synthetic service returned HTTP {exc.code}"
            raise WorkstationConnectionError(message, status=exc.code) from None
        except (URLError, OSError, TimeoutError):
            raise WorkstationConnectionError("Local synthetic Python service is unavailable; verify current Rx and audit before retrying any edit") from None
        if len(content) > MAX_RESPONSE_BYTES:
            raise WorkstationConnectionError("Server response exceeds preview limit")
        try:
            obj = json.loads(content)
        except (ValueError, UnicodeDecodeError) as exc:
            raise WorkstationConnectionError("Malformed JSON from synthetic server") from exc
        if not isinstance(obj, dict):
            raise WorkstationConnectionError("Invalid synthetic server response")
        return obj

    def login(self, username: str, password: str) -> dict:
        self._token = None
        self._identity = None
        if not isinstance(username, str) or not isinstance(password, str):
            raise ValueError("Synthetic username and password are required")
        result = self._call("POST", "/api/auth/login", authenticated=False,
                            payload={"username": username, "password": password})
        token = result.get("access_token")
        if not isinstance(token, str) or TOKEN_RE.fullmatch(token) is None:
            raise WorkstationConnectionError("Server did not provide a valid synthetic session token")
        self._token = token
        try:
            identity = self._call("GET", "/api/auth/me")
            if (identity.get("synthetic_only") is not True
                    or not all(isinstance(identity.get(field), str) and identity[field]
                               for field in ("staff_id", "site_id", "role"))):
                raise WorkstationConnectionError("Server is not an approved synthetic session endpoint")
        except Exception:
            self._token = None
            raise
        self._identity = {k: identity[k] for k in ("staff_id", "site_id", "role", "synthetic_only")}
        return dict(self._identity)

    def queue(self, *, query: str = "", status: str | None = None,
              sort: str = "oldest", limit: int = 100) -> dict:
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("Search string must be no more than 200 characters")
        if sort not in ("oldest", "newest") or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Invalid queue sort or limit")
        params = {"query": query, "sort": sort, "limit": limit}
        if status is not None:
            params["status"] = status
        result = self._call("GET", "/api/prescriptions/queue", params=params)
        if not isinstance(result.get("prescriptions"), list):
            raise WorkstationConnectionError("Missing prescription queue")
        return result

    @staticmethod
    def _id(rx_id: str) -> str:
        if not isinstance(rx_id, str) or IDENTIFIER_RE.fullmatch(rx_id) is None:
            raise ValueError("Invalid synthetic prescription identifier")
        return rx_id

    def detail(self, rx_id: str) -> dict:
        record = self._call("GET", f"/api/prescriptions/{self._id(rx_id)}")
        if not isinstance(record.get("prescription"), dict):
            raise WorkstationConnectionError("Missing structured prescription detail")
        return record["prescription"]

    def edit_context(self, rx_id: str) -> dict:
        """Retrieve authoritative edit permission, current version and SIG.

        The server will recheck all state under a locked transaction on PATCH.
        """
        data = self._call("GET", f"/api/prescriptions/{self._id(rx_id)}/edit-context")
        values = data.get("values")
        if (not isinstance(values, dict) or not isinstance(values.get("sig"), str)
                or type(data.get("version")) is not int or data["version"] < 0
                or not isinstance(data.get("editable"), bool)):
            raise WorkstationConnectionError("Invalid review context from synthetic server")
        return data

    def review_sig(self, rx_id: str, *, sig: str, expected_version: int,
                   attestation_note: str) -> dict:
        """Submit exactly one reviewed SIG change. NEVER auto-retry after timeout.

        The server may have committed even when a response was lost. Operators
        must reread the current version and audit, not blindly resend a PATCH.
        """
        payload = {"expected_version": expected_version,
                   "attestation_note": attestation_note,
                   "changes": {"sig": sig}}
        # _call validates the entire payload before any network request.
        response = self._call("PATCH", f"/api/prescriptions/{self._id(rx_id)}",
                              payload=payload)
        if (type(response.get("version")) is not int or response["version"] <= expected_version
                or response.get("prescription_id") != rx_id
                or not isinstance(response.get("changed"), dict)
                or set(response["changed"]) != {"sig"}):
            raise WorkstationConnectionError(
                "Uncertain server edit response; refresh prescription and audit before taking further action")
        return response

    def audit(self, rx_id: str, *, limit: int = 100) -> dict:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Audit history limit must be 1 to 200")
        data = self._call("GET", f"/api/prescriptions/{self._id(rx_id)}/audit",
                          params={"limit": limit})
        if not isinstance(data.get("events"), list):
            raise WorkstationConnectionError("Missing prescription audit history")
        return data

    def logout(self) -> None:
        if self._token:
            try:
                self._call("POST", "/api/auth/logout")
            finally:
                self._token = None
                self._identity = None
