#!/usr/bin/env python3
"""Minimalny zapis i odczyt .xlsx na samej bibliotece standardowej.

Zakres celowo waski: jeden arkusz, pierwszy wiersz to naglowek, komorki tekstowe
i liczbowe. Tyle wystarcza, zeby traktowac "excelka" z systemu legacy jako
pelnoprawne zrodlo danych, bez wciagania zaleznosci do projektu.

Odczyt radzi sobie z plikami zapisanymi tutaj (inlineStr) oraz z plikami
z Excela i LibreOffice (sharedStrings) - czyli z tym, co realnie przychodzi
z ksiegowosci.
"""

from __future__ import annotations

import pathlib
import re
import zipfile
from xml.etree import ElementTree

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

_WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""


def _workbook_xml(sheet_name: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{NS}" xmlns:r="{R_NS}">'
        f'<sheets><sheet name="{_escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;"))


def _column_name(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(ord("A") + rest) + name
    return name


def _cell_xml(ref: str, value) -> str:
    if value is None or value == "":
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve"></t></is></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{_escape(str(value))}</t></is></c>'


def write(path: pathlib.Path, header: list[str], rows: list[list], sheet_name: str = "Arkusz1") -> None:
    """Zapisuje jeden arkusz: naglowek + wiersze."""
    parts = [f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{NS}"><sheetData>']
    for row_index, row in enumerate([header] + rows):
        cells = "".join(_cell_xml(f"{_column_name(i)}{row_index + 1}", value) for i, value in enumerate(row))
        parts.append(f'<row r="{row_index + 1}">{cells}</row>')
    parts.append("</sheetData></worksheet>")

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _CONTENT_TYPES)
        archive.writestr("_rels/.rels", _ROOT_RELS)
        archive.writestr("xl/workbook.xml", _workbook_xml(sheet_name))
        archive.writestr("xl/_rels/workbook.xml.rels", _WORKBOOK_RELS)
        archive.writestr("xl/worksheets/sheet1.xml", "".join(parts))
    # Podmiana atomowa: czytelnik nigdy nie zlapie pliku w polowie zapisu.
    tmp.replace(path)


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    values = []
    for item in root.findall(f"{{{NS}}}si"):
        values.append("".join(node.text or "" for node in item.iter(f"{{{NS}}}t")))
    return values


def read(path: pathlib.Path) -> list[dict]:
    """Zwraca liste slownikow: pierwszy wiersz arkusza jest naglowkiem."""
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        sheet_path = next((name for name in archive.namelist()
                           if name.startswith("xl/worksheets/") and name.endswith(".xml")), None)
        if sheet_path is None:
            raise ValueError(f"{path}: brak arkusza w pliku xlsx")
        root = ElementTree.fromstring(archive.read(sheet_path))

    table: list[list[str]] = []
    for row in root.iter(f"{{{NS}}}row"):
        cells: dict[int, str] = {}
        for cell in row.findall(f"{{{NS}}}c"):
            ref = cell.get("r") or ""
            letters = re.match(r"[A-Z]+", ref)
            index = 0
            if letters:
                for char in letters.group(0):
                    index = index * 26 + (ord(char) - ord("A") + 1)
                index -= 1
            else:
                index = len(cells)
            kind = cell.get("t")
            if kind == "inlineStr":
                text = "".join(node.text or "" for node in cell.iter(f"{{{NS}}}t"))
            elif kind == "s":
                node = cell.find(f"{{{NS}}}v")
                text = shared[int(node.text)] if node is not None and node.text else ""
            else:
                node = cell.find(f"{{{NS}}}v")
                text = node.text if node is not None and node.text is not None else ""
            cells[index] = text
        width = max(cells) + 1 if cells else 0
        table.append([cells.get(i, "") for i in range(width)])

    if not table:
        return []
    header = table[0]
    return [dict(zip(header, row + [""] * (len(header) - len(row)))) for row in table[1:]]
