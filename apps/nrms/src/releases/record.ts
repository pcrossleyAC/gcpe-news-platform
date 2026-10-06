import { envelopeByteLength, MAX_EVENT_BYTES, releaseRecordSchema, sizingEnvelope, type ReleaseRecord } from "@gcpe/events";
import { LANG_EN, LANG_FR, POST_KIND, type ReleaseView } from "@gcpe/nrms-contract";
import { sanitizeBodyHtml } from "../text/sanitize";
import { ReleaseTooLargeError } from "./errors";

export function splitContact(information: string): { title: string; details: string } {
  const [title = "", ...rest] = information.split(/\r?\n/);
  return { title, details: rest.join("\n") };
}

export interface RecordOptions {
  /** PUBLIC_FILES_BASE: the public origin that `/files/<key>` is served from (e.g.
   * `https://boxs.ca`); "" (the default) leaves file URLs as root-relative paths. */
  filesBase?: string;
}

function fileList(v: ReleaseView, kind: "translation" | "asset", base: string): ReleaseRecord["translations"] {
  const files = v.files.filter((f) => f.kind === kind);
  return files.length ? files.map((f) => ({ key: `${base}${f.url}`, label: f.label, length: f.size })) : null;
}

export function toReleaseRecord(v: ReleaseView, at: { publishDate: string; timestamp: string }, opts: RecordOptions = {}): ReleaseRecord {
  const base = (opts.filesBase ?? "").replace(/\/+$/, "");
  const en = v.languages.find((l) => l.languageId === LANG_EN);
  const docs = [...v.documents].sort((a, b) => a.sortIndex - b.sortIndex);
  const documents = [LANG_EN, LANG_FR].flatMap((lang) =>
    docs.flatMap((d) => {
      const l = d.languages.find((x) => x.languageId === lang);
      if (!l) return [];
      return [{
        pageTitle: l.pageTitle, languageId: lang, headline: l.headline, subheadline: l.subheadline, detailsHtml: sanitizeBodyHtml(l.bodyHtml),
        byline: d.layout === "informal" ? l.byline : null, contacts: l.contacts.map(splitContact),
      }];
    }),
  );
  return {
    key: v.key!, kind: POST_KIND[v.type], reference: v.reference, atomId: v.atomId ?? `uuid:${v.id}`, publishDate: at.publishDate,
    leadMinistryKey: v.leadMinistryKey, summary: en?.summary || null, socialMediaSummary: en?.socialMediaSummary ?? null, socialMediaHeadline: null,
    keywords: v.keywords, location: en?.location || null, hasMediaAssets: v.hasMediaAssets, hasTranslations: v.hasTranslations,
    isNewsOnDemand: v.publishOptions.toSubscribers, assetUrl: v.assetUrl, redirectUri: v.redirectUrl, documents,
    ministryKeys: v.ministries, sectorKeys: v.sectors, tagKeys: v.tags, themeKeys: v.themes, assets: fileList(v, "asset", base), translations: fileList(v, "translation", base),
    publishFlags: { ...v.publishOptions }, mediaListKeys: v.mediaListKeys, renditions: null, timestamp: at.timestamp,
  };
}

export function assertPublishable(record: ReleaseRecord): void {
  releaseRecordSchema.parse(record);
  const bytes = envelopeByteLength(sizingEnvelope({ type: "release.published", source: "nrms", aggregateId: record.key, data: record }));
  if (bytes > MAX_EVENT_BYTES) throw new ReleaseTooLargeError(`This release would publish as ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}.`);
}
