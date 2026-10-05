import { describe, expect, it, vi } from "vitest";
import { linkUrl, renderSystemEmail, sendSystemEmail } from "./emails";

describe("system emails", () => {
  it("uses the legacy subjects and wording, with the link in both parts", () => {
    const v = renderSystemEmail("verify", "https://boxs.ca/site/subscribe/manage/?token=abc");
    expect(v.subject).toBe("BC Gov News On Demand Email Verification");
    expect(v.text).toContain("Thank you for subscribing to BC Gov News On Demand.");
    expect(v.text).toContain("To confirm your request and begin receiving communications by email, click here: https://boxs.ca/site/subscribe/manage/?token=abc");
    expect(v.html).toContain('href="https://boxs.ca/site/subscribe/manage/?token=abc"');
    expect(renderSystemEmail("manage", "https://x.test/m").subject).toBe("BC Gov News On Demand Subscription Management");
    expect(renderSystemEmail("manage", "https://x.test/m").text).toContain("To log in and manage your subscription, click here: https://x.test/m");
  });

  it("escapes the link in HTML", () => {
    expect(renderSystemEmail("manage", 'https://x.test/?a="b"&c').html).toContain("https://x.test/?a=&quot;b&quot;&amp;c");
  });

  it("linkUrl keeps an existing query and sets token", () => {
    expect(linkUrl("https://x.test/manage/?lang=fr", "t1")).toBe("https://x.test/manage/?lang=fr&token=t1");
  });

  it("sends at system priority with an idempotency key, and never throws", async () => {
    const send = vi.fn().mockResolvedValueOnce({ batchId: "b" }).mockRejectedValueOnce(new Error("down"));
    await sendSystemEmail({ send }, "pat@example.test", "verify", "https://x.test/l", "link-1");
    expect(send.mock.calls[0]![0]).toMatchObject({ priority: "system", idempotencyKey: "link-1", recipients: [{ email: "pat@example.test", substitutions: {} }] });
    await expect(sendSystemEmail({ send }, "pat@example.test", "manage", "https://x.test/l", "link-2")).resolves.toBeUndefined();
  });
});
