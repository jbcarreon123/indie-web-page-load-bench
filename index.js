const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Increased default timeout for page navigation and load states
const DEFAULT_PAGE_TIMEOUT = 90000; // 90 seconds
// Increased default timeout for element visibility waits
const DEFAULT_ELEMENT_WAIT_TIMEOUT = 15000; // 15 seconds

/**
 * Measures performance metrics for the initial page load.
 * @param {import('playwright').Page} page - The Playwright page object.
 * @param {string} url - The URL to navigate to.
 * @returns {Promise<object>} An object containing initial page load metrics.
 */
async function getInitialPageLoadMetrics(page, url) {
  let totalTransferredBytes = 0;
  page.removeAllListeners('response'); // Ensure clean state for network monitoring

  page.on('response', async response => {
    try {
      const headers = response.headers();
      const contentLength = headers['content-length'];
      if (contentLength) {
        totalTransferredBytes += parseInt(contentLength, 10);
      } else {
        const buffer = await response.body();
        totalTransferredBytes += buffer.length;
      }
    } catch (error) {
      // Ignore errors (e.g., cross-origin, failed requests)
    }
  });

  const startTime = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_PAGE_TIMEOUT }); // Extended timeout
  const domContentLoadedTime = performance.now() - startTime;

  await page.waitForLoadState('load', { timeout: DEFAULT_PAGE_TIMEOUT }); // Explicitly extended timeout
  const loadTime = performance.now() - startTime;

  const performanceTiming = await page.evaluate(() => {
    return performance.getEntriesByType('navigation')[0];
  });

  const domElementCount = await page.evaluate(() => {
    return document.querySelectorAll('*').length;
  });

  return {
    domContentLoadedTime: parseFloat(domContentLoadedTime.toFixed(2)),
    loadTime: parseFloat(loadTime.toFixed(2)),
    pageLoadApiTime: performanceTiming ? parseFloat((performanceTiming.loadEventEnd - performanceTiming.startTime).toFixed(2)) : 'N/A',
    domContentLoadedApiTime: performanceTiming ? parseFloat((performanceTiming.domContentLoadedEventEnd - performanceTiming.startTime).toFixed(2)) : 'N/A',
    totalTransferredBytes: totalTransferredBytes,
    totalTransferredMB: parseFloat((totalTransferredBytes / (1024 * 1024)).toFixed(2)),
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
 * Measures the time taken to navigate to a pre-identified homepage link.
 * @param {import('playwright').Page} page - The Playwright page object.
 * @param {string} homepageTargetUrl - The specific URL of the homepage link to navigate to.
 * @param {string} initialPageUrl - The URL of the page we are starting from (for context/errors).
 * @returns {Promise<object>} An object containing homepage click metrics.
 */
async function measureHomepageNavigation(page, homepageTargetUrl, initialPageUrl) {
  let homepageClickTime = 'N/A';

  if (homepageTargetUrl === 'N/A') {
      console.log(`    [Homepage Navigation] Cannot measure click: no homepage link was identified.`);
      return { homepageLinkFound: false, homepageLinkClickTime: 'N/A' };
  }

  try {
    const startTime = performance.now();
    console.log(`    [Homepage Navigation] Navigating directly to homepage: ${homepageTargetUrl}`);

    await page.goto(homepageTargetUrl, { waitUntil: 'networkidle', timeout: DEFAULT_PAGE_TIMEOUT });
    homepageClickTime = parseFloat((performance.now() - startTime).toFixed(2));
    console.log(`    [Homepage Navigation] Homepage navigation completed. Time: ${homepageClickTime} ms`);

    return {
      homepageLinkFound: true,
      homepageLinkClickTime: homepageClickTime
    };

  } catch (error) {
    console.error(`    [Homepage Navigation ERROR] Failed to navigate to homepage ${homepageTargetUrl} from ${initialPageUrl}:`, error.message);
    return { homepageLinkFound: false, homepageLinkClickTime: 'N/A' };
  }
}

/**
 * Calculates the average of a metric from an array of results.
 * Handles numeric values and a special case for boolean 'homepageLinkFound'.
 * @param {Array<object>} metricsArray - Array of metric objects from individual tries.
 * @param {string} metricName - The name of the metric to average.
 * @returns {number|string|boolean} The average, 'N/A', or a boolean.
 */
function calculateAverage(metricsArray, metricName) {
  if (metricName === 'homepageLinkFound') {
      const trueCount = metricsArray.filter(m => m[metricName] === true).length;
      return trueCount > 0;
  }

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

  const outputFilename = `performance_metrics_combined_averages_${new Date().toISOString().slice(0, 10)}.csv`;
  const outputPath = path.join(__dirname, outputFilename); // Full path for output file

  console.log(`[Main] Starting Playwright performance analysis...`);
  console.log(`[Main] Initial page load: ${NUM_TRIES_INITIAL_LOAD} tries per URL.`);
  console.log(`[Main] Homepage navigation: ${NUM_TRIES_HOMEPAGE_NAVIGATION} tries per URL.`);
  console.log(`[Main] Output will be saved to: ${outputPath}`);

  try {
    const browser = await chromium.launch({ headless: true });
    console.log(`[Main] Browser launched successfully.`);

    const header = [
      'URL',
      'Avg_DOMContentLoadedTime_ms',
      'Avg_LoadTime_ms',
      'Avg_PageLoadApiTime_ms',
      'Avg_DOMContentLoadedApiTime_ms',
      'Avg_TotalTransferredBytes',
      'Avg_TotalTransferredMB',
      'Avg_DOMElementCount',
      'HomepageLinkFound',
      'HomepageLinkHref_Identified',
      'Avg_HomepageNavigationTime_ms'
    ].join(',');

    // Write header immediately to the file (overwriting if it exists)
    fs.writeFileSync(outputPath, header + '\n');
    console.log(`[Main] CSV header written to ${outputPath}.`);

    for (const url of urlsToTest) {
      console.log(`\n--- [Site Loop] Processing URL: ${url} ---`);

      // --- Initial Page Load Measurements ---
      console.log(`  [Site Loop] Measuring initial page load for ${url} (${NUM_TRIES_INITIAL_LOAD} tries)...`);
      const initialLoadMetricsOverTries = [];
      for (let i = 0; i < NUM_TRIES_INITIAL_LOAD; i++) {
        let page;
        try {
          console.log(`    [Initial Load Try] Starting Try ${i + 1}/${NUM_TRIES_INITIAL_LOAD}...`);
          page = await browser.newPage();
          const metrics = await getInitialPageLoadMetrics(page, url);
          initialLoadMetricsOverTries.push(metrics);
        } catch (error) {
          console.error(`      [ERROR] Initial Load Try ${i + 1} for ${url} failed:`, error.message);
          initialLoadMetricsOverTries.push({ error: error.message });
        } finally {
          if (page) {
            await page.close();
          }
        }
      }
      const avgInitialLoadMetrics = {
        domContentLoadedTime: calculateAverage(initialLoadMetricsOverTries, 'domContentLoadedTime'),
        loadTime: calculateAverage(initialLoadMetricsOverTries, 'loadTime'),
        pageLoadApiTime: calculateAverage(initialLoadMetricsOverTries, 'pageLoadApiTime'),
        domContentLoadedApiTime: calculateAverage(initialLoadMetricsOverTries, 'domContentLoadedApiTime'),
        totalTransferredBytes: calculateAverage(initialLoadMetricsOverTries, 'totalTransferredBytes'),
        totalTransferredMB: calculateAverage(initialLoadMetricsOverTries, 'totalTransferredMB'),
        domElementCount: calculateAverage(initialLoadMetricsOverTries, 'domElementCount'),
      };
      console.log(`  [Site Loop] Average initial load metrics for ${url}:`, avgInitialLoadMetrics);

      // --- Homepage Link Identification (Only Once) ---
      console.log(`  [Site Loop] Identifying homepage link for ${url} (only once)...`);
      let identifiedHomepageHref = 'N/A';
      let homepageLinkFoundOverall = false;

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

      // --- Homepage Navigation Measurements (Using the identified link) ---
      console.log(`  [Site Loop] Measuring homepage navigation for ${url} (${NUM_TRIES_HOMEPAGE_NAVIGATION} tries)...`);
      const homepageNavigationMetricsOverTries = [];
      if (homepageLinkFoundOverall) {
          for (let i = 0; i < NUM_TRIES_HOMEPAGE_NAVIGATION; i++) {
              let pageForNavigation;
              try {
                  console.log(`    [Homepage Navigation Try] Starting Try ${i + 1}/${NUM_TRIES_HOMEPAGE_NAVIGATION}...`);
                  pageForNavigation = await browser.newPage();
                  const metrics = await measureHomepageNavigation(pageForNavigation, identifiedHomepageHref, url);
                  homepageNavigationMetricsOverTries.push(metrics);
              } catch (error) {
                  console.error(`      [ERROR] Homepage Navigation Try ${i + 1} for ${url} failed:`, error.message);
                  homepageNavigationMetricsOverTries.push({ error: error.message, homepageLinkFound: false, homepageLinkClickTime: 'N/A' });
              } finally {
                  if (pageForNavigation) {
                      await pageForNavigation.close();
                  }
              }
          }
      } else {
          console.log(`  [Site Loop] Skipping homepage navigation measurements as no link was identified.`);
          for (let i = 0; i < NUM_TRIES_HOMEPAGE_NAVIGATION; i++) {
              homepageNavigationMetricsOverTries.push({ homepageLinkFound: false, homepageLinkClickTime: 'N/A' });
          }
      }

      const avgHomepageNavigationMetrics = {
        homepageLinkFound: homepageLinkFoundOverall,
        homepageLinkClickTime: calculateAverage(homepageNavigationMetricsOverTries, 'homepageLinkClickTime')
      };
      console.log(`  [Site Loop] Average homepage navigation metrics for ${url}:`, avgHomepageNavigationMetrics);


      // --- Consolidate and Format for CSV ---
      const consolidatedMetrics = {
        url: url,
        ...avgInitialLoadMetrics,
        homepageLinkFound: avgHomepageNavigationMetrics.homepageLinkFound,
        homepageLinkHref: identifiedHomepageHref,
        homepageLinkNavigationTime: avgHomepageNavigationMetrics.homepageLinkClickTime
      };

      const dataRow = [
        `"${consolidatedMetrics.url}"`,
        consolidatedMetrics.domContentLoadedTime,
        consolidatedMetrics.loadTime,
        consolidatedMetrics.pageLoadApiTime,
        consolidatedMetrics.domContentLoadedApiTime,
        consolidatedMetrics.totalTransferredBytes,
        consolidatedMetrics.totalTransferredMB,
        consolidatedMetrics.domElementCount,
        consolidatedMetrics.homepageLinkFound,
        `"${consolidatedMetrics.homepageLinkHref}"`,
        consolidatedMetrics.homepageLinkNavigationTime
      ].join(',');

      // IMMEDIATELY APPEND THE ROW TO THE CSV FILE
      fs.appendFileSync(outputPath, dataRow + '\n');
      console.log(`  [Site Loop] Consolidated CSV row for ${url} appended to ${outputPath}.`);
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