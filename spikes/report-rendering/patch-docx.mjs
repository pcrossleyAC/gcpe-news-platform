import JSZip from "jszip";
import { RUNNING } from "./templates.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
// turbodocx writes its header and footer parts in the default namespace (<ftr><p><r><t>), so a
// field closes and reopens the run in the part's own style and declares w: on itself.
const field = (code, prefix) =>
  `</${prefix}t></${prefix}r><w:fldSimple xmlns:w="${W}" w:instr=" ${code} "><w:r><w:t>1</w:t></w:r></w:fldSimple><${prefix}r><${prefix}t xml:space="preserve">`;
const escXml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * The measured fallback for Word's running text: turns {PAGE}/{NUMPAGES} into real fields, and
 * adds a different first-page header (w:titlePg plus a "first" header part), in schema order.
 */
export async function patchDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n))) {
    const xml = await zip.file(name).async("string");
    const prefix = /<w:ftr[\s>]/.test(xml) ? "w:" : "";
    zip.file(name, xml.replaceAll("{PAGE}", field("PAGE", prefix)).replaceAll("{NUMPAGES}", field("NUMPAGES", prefix)));
  }
  zip.file("word/header-first.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>${escXml(RUNNING.firstHeader)}</w:t></w:r></w:p></w:hdr>`);
  const rels = await zip.file("word/_rels/document.xml.rels").async("string");
  zip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rIdSpikeFirstHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-first.xml"/></Relationships>`));
  const types = await zip.file("[Content_Types].xml").async("string");
  zip.file("[Content_Types].xml", types.replace("</Types>", `<Override PartName="/word/header-first.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`));
  let docXml = await zip.file("word/document.xml").async("string");
  // CT_SectPr puts every header/footer reference first (turbodocx writes its own after pgSz and
  // pgMar), and titlePg after pgMar/cols and before docGrid.
  docXml = docXml.replace(/<w:sectPr([^>]*)>([\s\S]*?)<\/w:sectPr>/, (_, attrs, inner) => {
    const refs = inner.match(/<w:(header|footer)Reference [^>]*\/>/g) ?? [];
    let rest = inner.replace(/\s*<w:(header|footer)Reference [^>]*\/>/g, "");
    rest = /<w:docGrid/.test(rest) ? rest.replace(/<w:docGrid/, "<w:titlePg/><w:docGrid") : `${rest}<w:titlePg/>`;
    return `<w:sectPr${attrs}><w:headerReference w:type="first" r:id="rIdSpikeFirstHeader"/>${refs.join("")}${rest}</w:sectPr>`;
  });
  zip.file("word/document.xml", docXml);
  return zip.generateAsync({ type: "nodebuffer" });
}
