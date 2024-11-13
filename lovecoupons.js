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
                                            args: ['--no-sandbox', '--disable-setuid-sandbox']
                                        });
                                        
                                        const page = await browser.newPage();
                                        
                                        // Enable request interception
                                        await page.setRequestInterception(true);
                                        let finalUrl = null;
                                        
                                        page.on('request', request => {
                                            const url = request.url();
                                            console.log('Request:', url);
                                            
                                            // Look for the final redirect URL
                                            if (url.includes('/go/3/')) {
                                                finalUrl = url;
                                                console.log('Found final URL:', finalUrl);
                                            }
                                            request.continue();
                                        });
                                        
                                        // Navigate to base URL first
                                        const baseUrl = offerData.url.split('#')[0];
                                        console.log('Navigating to base URL:', baseUrl);
                                        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
                                        
                                        // Find and click the button using JavaScript
                                        const clicked = await page.evaluate(() => {
                                            const button = document.querySelector('.OutlinkCta');
                                            if (button) {
                                                console.log('Found button, clicking...');
                                                button.click();
                                                return true;
                                            }
                                            return false;
                                        });
                                        
                                        if (clicked) {
                                            console.log('Button clicked successfully');
                                            // Wait for the redirect
                                            await new Promise(resolve => setTimeout(resolve, 3000));
                                            
                                            if (finalUrl) {
                                                console.log('Following final URL:', finalUrl);
                                                const newPage = await browser.newPage();
                                                await newPage.goto(finalUrl, { waitUntil: 'networkidle0' });
                                                
                                                // Take a screenshot for debugging
                                                await newPage.screenshot({ path: 'final-page.png' });
                                                
                                                // Try multiple ways to find the coupon code
                                                const couponCode = await newPage.evaluate(() => {
                                                    // Log the page content for debugging
                                                    console.log('Page content:', document.body.innerHTML);
                                                    
                                                    // Try various selectors
                                                    const selectors = [
                                                        'input[type="text"]',
                                                        '[data-testid="coupon-code"]',
                                                        '[class*="coupon"]',
                                                        '.code',
                                                        '#code'
                                                    ];
                                                    
                                                    for (const selector of selectors) {
                                                        const element = document.querySelector(selector);
                                                        if (element) {
                                                            return element.value || element.textContent;
                                                        }
                                                    }
                                                    
                                                    return null;
                                                });
                                                
                                                if (couponCode) {
                                                    console.log('Found coupon code:', couponCode);
                                                    offerData.couponCode = couponCode;
                                                } else {
                                                    console.log('No coupon code found on final page');
                                                }
                                                
                                                await newPage.close();
                                            } else {
                                                console.log('No final URL found');
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
