import { ApiError } from "../../api/client";

/** Same limit as the server's (apps/nrms/src/website/slide-images.ts MAX_SITE_IMAGE_BYTES). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_TOO_BIG = "That image is over 2 MB. Choose a smaller image.";

/** The server's rule for a slide's web addresses (website/slide-input.ts): empty, or a full http:// or https:// address of at most 255 characters. */
export function webAddressProblem(fieldName: string, value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (v.length > 255) return `Keep the ${fieldName} to 255 characters or fewer.`;
  if (!/^https?:\/\/\S+$/i.test(v)) return `Enter a full web address for ${fieldName}, starting with http:// or https://`;
  return null;
}

/** The message for each bad web address, keyed by field, so it can sit on its own field. */
export function slideAddressErrors(slide: { actionUrl: string; facebookPostUrl: string }): { actionUrl?: string; facebookPostUrl?: string } {
  const actionUrl = webAddressProblem("Action URL", slide.actionUrl);
  const facebookPostUrl = webAddressProblem("Facebook post URL", slide.facebookPostUrl);
  return { ...(actionUrl ? { actionUrl } : {}), ...(facebookPostUrl ? { facebookPostUrl } : {}) };
}

/** Checks a slide's two web addresses; `prefix` (such as "Slide 2" or "Primary") leads each message. */
export function slideAddressProblems(prefix: string, slide: { actionUrl: string; facebookPostUrl: string }): string[] {
  return [webAddressProblem("Action URL", slide.actionUrl), webAddressProblem("Facebook post URL", slide.facebookPostUrl)]
    .filter((p): p is string => p !== null)
    .map((p) => `${prefix}: ${p}`);
}

/** Plain wording for a failed image upload: too big (checked before sending, or the server's 413), else the server's own message. */
export function imageUploadMessage(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 413) return IMAGE_TOO_BIG;
  return caught instanceof Error ? caught.message : "Image upload failed.";
}
