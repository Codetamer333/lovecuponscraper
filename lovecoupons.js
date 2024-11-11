import { Actor } from 'apify';
import { CheerioCrawler, RequestList } from 'crawlee';

async function main() {
    await Actor.init();

    const alphabet = ['0-9','a'];
    
    // Create initial requests
    const startUrls = alphabet.map(letter => ({
        url: `https://www.lovecoupons.ro/brands/${letter === '0-9' ? '' : letter}`,
        userData: { label: 'BRAND_LIST' }
    }));

    const crawler = new CheerioCrawler({
        requestList: await RequestList.open(null, startUrls),
        maxConcurrency: 1,
        maxRequestsPerMinute: 20,
        requestHandlerTimeoutSecs: 30,

        requestHandler: async ({ $, request, enqueueLinks }) => {
            const { label } = request.userData;

            if (label === 'BRAND_LIST') {
                console.log(`Processing ${request.url}`);
                
                const selector = 'ul.grid.grid-cols-1.sm\\:grid-cols-2.lg\\:grid-cols-3.gap-3';
                //const selector = 'ul.grid.grid-cols-1 a';
                const links = $(selector).map((_, el) => $(el).attr('href')).get();
                
                if (links.length > 0) {
                    console.log(`Found ${links.length} brand links for URL: ${request.url}`);
                    
                    await enqueueLinks({
                        urls: links,
                        label: 'BRAND_DETAIL',
                        transformRequestFunction: (req) => {
                            req.userData.label = 'BRAND_DETAIL';
                            req.userData.delay = Math.floor(Math.random() * 1000) + 2000;
                            return req;
                        }
                    });
                }
            }

            if (label === 'BRAND_DETAIL') {
                console.log(`Scraping brand details from ${request.url}`);
                
                // Extract JSON-LD data
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

                // Process JSON-LD data
                for (const script of jsonLdScripts) {
                    if (script['@type'] === 'Organization') {
                        brandData.name = script.name;
                        brandData.logo = script.logo;
                    }
                    if (script['@type'] === 'ItemList') {
                        brandData.offers = script.itemListElement?.map(item => ({
                            name: item.item?.name,
                            description: item.item?.description,
                            validFrom: item.item?.validFrom,
                            url: item.item?.url
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
