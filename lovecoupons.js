import { Actor } from 'apify';

async function collectBrandUrls(page) {
    const brandUrls = [];
    const alphabet = ['0-9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 
                     'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];
    const baseURL = 'https://www.lovecoupons.ro/brands/';
    
    for (const letter of alphabet) {
        const url = `${baseURL}${letter === '0-9' ? 'number' : letter}`;
        console.log(`Navigating to: ${url}`);
        
        try {
            // Navigate with longer timeout and wait until HTML is loaded
            await page.goto(url, { 
                waitUntil: 'domcontentloaded',
                timeout: 60000 
            });
            
            // Wait for initial load
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Check for Cloudflare
            const content = await page.content();
            if (content.includes('challenge-running') || content.includes('cloudflare')) {
                console.log('Cloudflare detected, waiting longer...');
                await new Promise(resolve => setTimeout(resolve, 20000));
            }
            
            // Try different selectors
            const selectors = [
                'ul.grid.grid-cols-1',
                '.brand-list',
                'a[href*="/brands/"]'
            ];
            
            let urls = [];
            for (const selector of selectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    urls = await page.evaluate((sel) => {
                        const links = document.querySelectorAll(sel + ' a');
                        return Array.from(links, link => link.href);
                    }, selector);
                    
                    if (urls.length > 0) {
                        console.log(`Found ${urls.length} URLs using selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    console.log(`Selector ${selector} not found`);
                }
            }

            if (urls.length > 0) {
                brandUrls.push(...urls);
                console.log(`Collected ${urls.length} urls for category ${letter}`);
            } else {
                console.log('No URLs found, logging page content...');
                console.log('Page content preview:', content.substring(0, 1000));
            }
            
            // Delay between requests
            await new Promise(resolve => setTimeout(resolve, 5000));
            
        } catch (error) {
            console.log(`Error collecting URLs for category ${letter}:`, error);
        }
    }

    return brandUrls;
}

async function scrapeBrandDetails(page, brandUrls) {
    const results = [];

    for (const url of brandUrls) {
        try {
            await delay(1000);
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const pageData = await page.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                
                let offersData = [];
                let orgData = {
                    name: null,
                    logo: null,
                };

                scripts.forEach(script => {
                    try {
                        const jsonData = JSON.parse(script.innerText);
                        if (jsonData['@type'] === 'ItemList' && jsonData.itemListElement) {
                            offersData = jsonData.itemListElement.map(item => ({
                                name: item.item?.name || null,
                                url: item.item?.url || null,
                                description: item.item?.description || null,
                                validFrom: item.item?.validFrom || null,
                            }));
                        } else if (jsonData['@type'] === 'Organization') {
                            orgData.name = jsonData.name || null;
                            orgData.logo = jsonData.logo || null;
                        }
                    } catch (error) {
                        console.log('Error parsing JSON-LD:', error);
                    }
                });

                return { offersData, orgData };
            });

            await Actor.pushData({
                brand: pageData.orgData.name,
                logo: pageData.orgData.logo,
                offers: pageData.offersData.map(offer => ({
                    name: offer.name,
                    url: offer.url,
                    description: offer.description,
                    validFrom: offer.validFrom,
                })),
            });
            console.log(`Pushed data to dataset for: ${url}`);
        } catch (error) {
            console.log(`Error scraping ${url}:`, error);
        }
    }

    console.log('Scraping completed. Data collected:', results);
    return results;
}

async function main() {
    await Actor.init();
    
    // Changed from browser.launch to Actor.launchPuppeteer
    const browser = await Actor.launchPuppeteer({
        stealth: true,
        useChrome: true,
        launchOptions: {
            args: [
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--no-sandbox',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        
        // Add browser fingerprinting
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'language', { get: () => 'ro-RO' });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });
        
        // Log all console messages
        page.on('console', msg => console.log('Browser console:', msg.text()));
        
        const brandUrls = await collectBrandUrls(page);
        console.log(`Collected a total of ${brandUrls.length} brand links.`);
        
        if (brandUrls.length > 0) {
            await scrapeBrandDetails(page, brandUrls);
            console.log('Scraping completed successfully');
        } else {
            throw new Error('No brand URLs were collected');
        }
    } catch (error) {
        console.error('Actor failed:', error);
        throw error;
    } finally {
        await browser.close();
        await Actor.exit();
    }
}

main();
