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
                                        
                                        // Launch Puppeteer
                                        const browser = await puppeteer.launch({
                                            headless: true,
                                            args: ['--no-sandbox', '--disable-setuid-sandbox']
                                        });
                                        
                                        const page = await browser.newPage();
                                        
                                        // Enable request interception for debugging
                                        await page.setRequestInterception(true);
                                        page.on('request', request => {
                                            console.log('Request URL:', request.url());
                                            request.continue();
                                        });
                                        
                                        // Set viewport and user agent
                                        await page.setViewport({ width: 1280, height: 800 });
                                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                                        
                                        // Navigate to the offer URL
                                        console.log('Navigating to:', offerData.url);
                                        await page.goto(offerData.url, { 
                                            waitUntil: 'networkidle0',
                                            timeout: 30000 
                                        });
                                        
                                        // Take a screenshot before clicking
                                        await page.screenshot({ path: 'before-click.png' });
                                        
                                        // Wait for the button and click it
                                        console.log('Waiting for button...');
                                        await page.waitForSelector('button.OutlinkCta', { 
                                            visible: true,
                                            timeout: 10000 
                                        });
                                        
                                        // Get all buttons and their text content
                                        const buttons = await page.$$eval('button', buttons => 
                                            buttons.map(b => ({
                                                text: b.innerText,
                                                class: b.className
                                            }))
                                        );
                                        console.log('Available buttons:', buttons);
                                        
                                        // Click the button
                                        await page.click('button.OutlinkCta');
                                        console.log('Clicked the button');
                                        
                                        // Wait for the modal or reveal element
                                        await page.waitForSelector('.RevealCoupon', { 
                                            visible: true,
                                            timeout: 10000 
                                        });
                                        
                                        // Take a screenshot after clicking
                                        await page.screenshot({ path: 'after-click.png' });
                                        
                                        // Get the coupon code
                                        const couponCode = await page.evaluate(() => {
                                            const input = document.querySelector('.RevealCoupon input[type="text"]');
                                            if (input) {
                                                console.log('Found input with value:', input.value);
                                                return input.value;
                                            }
                                            // Try getting it from the input directly
                                            const directInput = document.querySelector('input[id^="coupon-"]');
                                            if (directInput) {
                                                console.log('Found direct input with value:', directInput.value);
                                                return directInput.value;
                                            }
                                            return null;
                                        });
                                        
                                        if (couponCode) {
                                            offerData.couponCode = couponCode;
                                            console.log(`Successfully found coupon code: ${couponCode}`);
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
