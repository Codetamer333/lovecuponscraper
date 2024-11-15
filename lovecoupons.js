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
                            console.error('Error parsing JSON-LD:', e.message);
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

                // Extract brand data from JSON-LD
                for (const script of jsonLdScripts) {
                    if (script['@type'] === 'Organization') {
                        brandData.name = script.name;
                        brandData.logo = script.logo;
                    }
                    if (script['@type'] === 'ItemList') {
                        brandData.offers = await Promise.all(script.itemListElement?.map(async (item, index) => {
                            // Add delay between processing each offer
                            await new Promise(resolve => setTimeout(resolve, index * 2000));

                            const offerData = {
                                name: item.item?.name,
                                description: item.item?.description,
                                validFrom: item.item?.validFrom,
                                url: item.item?.url,
                                couponCode: null
                            };

                            // Find matching article
                            const matchingArticle = $('article.Offer').filter((_, article) => {
                                const articleTitle = $(article).find('h3.text-lg').text().trim();
                                const normalizedArticleTitle = articleTitle.replace('Verificat ', '');
                                return normalizedArticleTitle === offerData.name;
                            }).first();

                            if (matchingArticle.length) {
                                const button = matchingArticle.find('.OutlinkCta span:contains("Obțineți codul")').first();
                                const hasButton = button.length > 0;
                                
                                if (hasButton && offerData.url) {
                                    try {
                                        const browser = await puppeteer.launch({
                                            headless: true,
                                            args: ['--no-sandbox', '--disable-setuid-sandbox']
                                        });
                                        
                                        const page = await browser.newPage();
                                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                                        
                                        // Navigate to the page
                                        await page.goto(offerData.url, { waitUntil: 'networkidle0' });
                                        
                                        // Wait for and click the button
                                        await page.waitForSelector('.OutlinkCta');
                                        await page.click('.OutlinkCta');
                                        
                                        // Wait for modal to appear and extract coupon
                                        await page.waitForSelector('#OfferModal');
                                        
                                        const couponCode = await page.evaluate(() => {
                                            const input = document.querySelector('#OfferModal input[type="text"]');
                                            if (input) return input.value;
                                            
                                            const strongText = document.querySelector('#OfferModal strong');
                                            if (strongText) return strongText.textContent;
                                            
                                            return null;
                                        });
                                        
                                        if (couponCode) {
                                            console.log('Found coupon code:', couponCode);
                                            offerData.couponCode = couponCode;
                                        }
                                        
                                        await browser.close();
                                        
                                    } catch (error) {
                                        console.error('Error fetching coupon:', error.message);
                                    }
                                } else {
                                    console.log('No coupon code found only offer:', offerData.name);
                                }
                            } else {
                                console.log('No matching article found for:', offerData.name);
                            }

                            return offerData;
                        }) || []);
                    }
                }

                // If no offers were found in JSON-LD, try scraping directly from the page
                if (brandData.offers.length === 0) {
                    console.log('No offers found in JSON-LD, trying direct page scraping');
                    
                    $('article.Offer').each(async (_, article) => {
                        const $article = $(article);
                        const name = $article.find('h3.text-lg').text().trim();
                        const description = $article.find('.description').text().trim();
                        const button = $article.find('.OutlinkCta span:contains("Obțineți codul")').first();
                        
                        const offerData = {
                            name,
                            description,
                            validFrom: null,
                            url: request.url,
                            couponCode: null
                        };

                        if (button.length > 0) {
                        
                        }
                        
                        brandData.offers.push(offerData);
                    });
                }

                console.log(`Saved data for: ${brandData.name}`);
                await Actor.pushData(brandData);
            }
        },
    });

    await crawler.run();
    await Actor.exit();
}

await main();
