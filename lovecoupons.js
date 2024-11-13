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
                                        
                                        // Set viewport and user agent
                                        await page.setViewport({ width: 1280, height: 800 });
                                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                                        
                                        // Navigate to the offer URL
                                        await page.goto(offerData.url, { waitUntil: 'networkidle0' });
                                        
                                        // Click the "Get Code" button
                                        await page.waitForSelector('.OutlinkCta span:contains("Obțineți codul")', { timeout: 5000 });
                                        await page.click('.OutlinkCta span:contains("Obțineți codul")');
                                        
                                        // Wait for the coupon code to appear
                                        await page.waitForSelector('.RevealCoupon input[type="text"]', { timeout: 5000 });
                                        
                                        // Get the coupon code
                                        const couponCode = await page.evaluate(() => {
                                            const input = document.querySelector('.RevealCoupon input[type="text"]');
                                            return input ? input.value : null;
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
