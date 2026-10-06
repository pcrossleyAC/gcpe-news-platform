import { describe, expect, it, vi } from "vitest";
import { DistributionError } from "../distribution-client";
import type { RenderOptions } from "../render";
import { linkUrl, renderSystemEmail, sendSystemEmail } from "./emails";

const RENDER: RenderOptions = { siteUrl: "https://news.gov.bc.ca", bannerUrl: null };

describe("system emails", () => {
  it("uses the legacy subjects and wording, with the link in both parts", () => {
    const v = renderSystemEmail("verify", "https://boxs.ca/site/subscribe/manage/?token=abc", RENDER);
    expect(v.subject).toBe("BC Gov News On Demand Email Verification");
    expect(v.text).toContain("Thank you for subscribing to BC Gov News On Demand.");
    expect(v.text).toContain("To confirm your request and begin receiving communications by email, click here: https://boxs.ca/site/subscribe/manage/?token=abc");
    expect(v.html).toContain('href="https://boxs.ca/site/subscribe/manage/?token=abc"');
    expect(renderSystemEmail("manage", "https://x.test/m", RENDER).subject).toBe("BC Gov News On Demand Subscription Management");
    expect(renderSystemEmail("manage", "https://x.test/m", RENDER).text).toContain("To log in and manage your subscription, click here: https://x.test/m");
  });

  it("escapes the link in HTML", () => {
    expect(renderSystemEmail("manage", 'https://x.test/?a="b"&c', RENDER).html).toContain("https://x.test/?a=&quot;b&quot;&amp;c");
  });

  // Amendment 2026-10-05: a manage email shares the same banner/shell as every other NoD email,
  // with the one-cell "See more from BC Gov News" footer and no manage/unsubscribe cell.
  it("a manage email has the banner, the 'See more' link, and the do-not-respond line, with no manage or unsubscribe link", () => {
    const m = renderSystemEmail("manage", "https://x.test/m", RENDER);
    expect(m.html).toContain("Government of B.C.");
    expect(m.html).toContain(`href="${RENDER.siteUrl}"`);
    expect(m.html).toContain("See more from BC Gov News");
    expect(m.html).toContain("Please do not respond to this message");
    expect(m.html).not.toContain(">Manage your subscription</a>");
    expect(m.html).not.toContain("{{manageUrl}}");
    expect(m.html).not.toContain("{{unsubscribeUrl}}");
    expect(m.text).toContain("See more from BC Gov News");
    expect(m.text).toContain("Please do not respond to this message");
  });

  it("linkUrl keeps an existing query and sets token", () => {
    expect(linkUrl("https://x.test/manage/?lang=fr", "t1")).toBe("https://x.test/manage/?lang=fr&token=t1");
  });

  it("sends at system priority with an idempotency key, and never throws", async () => {
    const send = vi.fn().mockResolvedValueOnce({ batchId: "b" }).mockRejectedValueOnce(new Error("down"));
    await sendSystemEmail({ send }, "pat@example.test", "verify", "https://x.test/l", "link-1", RENDER);
    expect(send.mock.calls[0]![0]).toMatchObject({ priority: "system", idempotencyKey: "link-1", recipients: [{ email: "pat@example.test", substitutions: {} }] });
    await expect(sendSystemEmail({ send }, "pat@example.test", "manage", "https://x.test/l", "link-2", RENDER)).resolves.toBeUndefined();
  });

  it("logs only the Distribution status on a failed send, never its response body (Minor 10)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const send = vi.fn().mockRejectedValueOnce(new DistributionError('Distribution responded HTTP 400: {"secret":"shh"}', false, 400));
      await sendSystemEmail({ send }, "pat@example.test", "verify", "https://x.test/l", "link-1", RENDER);
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("400");
      expect(logged).not.toContain("shh");
      expect(logged).not.toContain("secret");
    } finally {
      errSpy.mockRestore();
    }
  });
});
