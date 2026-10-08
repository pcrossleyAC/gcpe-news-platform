import puppeteer from "puppeteer-core";

/** Launches Chromium over a pipe (no WebSocket: SiteGround's runtime blocks loopback). */
export async function launch(host) {
  if (host.startsWith("siteground")) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true, pipe: true });
  }
  if (!process.env.CHROMIUM_PATH) throw new Error("set CHROMIUM_PATH to a local chrome-headless-shell");
  return puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"], headless: true, pipe: true });
}

/** One HTML document → PDF, honouring @page size and margin boxes. */
export async function renderPdf(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await page.close();
  }
}
