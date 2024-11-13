import { Actor } from 'apify';
import { CheerioCrawler, RequestList } from 'crawlee';
import cheerio from 'cheerio';

async function main() {
    await Actor.init();

    // Get input URLs from Apify input - now expecting direct brand URLs
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

        requestHandler: async ({ $, request, enqueueLinks }) => {
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
                                name: item.name,
                                description: item.description,
                                url: item.url,
                                price: item.price,
                                priceCurrency: item.priceCurrency,
                                availability: item.availability,
                                couponCode: null
                            };

                            try {
                                const offerElement = $('.Offer').filter((_, el) => {
                                    const titleEl = $(el).find('h3');
                                    return titleEl.text().trim() === item.name;
                                }).first();

                                if (offerElement.length) {
                                    const codeButton = offerElement.find('span:contains("Obțineți codul")');
                                    
                                    if (codeButton.length) {
                                        const offerUrl = offerElement.attr('data-out');
                                        
                                        if (offerUrl) {
                                            const response = await context.crawler.requestQueue.addRequest({
                                                url: offerUrl,
                                                userData: { label: 'COUPON_PAGE' }
                                            });

                                            if (response.wasAlreadyPresent) {
                                                console.log(`Coupon URL ${offerUrl} already queued`);
                                            } else {
                                                console.log(`Queued coupon URL: ${offerUrl}`);
                                            }
                                        }
                                    }
                                }
                            } catch (error) {
                                console.error(`Error processing offer ${item.name}:`, error);
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

            if (label === 'COUPON_PAGE') {
                const codeElement = $('.border-2.border-cta-500.bg-white.text-black.text-right');
                if (codeElement.length) {
                    const code = codeElement.text().trim();
                    console.log(`Found coupon code: ${code}`);
                }
            }
        },
        maxRequestRetries: 3,
        navigationTimeoutSecs: 30,
        preNavigationHooks: [
            async ({ request }) => {
                if (request.userData.delay) {
                    await new Promise(resolve => setTimeout(resolve, request.userData.delay));
                }

                request.headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                };
            },
        ],
    });

    await crawler.run();
    await Actor.exit();
}

main();
