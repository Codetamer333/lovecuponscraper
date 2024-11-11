import { Actor } from 'apify';
import puppeteer from "puppeteer";

async function collectBrandUrls(page) {
    const brandUrls = [];
    const alphabet = ['0-9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 
                     'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];
    const baseURL = 'https://www.lovecoupons.ro/brands/';
    
    for (const letter of alphabet) {
        const url = `${baseURL}${letter === '0-9' ? 'number' : letter}`;
        console.log(`Navigating to: ${url}`);
        
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.waitForTimeout(2000);
        
        try {
            await page.waitForSelector('ul.grid.grid-cols-1', { timeout: 5000 });
            
            const urls = await page.evaluate(() => {
                const links = document.querySelectorAll('ul.grid.grid-cols-1 a');
                return Array.from(links, link => link.href);
            });

            brandUrls.push(...urls);
            console.log(`Collected ${urls.length} urls for category ${letter}`);
            
            if (urls.length === 0) {
                const content = await page.content();
                console.log('Page content:', content);
            }
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
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--window-size=1920,1080',
        ],
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', request => {
            console.log('Request:', request.url());
            request.continue();
        });
        
        const brandUrls = await collectBrandUrls(page);
        console.log(`Collected a total of ${brandUrls.length} brand links.`);
        
        await scrapeBrandDetails(page, brandUrls);
        console.log('Scraping completed successfully');
    } catch (error) {
        console.error('Actor failed:', error);
        throw error;
    } finally {
        await browser.close();
        await Actor.exit();
    }
}

main();
