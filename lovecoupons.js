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
                                        
                                        // Launch Puppeteer with additional options
                                        const browser = await puppeteer.launch({
                                            headless: true,
                                            args: [
                                                '--no-sandbox',
                                                '--disable-setuid-sandbox',
                                                '--disable-web-security',
                                                '--disable-features=IsolateOrigins,site-per-process'
                                            ]
                                        });
                                        
                                        const page = await browser.newPage();
                                        
                                        // Store the redirect URL
                                        let redirectUrl = null;
                                        
                                        // Intercept network requests
                                        await page.setRequestInterception(true);
                                        page.on('request', request => {
                                            const url = request.url();
                                            console.log('Request URL:', url);
                                            
                                            // Capture the redirect URL
                                            if (url.includes('/go/3/')) {
                                                redirectUrl = url;
                                                console.log('Found redirect URL:', redirectUrl);
                                            }
                                            request.continue();
                                        });
                                        
                                        // Set viewport and user agent
                                        await page.setViewport({ width: 1280, height: 800 });
                                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                                        
                                        // Navigate to the offer URL
                                        console.log('Navigating to:', offerData.url);
                                        await page.goto(offerData.url, { waitUntil: 'networkidle0' });
                                        
                                        // Take a screenshot
                                        await page.screenshot({ path: 'initial-page.png' });
                                        
                                        // Try different button selectors
                                        const buttonSelectors = [
                                            'button.OutlinkCta',
                                            '.OutlinkCta',
                                            'button:contains("Obțineți codul")',
                                            '[data-testid="reveal-coupon-button"]',
                                            '.Offer button'
                                        ];
                                        
                                        let buttonFound = false;
                                        for (const selector of buttonSelectors) {
                                            try {
                                                const button = await page.$(selector);
                                                if (button) {
                                                    console.log(`Found button with selector: ${selector}`);
                                                    await button.click();
                                                    buttonFound = true;
                                                    break;
                                                }
                                            } catch (e) {
                                                console.log(`Selector ${selector} not found`);
                                            }
                                        }
                                        
                                        if (!buttonFound) {
                                            console.log('No button found with standard selectors, trying JavaScript click');
                                            await page.evaluate(() => {
                                                const buttons = Array.from(document.querySelectorAll('button'));
                                                const button = buttons.find(b => 
                                                    b.textContent.includes('Obțineți codul') || 
                                                    b.className.includes('OutlinkCta')
                                                );
                                                if (button) button.click();
                                            });
                                        }
                                        
                                        // Wait for redirect URL
                                        await page.waitForTimeout(2000);
                                        
                                        if (redirectUrl) {
                                            console.log('Following redirect URL...');
                                            const newPage = await browser.newPage();
                                            await newPage.goto(redirectUrl, { waitUntil: 'networkidle0' });
                                            
                                            // Take screenshot of final page
                                            await newPage.screenshot({ path: 'final-page.png' });
                                            
                                            // Try multiple ways to get the coupon code
                                            const couponCode = await newPage.evaluate(() => {
                                                // Try input field
                                                const input = document.querySelector('input[type="text"]');
                                                if (input && input.value) return input.value;
                                                
                                                // Try specific coupon element
                                                const couponElement = document.querySelector('[data-testid="coupon-code"]');
                                                if (couponElement) return couponElement.textContent;
                                                
                                                // Try any element with 'coupon' in the class
                                                const couponDiv = document.querySelector('[class*="coupon"]');
                                                if (couponDiv) return couponDiv.textContent;
                                                
                                                return null;
                                            });
                                            
                                            if (couponCode) {
                                                offerData.couponCode = couponCode;
                                                console.log(`Successfully found coupon code: ${couponCode}`);
                                            } else {
                                                console.log('No coupon code found on final page');
                                                const content = await newPage.content();
                                                console.log('Final page content:', content.substring(0, 1000));
                                            }
                                            
                                            await newPage.close();
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
