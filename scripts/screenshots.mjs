import { chromium } from 'playwright';

const out = '/opt/cursor/artifacts';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:41773/', { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Ours' }).waitFor();
await page.screenshot({ path: `${out}/screenshot_locked.png` });

await page.getByRole('button', { name: 'Preview sample household' }).click();
await page.getByText('Sample household. These figures are fictional.').waitFor();
await page.getByText('Still to pay').waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_home.png` });

await page.getByRole('button', { name: /Still to pay/ }).click();
await page.getByRole('heading', { name: 'Tithing' }).waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_tithing.png` });
await page.getByRole('button', { name: 'Close' }).click();

await page.getByRole('button', { name: 'Worth' }).click();
await page.getByText('Sample house', { exact: true }).waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_worth.png` });

await page.getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Sample situation').selectOption('unconfigured');
await page.getByRole('button', { name: 'Home' }).click();
await page.getByText('Nothing is assumed').waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_unconfigured.png` });

await page.getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Sample situation').selectOption('empty');
await page.getByRole('button', { name: 'Home' }).click();
await page.getByText('No bank snapshot yet').waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_empty.png` });

await page.getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Sample situation').selectOption('stale');
await page.getByRole('button', { name: 'Home' }).click();
await page.getByText('A later import failed').waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_stale.png` });

await page.getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Sample situation').selectOption('error');
await page.getByRole('heading', { name: /reach the server/ }).waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_error.png` });
await page.getByRole('button', { name: 'Back to the sample' }).click();

await page.setViewportSize({ width: 1280, height: 900 });
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Sample situation').selectOption('ready');
await page.getByRole('button', { name: 'Home' }).click();
await page.getByText('Still to pay').waitFor();
await page.screenshot({ path: `${out}/screenshot_demo_desktop.png` });

await browser.close();
console.log('screenshots written');
