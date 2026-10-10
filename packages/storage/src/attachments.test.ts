import { describe, expect, it } from "vitest";
import { ATTACHMENT_TYPES, BLOCKED_EXTENSIONS, checkAttachment, downloadContentType, extensionOf } from "./attachments";

const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "latin1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a\x01\x00", "latin1");
const OOXML = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\x14\x00[Content_Types].xml<Types/>", "latin1")]);
const PLAIN_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\x14\x00word.txt", "latin1")]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const RTF = Buffer.from("{\\rtf1\\ansi sample}", "latin1");
const TEXT = Buffer.from("Sample notes, line one\r\nline two\n", "utf8");
const HTML = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
const UTF8_BOM_PDF = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF]);
const WHITESPACE_PDF = Buffer.concat([Buffer.from(" \t\r\n", "latin1"), PDF]);
const JUNK_PDF = Buffer.concat([Buffer.from("XXX", "latin1"), PDF]);
const UTF16LE_TEXT = Buffer.from("﻿Sample text", "utf16le");
const UTF16BE_TEXT = Buffer.from([0xfe, 0xff, 0x00, 0x53, 0x00, 0x61, 0x00, 0x6d]);

describe("checkAttachment (spec addendum §8.4)", () => {
  it.each([
    { label: "Sample.pdf", name: "Sample.pdf", bytes: PDF, contentType: "application/pdf" },
    { label: "SAMPLE.PDF", name: "SAMPLE.PDF", bytes: PDF, contentType: "application/pdf" },
    { label: "Sample.pdf (UTF-8 BOM before %PDF-)", name: "Sample.pdf", bytes: UTF8_BOM_PDF, contentType: "application/pdf" },
    { label: "Sample.pdf (whitespace before %PDF-)", name: "Sample.pdf", bytes: WHITESPACE_PDF, contentType: "application/pdf" },
    { label: "Sample.png", name: "Sample.png", bytes: PNG, contentType: "image/png" },
    { label: "Sample.jpg", name: "Sample.jpg", bytes: JPEG, contentType: "image/jpeg" },
    { label: "Sample.jpeg", name: "Sample.jpeg", bytes: JPEG, contentType: "image/jpeg" },
    { label: "Sample.gif", name: "Sample.gif", bytes: GIF, contentType: "image/gif" },
    { label: "Sample.docx", name: "Sample.docx", bytes: OOXML, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { label: "Sample.xlsx", name: "Sample.xlsx", bytes: OOXML, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { label: "Sample.pptx", name: "Sample.pptx", bytes: OOXML, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    { label: "Sample.doc", name: "Sample.doc", bytes: OLE, contentType: "application/msword" },
    { label: "Sample.xls", name: "Sample.xls", bytes: OLE, contentType: "application/vnd.ms-excel" },
    { label: "Sample.ppt", name: "Sample.ppt", bytes: OLE, contentType: "application/vnd.ms-powerpoint" },
    { label: "Sample.msg", name: "Sample.msg", bytes: OLE, contentType: "application/vnd.ms-outlook" },
    { label: "Sample.rtf", name: "Sample.rtf", bytes: RTF, contentType: "application/rtf" },
    { label: "Sample.txt", name: "Sample.txt", bytes: TEXT, contentType: "text/plain" },
    { label: "Sample.csv", name: "Sample.csv", bytes: TEXT, contentType: "text/csv" },
    { label: "Sample.txt (HTML body)", name: "Sample.txt", bytes: HTML, contentType: "text/plain" },
    { label: "Sample.txt (UTF-16LE BOM)", name: "Sample.txt", bytes: UTF16LE_TEXT, contentType: "text/plain" },
    { label: "Sample.csv (UTF-16LE BOM)", name: "Sample.csv", bytes: UTF16LE_TEXT, contentType: "text/csv" },
    { label: "Sample.txt (UTF-16BE BOM)", name: "Sample.txt", bytes: UTF16BE_TEXT, contentType: "text/plain" },
  ])("accepts $label as $contentType", ({ name, bytes, contentType }) => {
    expect(checkAttachment(name, bytes)).toEqual({ ok: true, extension: extensionOf(name), contentType });
  });

  it.each([
    ["an empty file", "Sample.pdf", Buffer.alloc(0), "empty"],
    ["legacy's blocklist", "Sample.exe", Buffer.from("MZ"), "blocked"],
    ["legacy's blocklist, a long extension", "Sample.ps1xml", TEXT, "blocked"],
    ["legacy's blocklist, .json", "Sample.json", TEXT, "blocked"],
    ["a double extension, the real one blocked", "a.pdf.exe", PDF, "blocked"],
    ["a type outside the list", "Sample.html", HTML, "unsupported"],
    ["an SVG", "Sample.svg", Buffer.from("<svg/>"), "unsupported"],
    ["no extension", "Sample", PDF, "unsupported"],
    ["a trailing dot", "Sample.", PDF, "unsupported"],
    ["no base before the extension", ".pdf", PDF, "unsupported"],
    ["a prototype-shaped extension", "a.__proto__", PDF, "unsupported"],
    ["a constructor-shaped extension", "a.constructor", PDF, "unsupported"],
    ["a trailing space in the extension", "a.pdf ", PDF, "unsupported"],
    ["HTML named .pdf", "Sample.pdf", HTML, "mismatch"],
    ["an executable named .docx", "Sample.docx", Buffer.from("MZ\x90\x00", "latin1"), "mismatch"],
    ["a ZIP that isn't an Office file", "Sample.xlsx", PLAIN_ZIP, "mismatch"],
    ["a PNG named .jpg", "Sample.jpg", PNG, "mismatch"],
    ["text holding a NUL byte", "Sample.txt", Buffer.from("a\u0000b"), "mismatch"],
    ["junk before %PDF- (past a BOM or whitespace)", "Sample.pdf", JUNK_PDF, "mismatch"],
  ])("refuses %s", (_what, name, bytes, problem) => {
    expect(checkAttachment(name, bytes)).toEqual({ ok: false, problem });
  });

  it("keeps every one of legacy's blocked extensions (Activity.aspx.cs:1274-1391), and none of them is allowed", () => {
    expect(BLOCKED_EXTENSIONS.size).toBe(105);
    for (const ext of Object.keys(ATTACHMENT_TYPES)) expect(BLOCKED_EXTENSIONS.has(ext)).toBe(false);
  });

  it("serves a stored type only when it is one of the list's; anything else is a plain download", () => {
    expect(downloadContentType("application/pdf")).toBe("application/pdf");
    expect(downloadContentType("text/html")).toBe("application/octet-stream");
    expect(downloadContentType("image/svg+xml")).toBe("application/octet-stream");
  });

  it("reads the extension after the last dot, lower-cased", () => {
    expect(extensionOf("a.b.PDF")).toBe("pdf");
    expect(extensionOf("noext")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
  });
});
