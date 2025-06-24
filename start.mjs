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

const outputFilename = outPath + `metrics-${new Date().toISOString().slice(0, 10)}.csv`;

async function getPageMetrics(url, name) {
    let totalTransferredBytes = 0;
    let totalSameOriginTransferredBytes = 0;
    let totalCrossOriginTransferredBytes = 0;
    let totalTransferredResources = 0;
    let redirected = false;
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
            //console.warn(`[NetMoni] Fetched ${response.request().method()} request ${response.url()} for ${page.url()} (status code: ${response.status()})`);
            if (response.status() >= 301 && response.status() <= 399 && !redirected
                && new URL(page.url() == "about:blank" ? await response.headerValue('Location') : page.url()).pathname == new URL(url).pathname 
                && new URL(page.url() == "about:blank" ? await response.headerValue('Location') : page.url()).hostname != new URL(url).hostname) {
                console.log(`[PageMtr] Redirects found, redirecting to ${page.url() == "about:blank" ? await response.headerValue('Location') : page.url()}...`);
                totalCrossOriginTransferredBytes = 0;
                totalSameOriginTransferredBytes = 0;
                totalTransferredBytes = 0;
                totalTransferredResources = 0;
                redirected = true;
            }
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
            console.warn(`[NetMoni] Error processing response: ${error.message}`);
        }
    });
    try {
        await page.goto(url, { waitUntil: 'load', timeout: PG_TIMEOUT });
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
        await page.close();
        await context.close();
        if (e.name === 'TimeoutError') {
            return {
                pageLoadTime_ms: 'DNF',
                domContentLoadedTime_ms: 'DNF',
                totalTransferred_bytes: totalTransferredBytes,
                totalSameOriginTransferred_bytes: totalSameOriginTransferredBytes,
                totalCrossOriginTransferred_bytes: totalCrossOriginTransferredBytes,
                totalTransferredResources: totalTransferredResources,
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
    let datasets = [];
    fs.readdirSync('./datasets').forEach((f) => {
        if (f.endsWith('.json')) {
            let dataset = JSON.parse(fs.readFileSync(`./datasets/${f}`, 'utf-8'));
            datasets.push(dataset);
            console.log(`[PageMtr] Loaded dataset ${dataset.name} (${f}) with ${dataset.urls.length} sites.`);
        }
    });

    let pageDatas = [];

    for (let dataset of datasets) {
        console.log(`[PageMtr] Processing dataset ${dataset.name}...`);
        let sites = dataset.urls;
        for (let i = 0; i < sites.length; i++) {
            let site = sites[i];
            let indexPageMetricTimes = [];
            let otherPageMetricTimes = [];
            for (let i = 1; i <= 3; i++) {
                indexPageMetricTimes.push(await getPageMetrics(site, 'iter-' + i));
            }
            if (indexPageMetricTimes[2].otherPage != "N/A" && indexPageMetricTimes[2].otherPage != "DNF") {
                for (let i = 1; i <= 3; i++) {
                    otherPageMetricTimes.push(await getPageMetrics((indexPageMetricTimes[2].otherPage.startsWith('http') ? indexPageMetricTimes[2].otherPage : indexPageMetricTimes[2].actualPage + (indexPageMetricTimes[2].otherPage.startsWith('/') ? indexPageMetricTimes[2].otherPage.replace('/', '') : indexPageMetricTimes[2].otherPage)), 'other-iter-' + i));
                }
            }
            let pageData = {
                dataset: dataset.name,
                siteUrl: site,
                actualSiteUrl: indexPageMetricTimes[0].actualPage,
                metrics: indexPageMetricTimes,
                otherMetrics: otherPageMetricTimes
            }
            pageDatas.push(pageData);
            console.log(`[PageMtr] Collected metrics for ${site} (${i + 1}/${sites.length})`);
            console.log(`[PageMtr] Index Page Metrics:`, indexPageMetricTimes);
            console.log(`[PageMtr] Other Page Metrics:`, otherPageMetricTimes);
            console.log();
        }
    }

    console.log(`[PageMtr] Writing results to ${outputFilename}...`);

    let csvContent = "Dataset,Site URL,Actual Site URL,DOMContentLoaded #1,DOMContentLoaded #2,DOMContentLoaded #3,Page Load Time #1,Page Load Time #2,Page Load Time #3,Total Transferred Bytes,Total Same-Origin Transferred Bytes,Total Cross-Origin Transferred Bytes,Total Transferred Resources,DOM Element Count,Other Page,Other DOMContentLoaded Time #1,Other DOMContentLoaded Time #2,Other DOMContentLoaded Time #3,Other Page Load Time #1,Other Page Load Time #2,Other Page Load Time #3,Other Total Transferred Bytes,Other Total Same-Origin Transferred Bytes,Other Total Cross-Origin Transferred Bytes,Other Total Transferred Resources,Other DOM Element Count\n";

    for (let pageData of pageDatas) {
        let metrics = pageData.metrics;
        let otherMetrics = pageData.otherMetrics;

        csvContent += `${pageData.dataset},${pageData.siteUrl},${pageData.actualSiteUrl},${metrics[0].domContentLoadedTime_ms},${metrics[1].domContentLoadedTime_ms},${metrics[2].domContentLoadedTime_ms},${metrics[0].pageLoadTime_ms},${metrics[1].pageLoadTime_ms},${metrics[2].pageLoadTime_ms},${metrics[2].totalTransferred_bytes},${metrics[2].totalSameOriginTransferred_bytes},${metrics[2].totalCrossOriginTransferred_bytes},${metrics[2].totalTransferredResources},${metrics[2].domElementCount},${otherMetrics.length > 0 ? otherMetrics[0].actualPage : "N/A"},${otherMetrics.length > 0 ? otherMetrics[0].domContentLoadedTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[1].domContentLoadedTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].domContentLoadedTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[0].pageLoadTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[1].pageLoadTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].pageLoadTime_ms : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].totalTransferred_bytes : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].totalSameOriginTransferred_bytes : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].totalCrossOriginTransferred_bytes : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].totalTransferredResources : "N/A"},${otherMetrics.length > 0 ? otherMetrics[2].domElementCount : "N/A"}\n`;
    }

    fs.writeFileSync(outputFilename, csvContent, 'utf-8');
    console.log(`[PageMtr] Results written to ${outputFilename}`);
}

await loadPages();
await browser.close();