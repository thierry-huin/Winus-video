const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  for (const [name, width] of [['390', 390], ['1440', 1440]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto('http://localhost:8899/qc.html');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/smoke-qc-${name}.png` });
    await page.close();
  }
  await browser.close();
  console.log('OK: screenshots captured');
})();
