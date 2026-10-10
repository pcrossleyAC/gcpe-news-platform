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

describe("checkAttachment (spec addendum §8.4)", () => {
  it.each([
    ["Sample.pdf", PDF, "application/pdf"],
    ["SAMPLE.PDF", PDF, "application/pdf"],
    ["Sample.png", PNG, "image/png"],
    ["Sample.jpg", JPEG, "image/jpeg"],
    ["Sample.jpeg", JPEG, "image/jpeg"],
    ["Sample.gif", GIF, "image/gif"],
    ["Sample.docx", OOXML, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["Sample.xlsx", OOXML, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["Sample.pptx", OOXML, "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["Sample.doc", OLE, "application/msword"],
    ["Sample.xls", OLE, "application/vnd.ms-excel"],
    ["Sample.ppt", OLE, "application/vnd.ms-powerpoint"],
    ["Sample.msg", OLE, "application/vnd.ms-outlook"],
    ["Sample.rtf", RTF, "application/rtf"],
    ["Sample.txt", TEXT, "text/plain"],
    ["Sample.csv", TEXT, "text/csv"],
  ])("accepts %s as %s's type", (name, bytes, contentType) => {
    expect(checkAttachment(name, bytes)).toEqual({ ok: true, extension: extensionOf(name), contentType });
  });

  it.each([
    ["an empty file", "Sample.pdf", Buffer.alloc(0), "empty"],
    ["legacy's blocklist", "Sample.exe", Buffer.from("MZ"), "blocked"],
    ["legacy's blocklist, a long extension", "Sample.ps1xml", TEXT, "blocked"],
    ["legacy's blocklist, .json", "Sample.json", TEXT, "blocked"],
    ["a type outside the list", "Sample.html", HTML, "unsupported"],
    ["an SVG", "Sample.svg", Buffer.from("<svg/>"), "unsupported"],
    ["no extension", "Sample", PDF, "unsupported"],
    ["a trailing dot", "Sample.", PDF, "unsupported"],
    ["HTML named .pdf", "Sample.pdf", HTML, "mismatch"],
    ["an executable named .docx", "Sample.docx", Buffer.from("MZ\x90\x00", "latin1"), "mismatch"],
    ["a ZIP that isn't an Office file", "Sample.xlsx", PLAIN_ZIP, "mismatch"],
    ["a PNG named .jpg", "Sample.jpg", PNG, "mismatch"],
    ["text holding a NUL byte", "Sample.txt", Buffer.from("a\u0000b"), "mismatch"],
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
