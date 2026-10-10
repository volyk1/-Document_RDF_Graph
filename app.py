from __future__ import annotations

import json
import mimetypes
import re
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_RDF = ROOT / "output"
PUBLIC = ROOT / "public"
PORT = 7860


def local_name(value: str) -> str:
    name = urllib.parse.unquote(value.rsplit("/", 1)[-1].rsplit("#", 1)[-1])
    return name.rsplit(":", 1)[-1]


def literal(value: str) -> str:
    match = re.search(r'"((?:[^"\\]|\\.)*)"', value)
    if not match:
        return ""
    return match.group(1).replace(r"\"", '"').replace(r"\\", "\\")


def parse_rdf(text: str) -> dict[str, Any]:
    documents: dict[str, dict[str, Any]] = {}
    legal_acts: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] | None = None
    current_id = ""

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("@prefix"):
            continue
        subject_match = re.match(r"^(ex:(?:document_|legalAct_)\S+)\s+(.+)$", line)
        predicate_line = line
        if subject_match:
            current_id = subject_match.group(1)
            predicate_line = subject_match.group(2)
            current = {}
            if current_id.startswith("ex:document_"):
                documents[current_id] = current
            elif current_id.startswith("ex:legalAct_"):
                legal_acts[current_id] = current
            else:
                current = None
            if current is not None:
                current["id"] = current_id
                current.setdefault("crossReferences", [])
        if current is None:
            continue
        predicate_matches = re.findall(
            r"(ex:\w+|rdfs:\w+|rdf:type)\s+(.+?)(?:\s*;|\s*\.\s*$|$)",
            predicate_line,
        )
        for predicate, value in predicate_matches:
            key = predicate.split(":", 1)[-1]
            if key == "crossReference":
                references = re.findall(r"ex:legalAct_[^\s,;]+", value)
                for reference in references:
                    if reference not in current["crossReferences"]:
                        current["crossReferences"].append(reference)
            elif predicate == "rdfs:label":
                current["label"] = literal(value)
            elif key == "type":
                current["type"] = local_name(value.strip())
            else:
                current[key] = literal(value)

    for item in documents.values():
        item.setdefault("name", local_name(item["id"]))
        item.setdefault("keywords", "")
        item["keywordsList"] = [part.strip() for part in item["keywords"].split(",") if part.strip()]
        item["title"] = item.get("notes") or item.get("name", "")
        item["legalActIds"] = item.get("crossReferences", [])
        item["legalActId"] = item["legalActIds"][0] if item["legalActIds"] else ""

    for item in legal_acts.values():
        item["title"] = item.get("label") or local_name(item["id"]).removeprefix("legalAct_").replace("_", " ")
        item["type"] = "LegalAct"

    return {
        "documents": list(documents.values()),
        "legalActs": list(legal_acts.values()),
        "triples": sum(1 for line in text.splitlines() if line.strip().endswith(";") or line.strip().endswith(".")),
    }


def load_graph() -> dict[str, Any]:
    try:
        return parse_rdf(DEFAULT_RDF.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        return parse_rdf(DEFAULT_RDF.read_text(encoding="utf-8-sig"))


GRAPH = load_graph()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        global GRAPH
        if self.path == "/api/health":
            self.send_json({"status": "ok"})
            return
        if self.path.startswith("/api/documents"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("q", [""])[0].lower()
            documents = [
                document for document in GRAPH["documents"]
                if not query or query in json.dumps(document, ensure_ascii=False).lower()
            ]
            self.send_json({"documents": documents, "total": len(documents)})
            return
        if self.path == "/api/graph":
            self.send_json(GRAPH)
            return
        if self.path.startswith("/api/trace/"):
            document_id = urllib.parse.unquote(self.path.removeprefix("/api/trace/"))
            document = next((item for item in GRAPH["documents"] if item["id"] == document_id), None)
            if not document:
                self.send_json({"error": "Документ не знайдено"}, HTTPStatus.NOT_FOUND)
                return
            legal_act_ids = document.get("legalActIds", [])
            acts = [
                item for item in GRAPH["legalActs"]
                if item["id"] in legal_act_ids
            ]
            self.send_json({
                "document": document,
                "keywords": document["keywordsList"],
                "legalActs": acts,
                "legalAct": acts[0] if acts else None,
            })
            return
        self.serve_static(self.path)

    def do_POST(self) -> None:
        global GRAPH
        if self.path != "/api/upload":
            self.send_json({"error": "Маршрут не знайдено"}, HTTPStatus.NOT_FOUND)
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_json({"error": "Очікується multipart/form-data"}, HTTPStatus.BAD_REQUEST)
            return
        boundary = content_type.split("boundary=", 1)[-1].encode()
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        parts = raw.split(b"--" + boundary)
        uploaded = next((part for part in parts if b"filename=" in part), b"")
        if not uploaded:
            self.send_json({"error": "Файл RDF не передано"}, HTTPStatus.BAD_REQUEST)
            return
        header_end = uploaded.find(b"\r\n\r\n")
        data = uploaded[header_end + 4:].rstrip(b"\r\n-")
        try:
            GRAPH = parse_rdf(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.send_json({"error": "Не вдалося прочитати RDF у кодуванні UTF-8"}, HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"message": "RDF завантажено", "documents": len(GRAPH["documents"])})

    def serve_static(self, request_path: str) -> None:
        path = PUBLIC / ("index.html" if request_path == "/" else request_path.lstrip("/"))
        if not path.is_file() or PUBLIC not in path.resolve().parents:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[http] {format % args}")


if __name__ == "__main__":
    print(f"Document Graph: http://localhost:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
