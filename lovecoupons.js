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
                                name: item.item?.name,
                                description: item.item?.description,
                                validFrom: item.item?.validFrom,
                                url: item.item?.url,
                                couponCode: null
                            };

                            console.log('Looking for offer with name:', offerData.name);

                            // Find the specific article that contains this offer
                            const offerArticle = $('article.Offer').filter((_, article) => {
                                const articleTitle = $(article).find('h3.text-lg').text().trim();
                              // console.log('Article title found:', articleTitle);
                                return articleTitle === offerData.name;
                            });
                            console.log(offerArticle);
                            if (offerArticle.length > 0) {
                                console.log('Found matching article');
                                // Now look for the button only within this specific article
                                const button = offerArticle.find('.OutlinkCta span:contains("Obțineți codul")');
                                const hasButton = button.length > 0;
                                console.log('Has button:', hasButton);

                                if (hasButton && offerData.url) {
                                    try {
                                        console.log(`Found coupon button for offer: ${offerData.name}. Fetching code from ${offerData.url}`);
                                        
                                        await new Promise(resolve => setTimeout(resolve, 2000));

                                        const codePageResponse = await fetch(offerData.url, {
                                            headers: {
                                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                                'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7'
                                            }
                                        });
                                        const codePageHtml = await codePageResponse.text();
                                        const $codePage = cheerio.load(codePageHtml);
                                        
                                        const couponInput = $codePage('input[id^="coupon-"]');
                                        if (couponInput.length > 0) {
                                            offerData.couponCode = couponInput.attr('value');
                                            console.log(`Found coupon code for ${offerData.name}: ${offerData.couponCode}`);
                                        }
                                    } catch (error) {
                                        console.error(`Error fetching coupon code for ${offerData.name}:`, error.message);
                                    }
                                } else {
                                    console.log(`No coupon button found for offer: ${offerData.name}`);
                                }
                            } else {
                                console.log(`No matching article found for offer: ${offerData.name}`);
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
