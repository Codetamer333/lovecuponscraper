import { Actor } from 'apify';
import { CheerioCrawler, RequestList } from 'crawlee';
import puppeteer from 'puppeteer';

async function main() {
    await Actor.init();

    const input = await Actor.getInput();
    const startUrls = input.urls.map(url => ({
        url,
        userData: { label: 'BRAND_DETAIL' }
    }));

    const crawler = new CheerioCrawler({
        requestList: await RequestList.open(null, startUrls),
        maxConcurrency: 1,
        maxRequestsPerMinute: 10,
        requestHandlerTimeoutSecs: 60,

        requestHandler: async ({ $, request }) => {
            const { label } = request.userData;

            if (label === 'BRAND_DETAIL') {
                console.log(`Scraping brand details from ${request.url}`);
                
                const jsonLdScripts = $('script[type="application/ld+json"]')
                    .map((_, el) => {
                        try {
                            return JSON.parse($(el).html());
                        } catch (e) {
                            return null;
                        }
                    })
                    .get()
                    .filter(Boolean);

                let brandData = {
                    url: request.url,
                    name: null,
                    logo: null,
                    offers: []
                };

                for (const script of jsonLdScripts) {
                    if (script['@type'] === 'Organization') {
                        brandData.name = script.name;
                        brandData.logo = script.logo;
                    }
                    if (script['@type'] === 'ItemList') {
                        brandData.offers = await Promise.all(script.itemListElement?.map(async (item, index) => {
                            await new Promise(resolve => setTimeout(resolve, index * 2000));

                            const offerData = {
                                name: item.item?.name,
                                description: item.item?.description,
                                validFrom: item.item?.validFrom,
                                url: item.item?.url,
                                couponCode: null
                            };

                            console.log('Looking for offer with name:', offerData.name);

                            // Find the specific article that contains this offer
                            let matchingArticle = null;
                            $('article.Offer').each((_, article) => {
                                const articleTitle = $(article).find('h3.text-lg').text().trim();
                                const normalizedArticleTitle = articleTitle.replace('Verificat ', '');
                                if (normalizedArticleTitle === offerData.name) {
                                    matchingArticle = article;
                                    return false;
                                }
                            });

                            if (matchingArticle) {
                                console.log('Found matching article for:', offerData.name);
                                
                                const $article = $(matchingArticle);
                                const button = $article.find('.OutlinkCta span:contains("Obțineți codul")').first();
                                const hasButton = button.length > 0;
                                
                                if (hasButton && offerData.url) {
                                    try {
                                        console.log(`Found button for offer: ${offerData.name}`);
                                        
                                        const browser = await puppeteer.launch({
                                            headless: true,
                                            args: [
                                                '--no-sandbox',
                                                '--disable-setuid-sandbox',
                                                '--disable-web-security',
                                                '--disable-features=IsolateOrigins',
                                                '--disable-site-isolation-trials'
                                            ]
                                        });
                                        
                                        const page = await browser.newPage();
                                        
                                        // Set a more realistic user agent
                                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                                        
                                        // Enable request interception
                                        await page.setRequestInterception(true);
                                        let finalUrl = null;
                                        
                                        page.on('request', request => {
                                            const url = request.url();
                                            const resourceType = request.resourceType();
                                            
                                            // Block unnecessary resources
                                            if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
                                                request.abort();
                                                return;
                                            }
                                            
                                            if (url.includes('/go/3/')) {
                                                finalUrl = url;
                                                console.log('Found redirect URL:', finalUrl);
                                            }
                                            request.continue();
                                        });
                                        
                                        // Navigate and wait for Cloudflare to clear
                                        console.log('Navigating to URL:', offerData.url);
                                        await page.goto(offerData.url, { 
                                            waitUntil: 'networkidle0',
                                            timeout: 30000 
                                        });
                                        
                                        // Wait for Cloudflare challenge to complete
                                        await page.waitForFunction(() => {
                                            return !document.querySelector('#challenge-running');
                                        }, { timeout: 30000 });
                                        
                                        // Find the button using multiple strategies
                                        const buttonSelector = await page.evaluate(() => {
                                            const selectors = [
                                                '.OutlinkCta',
                                                'button:contains("Obțineți codul")',
                                                '[class*="coupon"]:contains("Obțineți codul")',
                                                'a:contains("Obțineți codul")'
                                            ];
                                            
                                            for (const selector of selectors) {
                                                const element = document.querySelector(selector);
                                                if (element) return selector;
                                            }
                                            return null;
                                        });
                                        
                                        if (buttonSelector) {
                                            console.log('Found button with selector:', buttonSelector);
                                            await page.click(buttonSelector);
                                            
                                            // Wait for navigation
                                            await new Promise(resolve => setTimeout(resolve, 5000));
                                            
                                            if (finalUrl) {
                                                console.log('Following redirect URL:', finalUrl);
                                                const newPage = await browser.newPage();
                                                await newPage.goto(finalUrl, { waitUntil: 'networkidle0' });
                                                
                                                // Extract coupon code
                                                const couponCode = await newPage.evaluate(() => {
                                                    const possibleElements = document.querySelectorAll('input[type="text"], [class*="coupon"], [class*="code"]');
                                                    for (const element of possibleElements) {
                                                        const text = element.value || element.textContent;
                                                        if (text && text.length > 3) return text.trim();
                                                    }
                                                    return null;
                                                });
                                                
                                                if (couponCode) {
                                                    console.log('Found coupon code:', couponCode);
                                                    offerData.couponCode = couponCode;
                                                }
                                                
                                                await newPage.close();
                                            }
                                        } else {
                                            console.log('Button not found on page');
                                        }
                                        
                                        await browser.close();
                                        
                                    } catch (error) {
                                        console.error('Error fetching coupon:', error.message);
                                    }
                                } else {
                                    console.log('No button found or no URL available');
                                }
                            } else {
                                console.log('No matching article found for:', offerData.name);
                            }

                            return offerData;
                        })) || [];
                    }
                }

                if (brandData.name || brandData.offers.length > 0) {
                    await Actor.pushData(brandData);
                    console.log(`Saved data for: ${brandData.name || request.url}`);
                }
            }
        },
    });

    await crawler.run();
    await Actor.exit();
}

await main();
