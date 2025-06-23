const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Increased default timeout for page navigation and load states
const DEFAULT_PAGE_TIMEOUT = 60000; // 90 seconds
// Increased default timeout for element visibility waits
const DEFAULT_ELEMENT_WAIT_TIMEOUT = 15000; // 15 seconds

/**
 * Measures performance metrics for a page load.
 * This function is now generalized to be used for both initial and homepage navigations.
 * @param {import('playwright').Page} page - The Playwright page object.
 * @param {string} url - The URL to navigate to.
 * @returns {Promise<object>} An object containing detailed page load metrics.
 */
async function getPageLoadMetrics(page, url) {
  let totalTransferredBytes = 0;
  // It's crucial to remove all listeners before adding to prevent duplicates across multiple calls
  page.removeAllListeners('response');

  page.on('response', async response => {
    try {
      // Only count successful responses (HTTP 2xx)
      if (response.status() < 200 || response.status() >= 400) {
        return;
      }
      const headers = response.headers();
      const contentLength = headers['content-length'];
      if (contentLength) {
        totalTransferredBytes += parseInt(contentLength, 10);
      } else {
        // Fallback for resources without Content-Length header (e.g., streaming, chunked)
        // Note: response.body() can be memory-intensive for very large responses.
        const buffer = await response.body();
        totalTransferredBytes += buffer.length;
      }
    } catch (error) {
      // Ignore errors (e.g., cross-origin, failed requests, network issues)
      console.warn(`  [Network Monitor] Error processing response: ${error.message}`);
    }
  });

  const startTime = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_PAGE_TIMEOUT });
  const domContentLoadedTime = performance.now() - startTime;

  await page.waitForLoadState('load', { timeout: DEFAULT_PAGE_TIMEOUT });
  const loadTime = performance.now() - startTime;

  const performanceTiming = await page.evaluate(() => {
    return performance.getEntriesByType('navigation')[0];
  });

  const domElementCount = await page.evaluate(() => {
    return document.querySelectorAll('*').length;
  });

  return {
    domContentLoadedTime_ms: parseFloat(domContentLoadedTime.toFixed(2)),
    loadTime_ms: parseFloat(loadTime.toFixed(2)),
    // API times from Navigation Timing API (if available)
    pageLoadApiTime_ms: performanceTiming ? parseFloat((performanceTiming.loadEventEnd - performanceTiming.startTime).toFixed(2)) : 'N/A',
    domContentLoadedApiTime_ms: performanceTiming ? parseFloat((performanceTiming.domContentLoadedEventEnd - performanceTiming.startTime).toFixed(2)) : 'N/A',
    pageSize_Bytes: totalTransferredBytes,
    pageSize_MB: parseFloat((totalTransferredBytes / (1024 * 1024)).toFixed(2)),
    domElementCount: domElementCount,
  };
}

/**
 * Finds the homepage link on a given page, without clicking it.
 * This function is run once per site to identify the target URL.
 * @param {import('playwright').Page} page - The Playwright page object.
 * @param {string} initialUrl - The URL of the page where the link is found.
 * @returns {Promise<{ found: boolean, href: string }>} Object indicating if link was found and its href.
 */
async function findHomepageLinkOnce(page, initialUrl) {
    let foundHref = 'N/A';
    let linkFound = false;

    try {
        const currentDomain = new URL(initialUrl).origin;
        console.log(`    [Homepage Link Finder] Attempting to find homepage link on ${initialUrl}...`);

        const homepageSelectors = [
            'a[href="/"]',
            'a[href="/index.html"]',
            'a[href="/home.html"]',
            'a:has(img[alt*="logo" i])',
            'a:has(img[alt*="home" i])',
            'a:has(img[alt*="site title" i])',
            'a:has(img[alt])',
            'a:has(img[class*="logo" i])',
            'a:has(img[src*="logo" i])',
            'a:has(img[src*="home" i])',
            'a:has(img)',
            'a:has-text("Home")',
            'a:has-text("home")',
            'a:has-text("Blog")',
            'a:has-text("Main")',
            'h1 a, h2 a',
            'a[title*="Home" i]',
            'a[aria-label*="Home" i]',
            'a[rel="home"]',
            'a[rel="start"]',
            'a.navbar-brand',
            'a#logo',
            'a.home-link',
            'a.site-title',
            'a.site-header a',
            'a[href*="/"]',
        ];

        for (const selector of homepageSelectors) {
            const locators = page.locator(selector);
            const count = await locators.count();

            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    const locator = locators.nth(i);
                    let elementReady = true;

                    if (elementReady) {
                        const href = await locator.getAttribute('href');
                        if (href) {
                            const absoluteHref = new URL(href, page.url()).href;
                            if (absoluteHref.startsWith(currentDomain)) {
                                if (href === '/') {
                                    foundHref = absoluteHref;
                                    linkFound = true;
                                    console.log(`      [Homepage Link Finder] Found confident homepage link (root): ${foundHref}`);
                                    break;
                                }

                                if (href === '/index.html' || href === '/home.html') {
                                    if (!linkFound || (foundHref !== currentDomain + '/')) {
                                        foundHref = absoluteHref;
                                        linkFound = true;
                                        console.log(`      [Homepage Link Finder] Found confident homepage link (filename): ${foundHref}`);
                                        break;
                                    }
                                }

                                const relativePath = new URL(absoluteHref).pathname;
                                const isShortRelativePath = relativePath === '/' || relativePath.split('/').filter(p => p).length <= 1 || relativePath.endsWith('/index.html') || relativePath.endsWith('/home.html');

                                if (isShortRelativePath) {
                                    if (!linkFound) {
                                        foundHref = absoluteHref;
                                        linkFound = true;
                                        console.log(`      [Homepage Link Finder] Found suitable homepage link (short relative path): ${foundHref}`);
                                    }
                                }
                            }
                        }
                    }
                }
                if (linkFound && (foundHref === currentDomain + '/' || foundHref.endsWith('/index.html') || foundHref.endsWith('/home.html'))) {
                    break;
                }
            }
        }
        if (!linkFound) {
            console.log(`    [Homepage Link Finder] No suitable homepage link found for ${initialUrl}.`);
        }
    } catch (error) {
        console.error(`    [Homepage Link Finder ERROR] An error occurred while finding the link:`, error.message);
    }
    return { found: linkFound, href: foundHref };
}

/**
 * Calculates the average of a metric from an array of results.
 * Handles numeric values and a special case for boolean 'homepageLinkFound'.
 * @param {Array<object>} metricsArray - Array of metric objects from individual tries.
 * @param {string} metricName - The name of the metric to average.
 * @returns {number|string|boolean} The average, 'N/A', or a boolean.
 */
function calculateAverage(metricsArray, metricName) {
  // Special handling for boolean 'homepageLinkFound' which indicates if *any* link was found for the site
  if (metricName === 'homepageLinkFound') {
      const trueCount = metricsArray.filter(m => m[metricName] === true).length;
      return trueCount > 0; // Returns true if at least one attempt found the link
  }

  // Filter out non-numeric values and 'N/A' or 'DNF' for average calculation
  const values = metricsArray
    .map(m => m[metricName])
    .filter(val => typeof val === 'number' && !isNaN(val));

  if (values.length === 0) {
    return 'N/A';
  }

  const sum = values.reduce((acc, val) => acc + val, 0);
  return parseFloat((sum / values.length).toFixed(2));
}

(async () => {
  const pagesFilePath = path.join(__dirname, 'pages.json');
  let urlsToTest = [];

  console.log(`[Main] Attempting to load URLs from ${pagesFilePath}...`);
  try {
    const fileContent = fs.readFileSync(pagesFilePath, 'utf8');
    urlsToTest = JSON.parse(fileContent);
    if (!Array.isArray(urlsToTest)) {
      throw new Error("Parsed JSON is not an array. Ensure pages.json contains a JSON array of URLs.");
    }
    console.log(`[Main] Successfully loaded ${urlsToTest.length} URLs from pages.json.`);
  } catch (error) {
    console.error(`[Main] ERROR: Could not load or parse pages.json:`, error.message);
    console.error(`[Main] Please ensure 'pages.json' exists in the same directory and contains a valid JSON array of strings.`);
    process.exit(1);
  }

  const NUM_TRIES_INITIAL_LOAD = 3;
  const NUM_TRIES_HOMEPAGE_NAVIGATION = 3;

  const outputFilename = `performance_metrics_individual_tries_${new Date().toISOString().slice(0, 10)}.csv`;
  const outputPath = path.join(__dirname, outputFilename);

  console.log(`[Main] Starting Playwright performance analysis...`);
  console.log(`[Main] Initial page load: ${NUM_TRIES_INITIAL_LOAD} tries per URL.`);
  console.log(`[Main] Homepage navigation: ${NUM_TRIES_HOMEPAGE_NAVIGATION} tries per URL.`);
  console.log(`[Main] Output will be saved to: ${outputPath}`);

  try {
    const browser = await chromium.launch({ headless: true });
    console.log(`[Main] Browser launched successfully.`);

    const header = [
      'URL',
      'Try_Number',
      'Measurement_Type', // "Initial Load" or "Homepage Navigation"
      'HomepageLinkFound_Site', // Was a link identified for this site at all? (True/False)
      'HomepageLinkHref_Identified', // The href that was identified once for the site
      'DOMContentLoadedTime_ms',
      'LoadTime_ms',
      'PageLoadApiTime_ms',
      'DOMContentLoadedApiTime_ms',
      'PageSize_Bytes',
      'PageSize_MB',
      'DOMElementCount'
    ].join(',');

    fs.writeFileSync(outputPath, header + '\n');
    console.log(`[Main] CSV header written to ${outputPath}.`);

    for (const url of urlsToTest) {
      console.log(`\n--- [Site Loop] Processing URL: ${url} ---`);

      // --- Homepage Link Identification (Only Once per Site) ---
      console.log(`  [Site Loop] Identifying homepage link for ${url} (only once)...`);
      let identifiedHomepageHref = 'N/A';
      let homepageLinkFoundOverall = false; // True if any link was identified for this site

      let tempPageForLinkFinding;
      try {
          tempPageForLinkFinding = await browser.newPage();
          await tempPageForLinkFinding.goto(url, { waitUntil: 'load', timeout: DEFAULT_PAGE_TIMEOUT });
          const linkResult = await findHomepageLinkOnce(tempPageForLinkFinding, url);
          identifiedHomepageHref = linkResult.href;
          homepageLinkFoundOverall = linkResult.found;
          console.log(`  [Site Loop] Identified homepage link: ${identifiedHomepageHref} (Found: ${homepageLinkFoundOverall})`);
      } catch (error) {
          console.error(`  [Site Loop ERROR] Failed to identify homepage link for ${url}:`, error.message);
      } finally {
          if (tempPageForLinkFinding) {
              await tempPageForLinkFinding.close();
          }
      }

      // --- Initial Page Load Measurements (Individual Tries) ---
      console.log(`  [Site Loop] Measuring initial page load for ${url} (${NUM_TRIES_INITIAL_LOAD} tries)...`);
      const initialLoadMetricsOverTries = [];
      for (let i = 0; i < NUM_TRIES_INITIAL_LOAD; i++) {
        let page;
        let metrics = {};
        let status = 'N/A'; // Default for any error
        try {
          console.log(`    [Initial Load Try] Starting Try ${i + 1}/${NUM_TRIES_INITIAL_LOAD}...`);
          page = await browser.newPage();
          metrics = await getPageLoadMetrics(page, url);
          status = 'Success'; // Mark as success if no error
        } catch (error) {
          console.error(`      [ERROR] Initial Load Try ${i + 1} for ${url} failed:`, error.message);
          if (error.name === 'TimeoutError') {
              status = 'DNF'; // Specific DNF for timeouts
          }
          // Set metrics to the determined status string
          metrics = {
            error: error.message,
            domContentLoadedTime_ms: status,
            loadTime_ms: status,
            pageLoadApiTime_ms: status,
            domContentLoadedApiTime_ms: status,
            pageSize_Bytes: status,
            pageSize_MB: status,
            domElementCount: status
          };
        } finally {
          initialLoadMetricsOverTries.push(metrics); // Push collected metrics or error placeholders

          const dataRow = [
            `"${url}"`,
            i + 1,
            `"Initial Load"`,
            homepageLinkFoundOverall,
            `"${identifiedHomepageHref}"`,
            metrics.domContentLoadedTime_ms,
            metrics.loadTime_ms,
            metrics.pageLoadApiTime_ms,
            metrics.domContentLoadedApiTime_ms,
            metrics.pageSize_Bytes,
            metrics.pageSize_MB,
            metrics.domElementCount
          ].join(',');
          fs.appendFileSync(outputPath, dataRow + '\n');
          console.log(`      [Initial Load Try] Data for Try ${i + 1} appended (Status: ${status}).`);

          if (page) {
            await page.close();
          }
        }
      }
      // Log average to console for quick summary
      const avgInitialLoadMetrics = {
        domContentLoadedTime_ms: calculateAverage(initialLoadMetricsOverTries, 'domContentLoadedTime_ms'),
        loadTime_ms: calculateAverage(initialLoadMetricsOverTries, 'loadTime_ms'),
        pageLoadApiTime_ms: calculateAverage(initialLoadMetricsOverTries, 'pageLoadApiTime_ms'),
        domContentLoadedApiTime_ms: calculateAverage(initialLoadMetricsOverTries, 'domContentLoadedApiTime_ms'),
        pageSize_Bytes: calculateAverage(initialLoadMetricsOverTries, 'pageSize_Bytes'),
        pageSize_MB: calculateAverage(initialLoadMetricsOverTries, 'pageSize_MB'),
        domElementCount: calculateAverage(initialLoadMetricsOverTries, 'domElementCount'),
      };
      console.log(`  [Site Loop] Average initial load metrics for ${url}:`, avgInitialLoadMetrics);


      // --- Homepage Navigation Measurements (Individual Tries) ---
      console.log(`  [Site Loop] Measuring homepage navigation for ${url} (${NUM_TRIES_HOMEPAGE_NAVIGATION} tries)...`);
      const homepageNavigationMetricsOverTries = [];
      if (homepageLinkFoundOverall) {
          for (let i = 0; i < NUM_TRIES_HOMEPAGE_NAVIGATION; i++) {
              let pageForNavigation;
              let metrics = {};
              let status = 'N/A'; // Default for any error
              try {
                  console.log(`    [Homepage Navigation Try] Starting Try ${i + 1}/${NUM_TRIES_HOMEPAGE_NAVIGATION}...`);
                  pageForNavigation = await browser.newPage();
                  metrics = await getPageLoadMetrics(pageForNavigation, identifiedHomepageHref);
                  status = 'Success';
              } catch (error) {
                  console.error(`      [ERROR] Homepage Navigation Try ${i + 1} for ${url} failed:`, error.message);
                  if (error.name === 'TimeoutError') {
                      status = 'DNF'; // Specific DNF for timeouts
                  }
                  // Set metrics to the determined status string
                  metrics = {
                    error: error.message,
                    domContentLoadedTime_ms: status,
                    loadTime_ms: status,
                    pageLoadApiTime_ms: status,
                    domContentLoadedApiTime_ms: status,
                    pageSize_Bytes: status,
                    pageSize_MB: status,
                    domElementCount: status
                  };
              } finally {
                  homepageNavigationMetricsOverTries.push(metrics); // Push collected metrics or error placeholders

                  const dataRow = [
                    `"${url}"`,
                    i + 1,
                    `"Homepage Navigation"`,
                    homepageLinkFoundOverall,
                    `"${identifiedHomepageHref}"`,
                    metrics.domContentLoadedTime_ms,
                    metrics.loadTime_ms,
                    metrics.pageLoadApiTime_ms,
                    metrics.domContentLoadedApiTime_ms,
                    metrics.pageSize_Bytes,
                    metrics.pageSize_MB,
                    metrics.domElementCount
                  ].join(',');
                  fs.appendFileSync(outputPath, dataRow + '\n');
                  console.log(`      [Homepage Navigation Try] Data for Try ${i + 1} appended (Status: ${status}).`);

                  if (pageForNavigation) {
                      await pageForNavigation.close();
                  }
              }
          }
      } else {
          console.log(`  [Site Loop] Skipping homepage navigation measurements as no link was identified.`);
          // Append DNF/N/A rows if no link was found at all
          for (let i = 0; i < NUM_TRIES_HOMEPAGE_NAVIGATION; i++) {
            const dataRow = [
              `"${url}"`,
              i + 1,
              `"Homepage Navigation"`,
              homepageLinkFoundOverall,
              `"${identifiedHomepageHref}"`,
              'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A' // All metrics as N/A since no navigation was attempted
            ].join(',');
            fs.appendFileSync(outputPath, dataRow + '\n');
          }
      }

      // Log average to console for quick summary
      const avgHomepageNavigationMetrics = {
        loadTime_ms: calculateAverage(homepageNavigationMetricsOverTries, 'loadTime_ms'),
        domContentLoadedTime_ms: calculateAverage(homepageNavigationMetricsOverTries, 'domContentLoadedTime_ms'),
        pageLoadApiTime_ms: calculateAverage(homepageNavigationMetricsOverTries, 'pageLoadApiTime_ms'),
        domContentLoadedApiTime_ms: calculateAverage(homepageNavigationMetricsOverTries, 'domContentLoadedApiTime_ms'),
        pageSize_Bytes: calculateAverage(homepageNavigationMetricsOverTries, 'pageSize_Bytes'),
        pageSize_MB: calculateAverage(homepageNavigationMetricsOverTries, 'pageSize_MB'),
        domElementCount: calculateAverage(homepageNavigationMetricsOverTries, 'domElementCount'),
      };
      console.log(`  [Site Loop] Average homepage navigation metrics for ${url}:`, avgHomepageNavigationMetrics);
    }

    console.log(`\n[Main] All URLs processed. Closing browser...`);
    await browser.close();
    console.log(`[Main] Browser closed.`);

    console.log(`\n[Main] Performance data collection complete. Results saved to ${outputPath}.`);

  } catch (mainError) {
    console.error(`[Main] A critical error occurred:`, mainError);
    process.exit(1);
  }
})();