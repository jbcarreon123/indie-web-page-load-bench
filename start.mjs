import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const PG_TIMEOUT = 60000;

let browser = await chromium.launch({
    headless: true
})

let outPath = `./results/`;
if (!fs.existsSync(outPath)) {
    fs.mkdirSync(outPath, { recursive: true })
} else {
    fs.readdirSync(outPath).forEach((f) => {
        fs.rmSync(path.join(outPath, f), { recursive: true, force: true })
    })
}

const outputFilename = outPath + `metrics-${new Date().toISOString().slice(0, 10)}.json`;

async function getPageMetrics(url, name) {
    let totalTransferredBytes = 0;
    let totalSameOriginTransferredBytes = 0;
    let totalCrossOriginTransferredBytes = 0;
    let totalTransferredResources = 0;
    console.log(`[PageMtr] Getting page metrics of URL ${url}... (${name})`);
    let pagePath = `./results/har/${new URL(url).hostname}`;
    if (!fs.existsSync(pagePath)) {
        fs.mkdirSync(pagePath, { recursive: true })
    }
    let context = await browser.newContext({
        recordHar: {
            content: 'omit',
            path: pagePath + `/results-${name}.har`
        }
    })
    let page = await context.newPage();
    await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    })
    page.removeAllListeners('response');
    page.on('response', async response => {
        try {
            console.warn(`[NetMoni] Trying to ${response.request().method()} request ${response.url()} for ${page.url()}...`);
            if (response.status() < 200 || response.status() >= 400) {
                return;
            }
            const headers = response.headers();
            const contentLength = headers['content-length'];
            if (contentLength) {
                totalTransferredBytes += parseInt(contentLength, 10);
                if (new URL(response.url()).hostname == new URL(url).hostname) {
                    totalSameOriginTransferredBytes += parseInt(contentLength, 10)
                } else {
                    totalCrossOriginTransferredBytes += parseInt(contentLength, 10)
                }
            } else {
                const buffer = await response.body();
                totalTransferredBytes += buffer.length;
                if (new URL(response.url()).hostname == new URL(url).hostname) {
                    totalSameOriginTransferredBytes += parseInt(buffer.length, 10)
                } else {
                    totalCrossOriginTransferredBytes += parseInt(buffer.length, 10)
                }
            }
            totalTransferredResources++;
        } catch (error) {
            if (error.message.includes('Response body is unavailable for redirect responses')) {
                console.log(`[PageMtr] Redirects found, redirecting to ${page.url()}`);
                totalCrossOriginTransferredBytes = 0;
                totalSameOriginTransferredBytes = 0;
                totalTransferredBytes = 0;
                totalTransferredResources = 0;
            }
            console.warn(`[NetMoni] Error processing response: ${error.message}`);
        }
    });
    try {
        console.log(`[PageMtr] trying ${url}...`)
        await page.goto(url, { waitUntil: 'commit', timeout: PG_TIMEOUT });
        await page.waitForLoadState('load', { timeout: PG_TIMEOUT });
        const performanceTiming = await page.evaluate(() => {
            return performance.getEntriesByType('navigation')[0];
        });
        const domElementCount = await page.evaluate(() => {
            return document.querySelectorAll('*').length;
        });

        let otherPage = "N/A";
        const locators = page.locator('a');
        const count = await locators.count();

        if (count > 0) {
            for (let i = 0; i < count; i++) {
                const el = locators.nth(i);
                let href = await el.getAttribute('href');
                try {
                    let u = new URL(href);
                    if (u.hostname != new URL(page.url()).hostname) continue;
                } catch { }
                if (href !== "/" && href !== "/index.html" && href && !href.startsWith('#') && !href.startsWith('?')) {
                    otherPage = href;
                    break;
                }
            }
        }

        await page.close();
        await context.close();

        return {
            pageLoadTime_ms: parseFloat((performanceTiming.loadEventEnd - performanceTiming.startTime).toFixed(2)),
            domContentLoadedTime_ms: parseFloat((performanceTiming.domContentLoadedEventEnd - performanceTiming.startTime).toFixed(2)),
            totalTransferred_bytes: totalTransferredBytes,
            totalSameOriginTransferred_bytes: totalSameOriginTransferredBytes,
            totalCrossOriginTransferred_bytes: totalCrossOriginTransferredBytes,
            totalTransferredResources: totalTransferredResources,
            domElementCount: domElementCount,
            actualPage: page.url(),
            otherPage: otherPage
        }
    } catch (e) {
        console.error(e);
        if (e.name === 'TimeoutError') {
            return {
                pageLoadTime_ms: 'DNF',
                domContentLoadedTime_ms: 'DNF',
                totalTransferred_bytes: 'DNF',
                totalSameOriginTransferred_bytes: 'DNF',
                totalCrossOriginTransferred_bytes: 'DNF',
                totalTransferredResources: 'DNF',
                domElementCount: 'DNF',
                actualPage: 'DNF',
                otherPage: 'DNF'
            }
        }
        return {
            pageLoadTime_ms: 'N/A',
            domContentLoadedTime_ms: 'N/A',
            totalTransferred_bytes: 'N/A',
            totalSameOriginTransferred_bytes: 'N/A',
            totalCrossOriginTransferred_bytes: 'N/A',
            totalTransferredResources: 'N/A',
            domElementCount: 'N/A',
            actualPage: 'N/A',
            otherPage: 'N/A'
        }
    }
}

async function loadPages() {
    let jsonFile = fs.readFileSync('./pages.json', 'utf-8');
    /**  @type {string[]} */
    let json = JSON.parse(jsonFile);

    let pageDatas = [];

    for (let i = 0; i < json.length; i++) {
        let site = json[i];
        let indexPageMetricTimes = [];
        let otherPageMetricTimes = [];
        for (let i = 1; i <= 3; i++) {
            indexPageMetricTimes.push(await getPageMetrics(site, 'iter-' + i));
        }
        if (indexPageMetricTimes[2].otherPage != "N/A" && indexPageMetricTimes[2].otherPage != "DNF") {
            for (let i = 1; i <= 3; i++) {
                otherPageMetricTimes.push(await getPageMetrics((indexPageMetricTimes[2].otherPage.startsWith('http') ? indexPageMetricTimes[2].otherPage : site + indexPageMetricTimes[2].otherPage), 'other-iter-' + i));
            }
        }
        let pageData = {
            siteUrl: site,
            actualSiteUrl: indexPageMetricTimes[0].actualPage,
            metrics: indexPageMetricTimes,
            otherMetrics: otherPageMetricTimes
        }
        console.log(pageData);
        pageDatas.push(pageData);
    }

    fs.writeFileSync(outputFilename, JSON.stringify(pageDatas));
}

await loadPages();

await browser.close();