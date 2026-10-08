import type { TermKind } from "@gcpe/events";
import type { OrgInput } from "../services/organizations";
import type { TermInput } from "../services/terms";

export interface LegacyMinistryRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  SortOrder: number;
  DisplayName: string;
  Abbreviation: string | null;
  IsActive: boolean;
  MinisterEmail: string | null;
  MinisterPhotoUrl: string | null;
  MinisterPageHtml: string | null;
  MinisterAddress: string | null;
  MinisterName: string | null;
  MinisterSummary: string | null;
  MinistryUrl: string | null;
  ParentKey: string | null;
  WeekendContactNumber: string | null;
  DisplayAdditionalName: string | null;
  TwitterUsername: string | null;
  FlickrUrl: string | null;
  YoutubeUrl: string | null;
  AudioUrl: string | null;
  ContactUserId: number | null;
  ContactFullName: string | null;
  ContactPhone: string | null;
  ContactMobile: string | null;
  ContactEmail: string | null;
  SecondContactUserId: number | null;
  SecondContactFullName: string | null;
  SecondContactPhone: string | null;
  SecondContactMobile: string | null;
  SecondContactEmail: string | null;
}

export interface LegacyLinkRow extends Record<string, unknown> {
  MinistryId: string;
  SortIndex: number;
  LinkText: string;
  LinkUrl: string;
}

export interface LegacyMinistrySectorRow extends Record<string, unknown> {
  MinistryId: string;
  SectorKey: string;
}

export interface LegacyTermRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  SortOrder: number;
  IsActive: boolean;
  DisplayName: string | null;
  EnglishName?: string | null;
  TwitterUsername?: string | null;
  FlickrUrl?: string | null;
  YoutubeUrl?: string | null;
  AudioUrl?: string | null;
}

function links(rows: LegacyLinkRow[]) {
  return [...rows].sort((a, b) => a.SortIndex - b.SortIndex).map((r) => ({ text: r.LinkText, url: r.LinkUrl }));
}

function contact(id: number | null, fullName: string | null, phone: string | null, mobile: string | null, email: string | null) {
  if (id === null || id === undefined) return null;
  // A dangling foreign key (ContactUserId set, but the LEFT JOIN to calendar.SystemUser found no row)
  // yields all-null joined columns; treat that as "no contact" rather than an empty contact record.
  if (fullName === null && phone === null && mobile === null && email === null) return null;
  return { fullName, phoneNumber: phone, mobileNumber: mobile, emailAddress: email };
}

export function mapMinistry(
  row: LegacyMinistryRow,
  related: { topics: LegacyLinkRow[]; services: LegacyLinkRow[]; sectorKeys: string[] },
): OrgInput {
  return {
    key: row.Key,
    displayName: row.DisplayName,
    abbreviation: row.Abbreviation,
    sortOrder: row.SortOrder,
    isActive: Boolean(row.IsActive),
    parentKey: row.ParentKey,
    url: row.MinistryUrl,
    displayAdditionalName: row.DisplayAdditionalName,
    minister: {
      name: row.MinisterName,
      summary: row.MinisterSummary,
      detailsHtml: row.MinisterPageHtml,
      email: row.MinisterEmail,
      photoUrl: row.MinisterPhotoUrl,
      address: row.MinisterAddress,
    },
    contact: contact(row.ContactUserId, row.ContactFullName, row.ContactPhone, row.ContactMobile, row.ContactEmail),
    secondContact: contact(row.SecondContactUserId, row.SecondContactFullName, row.SecondContactPhone, row.SecondContactMobile, row.SecondContactEmail),
    weekendContactNumber: row.WeekendContactNumber,
    social: { twitterUsername: row.TwitterUsername, flickrUrl: row.FlickrUrl, youtubeUrl: row.YoutubeUrl, audioUrl: row.AudioUrl },
    topicLinks: links(related.topics),
    serviceLinks: links(related.services),
    sectorKeys: [...related.sectorKeys].sort(),
  };
}

export function mapTerm(kind: TermKind, row: LegacyTermRow): TermInput {
  return {
    kind,
    key: row.Key,
    displayName: row.DisplayName ?? row.EnglishName ?? null,
    sortOrder: row.SortOrder,
    isActive: Boolean(row.IsActive),
    social: {
      twitterUsername: row.TwitterUsername ?? null,
      flickrUrl: row.FlickrUrl ?? null,
      youtubeUrl: row.YoutubeUrl ?? null,
      audioUrl: row.AudioUrl ?? null,
    },
  };
}
